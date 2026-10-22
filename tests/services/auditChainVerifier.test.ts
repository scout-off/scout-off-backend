import config from '../../src/config';
import { getDriver, insertAuditLog } from '../../src/db';
import {
  getAuditChainBreaksTotal,
  getAuditChainValid,
  resetAuditChainMetrics,
} from '../../src/middleware/metrics';
import {
  getAuditVerifyCheckpoint,
  KEY_LAST_FULL_RUN,
  KEY_LAST_HASH,
  KEY_LAST_ID,
  KEY_LAST_RUN,
  runAuditChainVerification,
} from '../../src/services/auditChainVerifier';
import { GENESIS_HASH } from '../../src/utils/hashChain';

const STATE_KEYS = [KEY_LAST_ID, KEY_LAST_HASH, KEY_LAST_RUN, KEY_LAST_FULL_RUN];

/** Inserts `count` chained rows and returns their ids in chain order. */
async function seed(count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = await insertAuditLog({
      action: `event-${i}`,
      adminWallet: 'GADMIN',
      queryParams: { i },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
    ids.push(row.id);
  }
  return ids;
}

async function resetState(): Promise<void> {
  await getDriver().run('DELETE FROM audit_log');
  await getDriver().run(
    `DELETE FROM indexer_state WHERE key IN (${STATE_KEYS.map(() => '?').join(',')})`,
    STATE_KEYS,
  );
}

describe('scheduled audit chain verification (#1539)', () => {
  const originalWebhook = config.auditVerify.alertWebhookUrl;

  beforeEach(async () => {
    await resetState();
    resetAuditChainMetrics();
  });

  afterAll(() => {
    config.auditVerify.alertWebhookUrl = originalWebhook;
  });

  it('verifies the whole chain in bounded batches and persists a checkpoint', async () => {
    const ids = await seed(5);

    const result = await runAuditChainVerification({
      mode: 'full',
      batchSize: 2,
    });

    expect(result.status).toBe('ok');
    expect(result.mode).toBe('full');
    expect(result.rowsChecked).toBe(5);
    expect(result.batches).toBe(3);
    expect(getAuditChainValid()).toBe(1);

    const rows = await getDriver().all<{ id: number; hash: string }>(
      'SELECT id, hash FROM audit_log ORDER BY id ASC',
    );
    const checkpoint = await getAuditVerifyCheckpoint();
    expect(checkpoint.lastId).toBe(ids[4]);
    expect(checkpoint.lastHash).toBe(rows[rows.length - 1].hash);
    expect(checkpoint.lastRun).not.toBeNull();
    expect(checkpoint.lastFullRun).not.toBeNull();
  });

  it('verifies only entries past the checkpoint on an incremental run', async () => {
    await seed(5);
    await runAuditChainVerification({ mode: 'full', batchSize: 2 });

    const newIds = await seed(2);
    const result = await runAuditChainVerification({
      mode: 'incremental',
      batchSize: 2,
    });

    expect(result.status).toBe('ok');
    expect(result.rowsChecked).toBe(2);
    expect(result.lastVerifiedId).toBe(newIds[1]);
  });

  it('reports the exact row when a previously verified row is tampered with (full run)', async () => {
    const ids = await seed(3);
    await runAuditChainVerification({ mode: 'full', batchSize: 2 });

    await getDriver().run('UPDATE audit_log SET action = ? WHERE id = ?', [
      'tampered-action',
      ids[1],
    ]);

    const result = await runAuditChainVerification({ mode: 'full', batchSize: 2 });

    expect(result.status).toBe('broken');
    expect(result.brokenAt?.id).toBe(ids[1]);
    expect(result.brokenAt?.reason).toBe('hash_mismatch');
    expect(result.brokenAt?.expectedHash).not.toBe(result.brokenAt?.actualHash);
    expect(getAuditChainValid()).toBe(0);
    expect(getAuditChainBreaksTotal()).toBe(1);

    // The checkpoint must not move past the broken row.
    const checkpoint = await getAuditVerifyCheckpoint();
    expect(checkpoint.lastId).toBe(ids[2]);
  });

  it('detects tampering of a row inserted after the checkpoint (incremental run)', async () => {
    await seed(3);
    await runAuditChainVerification({ mode: 'full', batchSize: 2 });

    const newIds = await seed(2);
    await getDriver().run('UPDATE audit_log SET query_params = ? WHERE id = ?', [
      '{"i":999}',
      newIds[0],
    ]);

    const result = await runAuditChainVerification({
      mode: 'incremental',
      batchSize: 2,
    });

    expect(result.status).toBe('broken');
    expect(result.brokenAt?.id).toBe(newIds[0]);
    expect(getAuditChainValid()).toBe(0);
  });

  it('detects a tampered prev_hash link', async () => {
    const ids = await seed(3);
    await getDriver().run('UPDATE audit_log SET prev_hash = ? WHERE id = ?', [
      GENESIS_HASH,
      ids[2],
    ]);

    const result = await runAuditChainVerification({ mode: 'full', batchSize: 2 });

    expect(result.status).toBe('broken');
    expect(result.brokenAt?.reason).toBe('prev_hash_mismatch');
    expect(result.brokenAt?.id).toBe(ids[2]);
  });

  it('stops between batches when shutdown begins and keeps incremental progress', async () => {
    await seed(3);
    await runAuditChainVerification({ mode: 'full', batchSize: 2 });
    const newIds = await seed(3);

    let checks = 0;
    const result = await runAuditChainVerification({
      mode: 'incremental',
      batchSize: 1,
      shouldStop: () => {
        checks += 1;
        return checks > 1;
      },
    });

    expect(result.status).toBe('stopped');
    expect(result.rowsChecked).toBe(1);

    const checkpoint = await getAuditVerifyCheckpoint();
    expect(checkpoint.lastId).toBe(newIds[0]);
  });

  it('caps incremental work per run and resumes from the checkpoint next time', async () => {
    const ids = await seed(5);

    const first = await runAuditChainVerification({
      mode: 'incremental',
      batchSize: 2,
      maxBatches: 1,
    });

    expect(first.status).toBe('ok');
    expect(first.rowsChecked).toBe(2);
    expect((await getAuditVerifyCheckpoint()).lastId).toBe(ids[1]);

    const second = await runAuditChainVerification({
      mode: 'incremental',
      batchSize: 2,
    });
    expect(second.rowsChecked).toBe(3);
    expect(second.lastVerifiedId).toBe(ids[4]);
  });

  it('does not let an unsafe alert webhook URL break the job', async () => {
    config.auditVerify.alertWebhookUrl = 'https://127.0.0.1/internal-hook';
    const ids = await seed(2);
    await getDriver().run('UPDATE audit_log SET action = ? WHERE id = ?', [
      'tampered',
      ids[0],
    ]);

    const result = await runAuditChainVerification({ mode: 'full', batchSize: 2 });

    expect(result.status).toBe('broken');
    expect(result.brokenAt?.id).toBe(ids[0]);
  });
});
