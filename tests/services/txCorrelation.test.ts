/**
 * Correlation bridge tests (#1113).
 */

import { getDb } from '../../src/db';
import {
  toCorrelationMemoText,
  recordTxCorrelation,
  lookupTxCorrelation,
  withRestoredCorrelation,
  CORRELATION_MEMO_MAX_BYTES,
} from '../../src/services/txCorrelation';
import { getCorrelationId, requestContext } from '../../src/utils/requestContext';

describe('txCorrelation', () => {
  beforeEach(() => {
    // Ensure table exists for in-memory / migrated test DB.
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS tx_correlations (
        tx_hash TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    getDb().prepare('DELETE FROM tx_correlations').run();
  });

  it('truncates memo text to stellar limit without PII-like characters', () => {
    const memo = toCorrelationMemoText('abc/def@ghi-1234567890ABCDEF');
    expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(CORRELATION_MEMO_MAX_BYTES);
    expect(memo.startsWith('c:')).toBe(true);
    expect(memo).not.toMatch(/[@/]/);
  });

  it('records and looks up correlation by tx hash', () => {
    requestContext.run({ correlationId: 'corr-origin-1' }, () => {
      recordTxCorrelation('txhash-aaa');
    });
    expect(lookupTxCorrelation('txhash-aaa')).toBe('corr-origin-1');
    expect(lookupTxCorrelation('missing')).toBeUndefined();
  });

  it('re-establishes ALS context for downstream work', async () => {
    recordTxCorrelation('txhash-bbb', 'corr-restored');
    let seen: string | undefined;
    await withRestoredCorrelation('txhash-bbb', 'test.span', async () => {
      seen = getCorrelationId();
    });
    expect(seen).toBe('corr-restored');
  });

  it('degrades gracefully when correlation is absent', async () => {
    let seen: string | undefined = 'sentinel';
    await withRestoredCorrelation('never-recorded', 'test.span', async (cid) => {
      seen = cid;
      expect(getCorrelationId()).toBeUndefined();
    });
    expect(seen).toBeUndefined();
  });
});
