import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import config from '../../src/config';
import { getDriver, insertAuditLog, recordProfileView } from '../../src/db';
import { runRetention } from '../../src/services/retention';
import { parseRetentionPolicies } from '../../src/retentionPolicy';
import { verifyAuditChain } from '../../src/utils/auditVerify';
import { serializeMetrics } from '../../src/middleware/metrics';
import { GENESIS_HASH } from '../../src/utils/hashChain';

const now = Date.parse('2026-10-22T00:00:00Z');
const original = { ...config.retention };
const adminToken = () => jwt.sign({ sub: 'retention-admin', role: 'admin' }, config.jwtSecret, { expiresIn: '1h' });

describe('data retention (#1506)', () => {
  let archiveDir: string;
  beforeEach(async () => {
    archiveDir = await mkdtemp(path.join(os.tmpdir(), 'scout-retention-'));
    Object.assign(config.retention, { ...original, batchSize: 2, pauseMs: 1, maxBatches: 1,
      archiveDir, exportDir: archiveDir, checkpointKey: 'ab'.repeat(32) });
    for (const table of ['audit_checkpoints', 'audit_log', 'profile_views', 'profile_view_daily', 'security_event_log', 'export_download_tokens', 'data_export_jobs']) {
      await getDriver().run(`DELETE FROM ${table}`);
    }
  });
  afterEach(async () => {
    await getDriver().run('DELETE FROM audit_checkpoints');
    Object.assign(config.retention, original);
    await rm(archiveDir, { recursive: true, force: true });
  });

  it('validates identifiers, strategies, duplicates and retention periods', () => {
    for (const policies of [
      [{ table: 'players', column: 'created_at', days: 1, strategy: 'delete' }],
      [{ table: 'audit_log', column: 'created_at', days: 365, strategy: 'delete' }],
      [{ table: 'profile_views', column: 'viewed_at', days: -1, strategy: 'aggregate-then-delete' }],
      [{ table: 'events', column: 'created_at); DROP TABLE players', days: 1, strategy: 'delete' }],
    ]) expect(() => parseRetentionPolicies(JSON.stringify(policies))).toThrow();
    const p = { table: 'events', column: 'created_at', days: 1, strategy: 'delete' };
    expect(() => parseRetentionPolicies(JSON.stringify([p, p]))).toThrow(/Duplicate/);
  });

  it('respects the batch and sweep budgets; a dry run performs no deletion', async () => {
    config.retention.policies = [{ table: 'security_event_log', column: 'created_at', days: 90, strategy: 'delete' }];
    for (let i = 0; i < 5; i++) await getDriver().run(
      'INSERT INTO security_event_log (event_type, subject, origin_instance_id, created_at) VALUES (?, ?, ?, ?)',
      ['wallet_blocked', String(i), 'test', 1]);
    expect(await runRetention(true, now)).toEqual([{ table: 'security_event_log', eligible: 5, deleted: 0, batches: 0 }]);
    const result = await runRetention(false, now);
    expect(result[0]).toMatchObject({ deleted: 2, batches: 1 });
    const remaining = await getDriver().get<{ n: number }>('SELECT COUNT(*) AS n FROM security_event_log');
    expect(Number(remaining?.n)).toBe(3);
    expect(serializeMetrics()).toContain('scout_off_retention_rows_deleted_total{table="security_event_log"}');
    expect(serializeMetrics()).toContain('scout_off_retention_last_run_timestamp_seconds{table="security_event_log"}');
  });

  it('preserves endpoint view totals and exact unique viewers across daily rollups', async () => {
    const playerId = 'retention-player';
    await getDriver().run('DELETE FROM players WHERE player_id = ?', [playerId]);
    await getDriver().run('INSERT INTO players (player_id, wallet, created_at) VALUES (?, ?, ?)', [playerId, 'GVIEWOWNER', 1]);
    config.retention.policies = [{ table: 'profile_views', column: 'viewed_at', days: 180, strategy: 'aggregate-then-delete' }];
    for (const [wallet, time] of [['GVIEWER1', 1], ['GVIEWER1', 86400001], ['GVIEWER2', now]] as const) {
      await recordProfileView({ player_id: playerId, scout_wallet: wallet, viewed_at: time, created_at: time });
    }
    const token = jwt.sign({ sub: playerId, role: 'player' }, config.jwtSecret, { expiresIn: '1h' });
    const before = await request(app).get(`/api/players/${playerId}/analytics`).set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ view_count: 3, viewer_count: 2 });
    await runRetention(false, now);
    const after = await request(app).get(`/api/players/${playerId}/analytics`).set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({ view_count: 3, viewer_count: 2 });
    await runRetention(false, now); // retry cannot double-count previously rolled rows
    const again = await request(app).get(`/api/players/${playerId}/analytics`).set('Authorization', `Bearer ${token}`);
    expect(again.body.data).toMatchObject({ view_count: 3, viewer_count: 2 });
  });

  it('archives a verified prefix and keeps verify and append correct after the live chain empties', async () => {
    config.retention.policies = [{ table: 'audit_log', column: 'created_at', days: 365, strategy: 'archive-with-checkpoint' }];
    await insertAuditLog({ action: 'first', createdAt: '2020-01-01T00:00:00.000Z' });
    const last = await insertAuditLog({ action: 'second', createdAt: '2020-01-02T00:00:00.000Z' });
    await getDriver().run('INSERT INTO audit_log_pii (audit_log_id, pii_json) VALUES (?, ?)', [last.id, '{"wallet":"sensitive"}']);
    expect((await runRetention(false, now))[0].deleted).toBe(2);
    expect(await getDriver().get('SELECT * FROM audit_log_pii WHERE audit_log_id = ?', [last.id])).toBeUndefined();
    const checkpoint = await getDriver().get<{ archive_file: string; signature: string }>('SELECT * FROM audit_checkpoints');
    expect(checkpoint?.signature).toMatch(/^[a-f0-9]{64}$/);
    const archive = JSON.parse(await readFile(path.join(archiveDir, checkpoint!.archive_file), 'utf8'));
    expect(archive.rows).toHaveLength(2);
    expect(archive.previous_hash).toBe(GENESIS_HASH);
    expect((await verifyAuditChain()).valid).toBe(true);
    const next = await insertAuditLog({ action: 'new', createdAt: new Date(now).toISOString() });
    expect(next.prev_hash).toBe(last.hash);
    const verification = await request(app).get('/api/admin/audit/verify').set('Authorization', `Bearer ${adminToken()}`);
    expect(verification.status).toBe(200);
    expect(verification.body.data.status).toBe('ok');
    await writeFile(path.join(archiveDir, checkpoint!.archive_file), 'tampered');
    expect((await verifyAuditChain()).valid).toBe(false);
  });

  it('never prunes on failed archiving, invalid hashes or a non-expired prefix', async () => {
    config.retention.policies = [{ table: 'audit_log', column: 'created_at', days: 365, strategy: 'archive-with-checkpoint' }];
    const first = await insertAuditLog({ action: 'old', createdAt: '2020-01-01T00:00:00.000Z' });
    const blocked = path.join(archiveDir, 'ordinary-file');
    await writeFile(blocked, 'not a directory');
    config.retention.archiveDir = blocked;
    await expect(runRetention(false, now)).rejects.toThrow();
    expect((await verifyAuditChain()).valid).toBe(true);
    config.retention.archiveDir = archiveDir;
    await getDriver().run('UPDATE audit_log SET action = ? WHERE id = ?', ['tampered', first.id]);
    await expect(runRetention(false, now)).rejects.toThrow(/invalid audit row/);
    await getDriver().run('DELETE FROM audit_log');
    await insertAuditLog({ action: 'recent', createdAt: new Date(now).toISOString() });
    await insertAuditLog({ action: 'backdated', createdAt: '2020-01-01T00:00:00.000Z' });
    expect((await runRetention(false, now))[0].deleted).toBe(0);
  });

  it('deletes expired export files before removing their jobs and tokens', async () => {
    config.retention.policies = [{ table: 'data_export_jobs', column: 'expires_at', days: 0, strategy: 'delete' }];
    const filename = path.join(archiveDir, 'export.json');
    await writeFile(filename, '{}');
    await getDriver().run(`INSERT INTO data_export_jobs
      (request_type, requester_id, status, archive_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ['player', 'retention-player', 'completed', filename, 1, 2]);
    expect((await runRetention(false, now))[0].deleted).toBe(1);
    await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses bounded idempotency expiry without deleting live responses', async () => {
    config.retention.policies = [{ table: 'idempotency_keys', column: 'expires_at', days: 0, strategy: 'delete' }];
    await getDriver().run('DELETE FROM idempotency_keys');
    for (const [key, expires] of [['old-1', 1], ['old-2', 1], ['old-3', 1], ['live', now + 1000]] as const) {
      await getDriver().run(`INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`, [key, 200, '{}', 0, expires]);
    }
    expect((await runRetention(false, now))[0].deleted).toBe(2);
    expect(await getDriver().get('SELECT key FROM idempotency_keys WHERE key = ?', ['live'])).toBeDefined();
  });

  it('protects signed checkpoints against database tampering', async () => {
    config.retention.policies = [{ table: 'audit_log', column: 'created_at', days: 365, strategy: 'archive-with-checkpoint' }];
    await insertAuditLog({ action: 'old', createdAt: '2020-01-01T00:00:00.000Z' });
    await runRetention(false, now);
    await getDriver().run('UPDATE audit_checkpoints SET last_hash = ?', ['0'.repeat(64)]);
    expect((await verifyAuditChain()).valid).toBe(false);
    await expect(insertAuditLog({ action: 'after', createdAt: new Date(now).toISOString() })).rejects.toThrow(/signature/);
  });
});
