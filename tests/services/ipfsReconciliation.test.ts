// Tests for scheduled reconciliation of pending_pins against Pinata & IPFS gateways

// Mock config BEFORE importing the ipfs module
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    pinata: {
      apiKey: 'test-key',
      secret: 'test-secret',
      gateway: 'https://gateway.pinata.cloud',
      gateways: ['https://gateway.pinata.cloud'],
    },
    logLevel: 'warn',
    nodeEnv: 'test',
    pinJsonCacheTtlMs: 300000,
    ipfsReconcileAgeMs: 300000, // 5 min
    ipfsReconcileIntervalMs: 60000,
    ipfsReconcileMaxAttempts: 5,
  },
}));

// Mock axios so we can control Pinata and gateway responses
jest.mock('axios');
import axios from 'axios';
const mockedPost = jest.fn();
const mockedGet = jest.fn();
const mockedHead = jest.fn();
(axios as jest.Mocked<typeof axios>).post = mockedPost;
(axios as jest.Mocked<typeof axios>).get = mockedGet;
(axios as jest.Mocked<typeof axios>).head = mockedHead;

// Mock DB helpers
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

import {
  getStalePendingPins,
  updatePendingPinReconciliation,
  countStuckPendingPins,
  incrementPendingPinAttempts,
} from '../../src/db';

// Mock logger
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
  },
}));

import {
  reconcilePendingPins,
  checkGatewayReachable,
  checkPinataPinStatus,
} from '../../src/services/ipfs';
import {
  getStuckPendingPinsCount,
  setStuckPendingPinsCount,
  serializeMetrics,
  resetMetrics,
} from '../../src/middleware/metrics';

