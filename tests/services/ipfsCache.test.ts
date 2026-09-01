// Mock config BEFORE importing the ipfs module so isPinataConfigured() returns true
// and pinJsonCacheTtlMs is controlled by the test suite.
// Pattern mirrors ipfsCritical.test.ts.
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    pinata: { apiKey: 'test-key', secret: 'test-secret', gateway: 'https://gateway.pinata.cloud' },
    logLevel: 'warn',
    nodeEnv: 'test',
    pinJsonCacheTtlMs: 300_000, // 5 min default; overridden per-test where needed
  },
}));

// Control axios so Pinata responses are fully deterministic
jest.mock('axios');
import axios from 'axios';
const mockedPost = jest.fn();
(axios as jest.Mocked<typeof axios>).post = mockedPost;

// Stub DB helpers — not under test here
jest.mock('../../src/db', () => ({
  insertPendingPin: jest.fn(),
  getPendingPins: jest.fn().mockReturnValue([]),
  deletePendingPin: jest.fn(),
  deletePendingPinByHash: jest.fn(),
  isPendingPinByHash: jest.fn().mockReturnValue(false),
  incrementPendingPinAttempts: jest.fn(),
  setPendingPinResolvedCid: jest.fn(),
  getResolvedCidByHash: jest.fn().mockReturnValue(null),
  getStalePendingPins: jest.fn().mockReturnValue([]),
  updatePendingPinReconciliation: jest.fn().mockReturnValue(true),
  countStuckPendingPins: jest.fn().mockReturnValue(0),
}));

// Suppress logger noise
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
  },
}));

import { pinJson, clearPinJsonCache } from '../../src/services/ipfs';
import config from '../../src/config';

describe('pinJson deduplication cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPinJsonCache(); // reset module-level Map between every test
  });

  // -------------------------------------------------------------------------
  // AC-1: identical metadata within TTL ? Pinata called exactly once
  // -------------------------------------------------------------------------
  it('returns cached CID and calls Pinata only once for identical metadata within TTL', async () => {
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'QmCachedCid' } });

    const metadata = { playerId: 'P001', position: 'midfielder', age: 24 };

    const cid1 = await pinJson(metadata);
    const cid2 = await pinJson(metadata);

    expect(cid1).toBe('QmCachedCid');
    expect(cid2).toBe('QmCachedCid');
    // Pinata must have been called only once despite two invocations
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // AC-1 (key-order variant): same metadata with different insertion order
  //   must hit the same cache entry (canonical serialization check)
  // -------------------------------------------------------------------------
  it('treats metadata with different key order as the same entry (canonical hash)', async () => {
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'QmCanonicalCid' } });

    const metaA = { age: 24, playerId: 'P001', position: 'midfielder' };
    const metaB = { position: 'midfielder', playerId: 'P001', age: 24 }; // same data, different key order

    const cid1 = await pinJson(metaA);
    const cid2 = await pinJson(metaB);

    expect(cid1).toBe('QmCanonicalCid');
    expect(cid2).toBe('QmCanonicalCid');
    expect(mockedPost).toHaveBeenCalledTimes(1); // cache hit on second call
  });

  // -------------------------------------------------------------------------
  // AC-2: different metadata ? Pinata called twice, different CIDs returned
  // -------------------------------------------------------------------------
  it('calls Pinata separately for different metadata payloads', async () => {
    mockedPost
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmCidAlpha' } })
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmCidBeta' } });

    const cid1 = await pinJson({ playerId: 'P001', position: 'goalkeeper' });
    const cid2 = await pinJson({ playerId: 'P002', position: 'striker' });

    expect(cid1).toBe('QmCidAlpha');
    expect(cid2).toBe('QmCidBeta');
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // AC-3: identical metadata after TTL expires ? Pinata called a second time
  // -------------------------------------------------------------------------
  it('calls Pinata again after the TTL for an identical payload has expired', async () => {
    mockedPost
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmFirstPin' } })
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmSecondPin' } });

    jest.useFakeTimers();

    const ttlMs = config.pinJsonCacheTtlMs;
    const metadata = { playerId: 'P003', position: 'defender' };

    const cid1 = await pinJson(metadata);
    expect(cid1).toBe('QmFirstPin');
    expect(mockedPost).toHaveBeenCalledTimes(1);

    // Advance past TTL so the cache entry is stale
    jest.advanceTimersByTime(ttlMs + 1);

    const cid2 = await pinJson(metadata);
    expect(cid2).toBe('QmSecondPin');
    // Pinata must be called a second time because the TTL expired
    expect(mockedPost).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
