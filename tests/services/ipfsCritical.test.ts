// Mock config BEFORE importing the ipfs module so isPinataConfigured() returns true
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    pinata: { apiKey: 'test-key', secret: 'test-secret', gateway: 'https://gateway.pinata.cloud' },
    logLevel: 'warn',
    nodeEnv: 'test',
    pinJsonCacheTtlMs: 300000,
  },
}));

// Mock axios so we can control Pinata responses
jest.mock('axios');
import axios from 'axios';
const mockedPost = jest.fn();
(axios as jest.Mocked<typeof axios>).post = mockedPost;

// Mock DB helpers so we can inspect insertPendingPin calls
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

import { insertPendingPin, deletePendingPinByHash, getPendingPins, deletePendingPin, incrementPendingPinAttempts } from '../../src/db';

// Mock logger to capture critical calls
const mockCritical = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: mockCritical,
  },
}));

import { pinJson } from '../../src/services/ipfs';

describe('pinJson IPFS failure handling (#346)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('logs CRITICAL when Pinata throws', async () => {
    mockedPost.mockRejectedValue(new Error('Pinata 503'));
    await expect(pinJson({ wallet: 'Gtest' })).rejects.toThrow('Pinata 503');
    expect(mockCritical).toHaveBeenCalledWith(
      expect.stringContaining('[ipfs] Pinata unavailable'),
      expect.any(String)
    );
  });

  it('queues payload to pending_pins when Pinata throws', async () => {
    mockedPost.mockRejectedValue(new Error('connection refused'));
    const body = { wallet: 'Gqueue', position: 'striker' };
    await expect(pinJson(body)).rejects.toThrow();
    expect(insertPendingPin).toHaveBeenCalledWith(
      expect.objectContaining({ payload: JSON.stringify(body) })
    );
  });

  it('does not call critical or queue retry on successful pin', async () => {
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'QmSuccess' } });
    const cid = await pinJson({ wallet: 'Gok' });
    expect(cid).toBe('QmSuccess');
    expect(mockCritical).not.toHaveBeenCalled();
    expect(deletePendingPinByHash).toHaveBeenCalled();
  });
});

describe('pinJson dedup caching', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns cached CID and does not call Pinata twice for identical metadata within TTL', async () => {
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'QmDedup' } });
    const body = { wallet: 'Gdedup', position: 'goalkeeper' };
    const cid1 = await pinJson(body);
    const cid2 = await pinJson(body);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(cid1).toBe('QmDedup');
    expect(cid2).toBe('QmDedup');
  });

  it('calls Pinata again for different metadata', async () => {
    mockedPost
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmFirst' } })
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmSecond' } });
    const cid1 = await pinJson({ wallet: 'Ga', position: 'forward' });
    const cid2 = await pinJson({ wallet: 'Gb', position: 'defender' });
    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(cid1).toBe('QmFirst');
    expect(cid2).toBe('QmSecond');
  });

  it('calls Pinata again after the TTL window expires', async () => {
    jest.useFakeTimers();
    mockedPost
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmBefore' } })
      .mockResolvedValueOnce({ data: { IpfsHash: 'QmAfter' } });
    const body = { wallet: 'Gttl', position: 'midfielder' };
    const cid1 = await pinJson(body);
    jest.advanceTimersByTime(300001);
    const cid2 = await pinJson(body);
    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(cid1).toBe('QmBefore');
    expect(cid2).toBe('QmAfter');
    jest.useRealTimers();
  });
});

import { retryPendingPins } from '../../src/services/ipfs';

describe('retryPendingPins background worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries successfully and removes row', async () => {
    const fakeNow = Date.now();
    (getPendingPins as jest.Mock).mockReturnValue([
      { id: 1, payload: JSON.stringify({ wallet: 'G1' }), attempts: 0, last_tried: new Date(fakeNow - 100000).toISOString() },
    ]);
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'QmRetried' } });

    await retryPendingPins();

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(deletePendingPin).toHaveBeenCalledWith(1);
    expect(incrementPendingPinAttempts).not.toHaveBeenCalled();
  });

  it('applies exponential backoff for failed pins', async () => {
    const fakeNow = Date.now();
    (getPendingPins as jest.Mock).mockReturnValue([
      // attempt 1, backed off 2 * 60s = 120s. last tried 60s ago -> skip
      { id: 1, payload: JSON.stringify({ wallet: 'G1' }), attempts: 1, last_tried: new Date(fakeNow - 60000).toISOString() },
      // attempt 1, backed off 120s. last tried 130s ago -> retry
      { id: 2, payload: JSON.stringify({ wallet: 'G2' }), attempts: 1, last_tried: new Date(fakeNow - 130000).toISOString() },
    ]);
    mockedPost.mockRejectedValue(new Error('Still down'));

    await retryPendingPins();

    expect(mockedPost).toHaveBeenCalledTimes(1); // only id 2
    expect(incrementPendingPinAttempts).toHaveBeenCalledWith(2);
  });

  it('skips rows that have permanently failed (attempts >= 5)', async () => {
    const fakeNow = Date.now();
    (getPendingPins as jest.Mock).mockReturnValue([
      { id: 1, payload: JSON.stringify({ wallet: 'G1' }), attempts: 5, last_tried: new Date(fakeNow - 9999999).toISOString() },
    ]);
    
    await retryPendingPins();

    expect(mockedPost).not.toHaveBeenCalled();
    expect(deletePendingPin).not.toHaveBeenCalled();
    expect(incrementPendingPinAttempts).not.toHaveBeenCalled();
  });
});
