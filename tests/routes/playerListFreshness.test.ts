/**
 * #763 — player-list cache freshness after indexed events.
 *
 * Flow under test (acceptance criterion: "After a `player_registered` event is
 * indexed, subsequent `GET /api/players` requests return fresh data"):
 *
 *   GET /api/players          → cached result (list cache populated)
 *   player_registered indexed → cache invalidated by the indexer
 *   GET /api/players          → fresh result (new player visible)
 *
 * The indexer is driven by a mocked Soroban event stream; the DB, cache and
 * HTTP stack are all real.
 */
import request from 'supertest';
import { getDb, insertOrUpdatePlayer } from '../../src/db';
import { cacheGet } from '../../src/services/cache';
import { indexEvents } from '../../src/services/indexer';

jest.mock('../../src/services/stellar', () => ({
  server: {
    getEvents: jest.fn(),
  },
  updateProfile: jest.fn(),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { server } = require('../../src/services/stellar') as { server: { getEvents: jest.Mock } };

import app from '../../src/app';

function makeEvent(type: string, payload: Record<string, unknown>, txHash: string, ledger = 1000) {
  // In @stellar/stellar-sdk v16+, topic items and value are xdr.ScVal objects.
  const { nativeToScVal } = require('@stellar/stellar-sdk');
  return {
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(payload),
    ledger,
    txHash,
  };
}

/** Recompute the exact cache key filterPlayers() uses for a no-query GET /api/players. */
function listCacheKey(overrides: Record<string, unknown> = {}): string {
  return `players:list:${JSON.stringify({
    region: null,
    position: null,
    minTier: null,
    sortBy: 'relevance',
    sortOrder: 'desc',
    page: null,
    cursor: null,
    pageSize: 20,
    ...overrides,
  })}`;
}

describe('player list freshness after indexed player_registered events', () => {
  const WALLET_A = 'G' + 'A'.repeat(55);
  const WALLET_B = 'G' + 'B'.repeat(55);
  const ID_A = 'fresh-test-a-' + Math.random().toString(36).slice(2);
  const ID_B = 'fresh-test-b-' + Math.random().toString(36).slice(2);
  const TX_B = 'tx-fresh-b-' + Math.random().toString(36).slice(2);

  beforeEach(() => {
    jest.clearAllMocks();
    const db = getDb();
    db.prepare('DELETE FROM players WHERE player_id IN (?, ?)').run(ID_A, ID_B);
    db.prepare('DELETE FROM events WHERE tx_hash = ?').run(TX_B);
  });

  afterEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM players WHERE player_id IN (?, ?)').run(ID_A, ID_B);
    db.prepare('DELETE FROM events WHERE tx_hash = ?').run(TX_B);
  });

  it('serves fresh list data after a player_registered event is indexed', async () => {
    insertOrUpdatePlayer({
      player_id: ID_A,
      wallet: WALLET_A,
      position: 'striker',
      region: 'europe',
      created_at: 1000,
      registered_at: 1000,
    });

    // 1. Prime the list cache: the response is produced from the DB and cached.
    const first = await request(app).get('/api/players');
    expect(first.status).toBe(200);
    expect(first.body.data.some((p: { player_id: string }) => p.player_id === ID_A)).toBe(true);
    expect(await cacheGet(listCacheKey())).toBeDefined();

    // 2. Index a player_registered event for a brand-new player.
    server.getEvents.mockResolvedValue({
      latestLedger: 1100,
      events: [
        makeEvent(
          'player_registered',
          { player_id: ID_B, wallet: WALLET_B, position: 'midfielder', region: 'europe' },
          TX_B,
          1100,
        ),
      ],
    });
    await indexEvents();

    // 3. The player-list cache must have been invalidated by the indexer.
    expect(await cacheGet(listCacheKey())).toBeUndefined();

    // 4. The next request is served fresh and includes the newly indexed player.
    const fresh = await request(app).get('/api/players');
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.some((p: { player_id: string }) => p.player_id === ID_A)).toBe(true);
    expect(fresh.body.data.some((p: { player_id: string }) => p.player_id === ID_B)).toBe(true);
  });
});
