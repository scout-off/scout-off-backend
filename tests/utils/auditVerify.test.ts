import { getDriver, insertAuditLog } from '../../src/db';
import { recordAudit } from '../../src/utils/audit';
import { verifyAuditChain } from '../../src/utils/auditVerify';

describe('verifyAuditChain (#464)', () => {
  beforeEach(async () => {
    await getDriver().run('DELETE FROM audit_log');
  });

  it('reports a valid, empty chain when the table is empty', async () => {
    const result = await verifyAuditChain();
    expect(result).toEqual({ valid: true, brokenAtId: null, rowsChecked: 0 });
  });

  it('validates a chain spanning several inserts across both event sources', async () => {
    await insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN', queryParams: { x: 1 }, createdAt: '2025-01-01T00:00:00.000Z' });
    await recordAudit('GVALIDATOR', 'milestone_submitted', { playerId: 'P1' });
    await insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    await recordAudit('GSCOUT', 'player_search', { region: 'europe' });

    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.brokenAtId).toBeNull();
    expect(result.rowsChecked).toBe(4);
  });

  it('detects a mutated row (content tampered with directly via SQL)', async () => {
    await insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const r2 = await insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    await insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN2', queryParams: {}, createdAt: '2025-01-03T00:00:00.000Z' });

    expect((await verifyAuditChain()).valid).toBe(true);

    // Tamper with row 2's content directly, bypassing insertAuditLog entirely.
    // Note: AUTOINCREMENT ids don't reset after DELETE, so use the id the
    // insert actually returned rather than assuming 1/2/3 across tests.
    await getDriver().run('UPDATE audit_log SET admin_wallet = ? WHERE id = ?', ['GATTACKER', r2.id]);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(r2.id);
    expect(result.reason).toMatch(/tampered/);
  });

  it('detects a deleted row (chain gap)', async () => {
    await insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const r2 = await insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    const r3 = await insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN2', queryParams: {}, createdAt: '2025-01-03T00:00:00.000Z' });

    expect((await verifyAuditChain()).valid).toBe(true);

    // Delete row 2 directly — every row after it now has a stale prev_hash.
    await getDriver().run('DELETE FROM audit_log WHERE id = ?', [r2.id]);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(r3.id);
    expect(result.reason).toMatch(/prev_hash/);
  });

  it('detects a tampered prev_hash column in isolation', async () => {
    await insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const r2 = await insertAuditLog({ action: 'b', adminWallet: 'G2', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    await getDriver().run('UPDATE audit_log SET prev_hash = ? WHERE id = ?', ['f'.repeat(64), r2.id]);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(r2.id);
  });
});
