/**
 * Verifies that the compression middleware sends gzip-encoded responses when
 * the client advertises Accept-Encoding: gzip.
 *
 * Small test payloads need threshold=0 to be compressed. Setting
 * process.env.COMPRESSION_THRESHOLD here is too late to matter: tests/setup.ts
 * (a Jest setupFiles entry, which always runs before this file's own code)
 * already imports src/db, which imports src/config — so src/config's
 * `compressionThresholdBytes` (computed once, eagerly, from the env var at
 * that time) is already cached at its 1024-byte default by the time this
 * line would run. Mutating the already-imported config object directly,
 * before src/app (and therefore its compression() middleware setup) is first
 * required, is what actually takes effect.
 */
import config from '../../src/config';
config.compressionThresholdBytes = 0;

import request from 'supertest';
import app from '../../src/app';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
  getPlayerById: jest.fn().mockReturnValue(null),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'player_search',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: '0'.repeat(64),
    hash: 'mock-hash-1',
    event_source: 'app_event',
  }),
  // src/app.ts's /health and /ready probes go through getDriver().
  getDriver: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue({ '?column?': 1 }),
    run: jest.fn().mockResolvedValue({ changes: 1, lastId: 0 }),
  }),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  indexerLedgerLag: 0,
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  stellarHealth: jest.fn().mockResolvedValue(true),
  updateProfile: jest.fn(),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  cacheGet: jest.fn().mockReturnValue(undefined),
  cacheSet: jest.fn(),
  invalidatePlayerCache: jest.fn(),
}));

describe('Response compression', () => {
  it('compresses the player list response when client sends Accept-Encoding: gzip', async () => {
    const res = await request(app)
      .get('/api/players')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((res, callback) => {
        // Collect raw bytes so we can inspect headers before decompression.
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('serves health check correctly without compression when not requested', async () => {
    const res = await request(app)
      .get('/health')
      .set('Accept-Encoding', 'identity');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves health check with gzip when Accept-Encoding: gzip is set', async () => {
    const res = await request(app)
      .get('/health')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