describe('Scheduled pending_pins reconciliation service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
  });

  describe('checkGatewayReachable', () => {
    it('returns true on gateway 200 HEAD response', async () => {
      mockedHead.mockResolvedValueOnce({ status: 200 });
      const reachable = await checkGatewayReachable('QmTestCid');
      expect(reachable).toBe(true);
      expect(mockedHead).toHaveBeenCalledWith(
        'https://gateway.pinata.cloud/ipfs/QmTestCid',
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('returns false on gateway 404 or network error', async () => {
      mockedHead.mockRejectedValueOnce(new Error('Gateway timeout'));
      const reachable = await checkGatewayReachable('QmMissingCid');
      expect(reachable).toBe(false);
    });
  });

  describe('checkPinataPinStatus', () => {
    it('returns isPinned: true when CID found in pinList', async () => {
      mockedGet.mockResolvedValueOnce({
        data: {
          count: 1,
          rows: [
            {
              ipfs_pin_hash: 'QmFoundCid',
              size: 100,
              date_pinned: '2026-08-29T00:00:00Z',
            },
          ],
        },
      });

      const status = await checkPinataPinStatus('QmFoundCid');
      expect(status.isPinned).toBe(true);
      expect(status.pinnedCid).toBe('QmFoundCid');
    });

    it('returns isPinned: false when pinList returns empty rows', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { count: 0, rows: [] },
      });

      const status = await checkPinataPinStatus('QmNotPinned');
      expect(status.isPinned).toBe(false);
    });
  });

  describe('reconcilePendingPins background worker', () => {
    it('processes stale pending_pins rows older than configurable age threshold', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString(); // 400s > 300s threshold

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 10,
          payload: JSON.stringify({ wallet: 'G10', name: 'Alice' }),
          attempts: 1,
          created_at: staleTime,
          last_tried: staleTime,
          resolved_cid: 'QmExistingPinnedCid',
        },
      ]);

      // Pinata pinList confirms candidate CID is pinned
      mockedGet.mockResolvedValueOnce({
        data: {
          count: 1,
          rows: [{ ipfs_pin_hash: 'QmExistingPinnedCid', size: 50 }],
        },
      });

      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(0);

      const res = await reconcilePendingPins();

      expect(res.processed).toBe(1);
      expect(res.resolved).toBe(1);
      expect(updatePendingPinReconciliation).toHaveBeenCalledWith({
        id: 10,
        status: 'resolved',
        resolvedCid: 'QmExistingPinnedCid',
      });
      expect(getStuckPendingPinsCount()).toBe(0);
    });

    it('resolves row when candidate CID is reachable via gateway HEAD', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString();

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 11,
          payload: JSON.stringify({ wallet: 'G11', name: 'Bob' }),
          attempts: 2,
          created_at: staleTime,
          resolved_cid: 'QmGatewayReachableCid',
        },
      ]);

      // pinList returns empty, but gateway HEAD returns 200
      mockedGet.mockResolvedValueOnce({ data: { count: 0, rows: [] } });
      mockedHead.mockResolvedValueOnce({ status: 200 });
      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(0);

      const res = await reconcilePendingPins();

      expect(res.resolved).toBe(1);
      expect(updatePendingPinReconciliation).toHaveBeenCalledWith({
        id: 11,
        status: 'resolved',
        resolvedCid: 'QmGatewayReachableCid',
      });
    });

    it('re-pins and marks resolved when unpinned row is retryable', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString();

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 12,
          payload: JSON.stringify({ wallet: 'G12', name: 'Charlie' }),
          attempts: 2,
          created_at: staleTime,
        },
      ]);

      mockedPost.mockResolvedValueOnce({ data: { IpfsHash: 'QmRePinnedNewCid' } });
      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(0);

      const res = await reconcilePendingPins();

      expect(res.resolved).toBe(1);
      expect(mockedPost).toHaveBeenCalledWith(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        { wallet: 'G12', name: 'Charlie' },
        expect.any(Object),
      );
      expect(updatePendingPinReconciliation).toHaveBeenCalledWith({
        id: 12,
        status: 'resolved',
        resolvedCid: 'QmRePinnedNewCid',
      });
    });

    it('re-queues row and increments attempts when re-pin attempt fails', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString();

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 13,
          payload: JSON.stringify({ wallet: 'G13' }),
          attempts: 2,
          created_at: staleTime,
        },
      ]);

      mockedPost.mockRejectedValueOnce(new Error('Network error on pin'));
      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(1);

      const res = await reconcilePendingPins();

      expect(res.requeued).toBe(1);
      expect(incrementPendingPinAttempts).toHaveBeenCalledWith(13);
      expect(updatePendingPinReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 13,
          status: 'pending',
          lastReconciledAt: expect.any(String),
        }),
      );
      expect(getStuckPendingPinsCount()).toBe(1);
    });

    it('expires row with reason when attempts >= maxAttempts', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString();

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 14,
          payload: JSON.stringify({ wallet: 'G14' }),
          attempts: 5, // maxAttempts reached
          created_at: staleTime,
        },
      ]);

      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(0);

      const res = await reconcilePendingPins();

      expect(res.expired).toBe(1);
      expect(mockedPost).not.toHaveBeenCalled();
      expect(updatePendingPinReconciliation).toHaveBeenCalledWith({
        id: 14,
        status: 'expired',
        expiredReason: expect.stringContaining('max_attempts_exceeded'),
      });
    });

    it('expires row immediately when payload is invalid JSON', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString();

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 15,
          payload: '{ corrupt_json ',
          attempts: 1,
          created_at: staleTime,
        },
      ]);

      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(0);

      const res = await reconcilePendingPins();

      expect(res.expired).toBe(1);
      expect(updatePendingPinReconciliation).toHaveBeenCalledWith({
        id: 15,
        status: 'expired',
        expiredReason: 'invalid_json_payload',
      });
    });

    it('updates stuck_pending_pins_count metric in Prometheus output', async () => {
      const now = Date.now();
      const staleTime = new Date(now - 400000).toISOString();

      (getStalePendingPins as jest.Mock).mockResolvedValueOnce([
        {
          id: 16,
          payload: JSON.stringify({ wallet: 'G16' }),
          attempts: 1,
          created_at: staleTime,
        },
      ]);

      mockedPost.mockRejectedValueOnce(new Error('Fail'));
      (countStuckPendingPins as jest.Mock).mockResolvedValueOnce(3);

      await reconcilePendingPins();

      expect(getStuckPendingPinsCount()).toBe(3);
      const metricsOut = serializeMetrics();
      expect(metricsOut).toContain('# HELP stuck_pending_pins_count');
      expect(metricsOut).toContain('# TYPE stuck_pending_pins_count gauge');
      expect(metricsOut).toContain('stuck_pending_pins_count 3');
    });
  });
});
