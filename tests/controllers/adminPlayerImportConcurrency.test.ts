// Import processing tests use mocked Pinata/DB only; no external services.
jest.mock('../../src/config', () => ({
  __esModule: true, default: { playerImport: { maxBatchSize: 500, concurrency: 3 } },
}));
jest.mock('../../src/controllers/playerController', () => ({
  registerSchema: {
    safeParse: (value: { valid?: boolean; wallet?: string }) => value?.valid === false
      ? { success: false, error: { issues: [{ message: 'invalid player' }] } }
      : { success: true, data: { wallet: value.wallet, position: 'Forward', region: 'West', metadata: {} } },
  },
}));
jest.mock('../../src/db', () => ({
  getDriver: jest.fn(), insertOrUpdatePlayer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/ipfs', () => ({ pinJson: jest.fn() }));
jest.mock('../../src/services/webhooks', () => ({ dispatchEventWebhook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/cache', () => ({ invalidatePlayerCache: jest.fn() }));
jest.mock('../../src/services/audit', () => ({ logAuditEvent: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));

import { processPlayerImportBatch } from '../../src/controllers/adminPlayerImportController';
import { pinJson } from '../../src/services/ipfs';

describe('player import phase-one concurrency (#1794)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('limits IPFS work to three and preserves CSV row order', async () => {
    let active = 0;
    let peak = 0;
    (pinJson as jest.Mock).mockImplementation(async (payload: { wallet: string }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active--;
      return `cid-${payload.wallet}`;
    });
    const entries = Array.from({ length: 20 }, (_, i) => ({ wallet: `wallet-${i}` }));
    const result = await processPlayerImportBatch(entries, true);
    expect(result.map((row) => row.row)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(result.every((row) => row.status === 'success')).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(pinJson).toHaveBeenCalledTimes(20);
  });

  it('does not pin any rows when strict-mode validation finds an error', async () => {
    const entries = [{ wallet: 'valid-1' }, { wallet: 'bad', valid: false }, { wallet: 'valid-2' }];
    const result = await processPlayerImportBatch(entries, false);
    expect(result.map((r) => r.status)).toEqual(['error', 'error', 'error']);
    expect(result[1].error).toBe('invalid player');
    expect(pinJson).not.toHaveBeenCalled();
  });
});
