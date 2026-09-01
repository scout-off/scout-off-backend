import { recordAudit, queryAudit } from '../../src/utils/audit';
import { getDriver, insertAuditLog, getAuditLogsCount, getAllAuditLogRows } from '../../src/db';
import { GENESIS_HASH } from '../../src/utils/hashChain';
import { verifyAuditChain } from '../../src/utils/auditVerify';

// recordAudit/queryAudit now persist to the audit_log table instead of an
// in-memory array (#464), so isolate tests by clearing that table rather
// than resetting an array.
beforeEach(async () => {
  await getDriver().run('DELETE FROM audit_log');
});

describe('recordAudit', () => {
  it('stores a milestone_submitted entry with correct fields', async () => {
    const entry = await recordAudit('GVALIDATOR', 'milestone_submitted', { playerId: 'P1', milestoneType: 'identity' });
    expect(entry.actorWallet).toBe('GVALIDATOR');
    expect(entry.eventType).toBe('milestone_submitted');
    expect(typeof entry.payloadHash).toBe('string');
    expect(entry.payloadHash).toHaveLength(64);
    expect(typeof entry.timestamp).toBe('number');
    expect(entry.notes).toBeUndefined();
    expect(await queryAudit()).toHaveLength(1);
  });

  it('stores a milestone_approved entry with notes field', async () => {
    const entry = await recordAudit('GVALIDATOR', 'milestone_approved', { milestoneId: 'M42' }, 'approved via admin panel');
    expect(entry.eventType).toBe('milestone_approved');
    expect(entry.notes).toBe('approved via admin panel');
    expect(await queryAudit()).toHaveLength(1);
  });

  it('stores a player_search entry linked to a scout wallet', async () => {
    const entry = await recordAudit('GSCOUT123', 'player_search', { region: 'europe', position: 'striker', resultCount: 5 });
    expect(entry.eventType).toBe('player_search');
    expect(entry.actorWallet).toBe('GSCOUT123');
    expect(typeof entry.payloadHash).toBe('string');
    expect(await queryAudit()).toHaveLength(1);
  });

  it('stores a player_search entry with anonymous wallet when unauthenticated', async () => {
    const entry = await recordAudit('anonymous', 'player_search', { region: null, position: null, resultCount: 10 });
    expect(entry.actorWallet).toBe('anonymous');
    expect(entry.eventType).toBe('player_search');
  });

  it('produces deterministic hash for the same payload', async () => {
    const payload = { playerId: 'P1', milestoneType: 'performance' };
    const a = await recordAudit('G1', 'milestone_submitted', payload);
    const b = await recordAudit('G1', 'milestone_submitted', payload);
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('persists across a fresh read from the DB (survives "restart")', async () => {
    await recordAudit('GVALIDATOR', 'milestone_submitted', { playerId: 'P1' });
    // Simulate a fresh read path unrelated to the in-process call above —
    // queryAudit re-reads from the DB rather than an in-memory reference.
    const rows = await queryAudit({ eventType: 'milestone_submitted' });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorWallet).toBe('GVALIDATOR');
  });

  it('handles row with non-JSON query_params gracefully in queryAudit', async () => {
    await getDriver().run(
      `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, prev_hash, hash, event_source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['player_registered', 'GWALLET', 'invalid json', new Date().toISOString(), GENESIS_HASH, 'dummyhash', 'app_event'],
    );

    const results = await queryAudit();
    expect(results).toHaveLength(1);
    expect(results[0].payloadHash).toBe('');
    expect(results[0].actorWallet).toBe('GWALLET');
  });
});

describe('queryAudit', () => {
  beforeEach(async () => {
    await recordAudit('G1', 'milestone_submitted', { id: '1' });
    await recordAudit('G2', 'milestone_approved', { id: '2' });
    await recordAudit('G1', 'milestone_approved', { id: '3' });
  });

  it('returns all entries when no filter given', async () => {
    expect(await queryAudit()).toHaveLength(3);
  });

  it('filters by eventType', async () => {
    const results = await queryAudit({ eventType: 'milestone_approved' });
    expect(results).toHaveLength(2);
    results.forEach((e) => expect(e.eventType).toBe('milestone_approved'));
  });

  it('filters by actorWallet', async () => {
    const results = await queryAudit({ actorWallet: 'G1' });
    expect(results).toHaveLength(2);
    results.forEach((e) => expect(e.actorWallet).toBe('G1'));
  });

  it('filters by both eventType and actorWallet', async () => {
    const results = await queryAudit({ eventType: 'milestone_approved', actorWallet: 'G1' });
    expect(results).toHaveLength(1);
    expect(results[0].actorWallet).toBe('G1');
  });

  it('does not surface admin-action rows written via insertAuditLog directly', async () => {
    await insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN', queryParams: {}, createdAt: new Date().toISOString() });
    expect(await queryAudit()).toHaveLength(3);
  });
});

describe('hash computation and chain continuity', () => {
  it('uses GENESIS_HASH as the previous hash for the first audit entry', async () => {
    const row = await insertAuditLog({
      action: 'player_registered',
      adminWallet: 'GPLAYER1',
      queryParams: { name: 'Player One' },
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(row.prev_hash).toBe(GENESIS_HASH);
  });

  it('uses the hash of the first entry as previous hash for the second audit entry', async () => {
    const firstRow = await insertAuditLog({
      action: 'player_registered',
      adminWallet: 'GPLAYER1',
      queryParams: { name: 'Player One' },
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const secondRow = await insertAuditLog({
      action: 'profile_updated',
      adminWallet: 'GPLAYER1',
      queryParams: { name: 'Player One Updated' },
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    expect(secondRow.prev_hash).toBe(firstRow.hash);
  });

  it('increments the entry count in the DB when insertAuditLog is called', async () => {
    expect(await getAuditLogsCount({})).toBe(0);
    await insertAuditLog({
      action: 'player_registered',
      adminWallet: 'GPLAYER1',
      queryParams: {},
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(await getAuditLogsCount({})).toBe(1);
    await insertAuditLog({
      action: 'profile_updated',
      adminWallet: 'GPLAYER1',
      queryParams: {},
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    expect(await getAuditLogsCount({})).toBe(2);
  });

  it('ensures two entries inserted in sequence have a continuous hash chain with no gap', async () => {
    const row1 = await insertAuditLog({
      action: 'player_registered',
      adminWallet: 'GPLAYER1',
      queryParams: { step: 1 },
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const row2 = await insertAuditLog({
      action: 'milestone_submitted',
      adminWallet: 'GVALIDATOR',
      queryParams: { step: 2 },
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    expect(row2.prev_hash).toBe(row1.hash);
    const rows = await getAllAuditLogRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect((await verifyAuditChain()).valid).toBe(true);
  });

  it('produces a different hash when inserting an entry with the same event_type and actor_wallet but different metadata', async () => {
    const entry1 = await recordAudit('GPLAYER1', 'profile_updated', { bio: 'First bio' });
    const entry2 = await recordAudit('GPLAYER1', 'profile_updated', { bio: 'Second bio' });
    expect(entry1.payloadHash).not.toBe(entry2.payloadHash);

    const rows = await getAllAuditLogRows();
    expect(rows[0].hash).not.toBe(rows[1].hash);
  });
});
