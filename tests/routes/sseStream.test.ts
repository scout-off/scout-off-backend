/**
 * Tests for the SSE event stream endpoint (GET /api/events/stream).
 *
 * Coverage:
 *   - 401 when no auth token is provided
 *   - 401 when an invalid / expired token is provided
 *   - 200 + SSE headers on a valid authenticated connection
 *   - "connected" event is sent immediately on connection
 *   - Event delivery: a connected client receives a broadcast event
 *   - Filtering: a client only receives events relevant to their own wallet
 *   - No cross-tenant leakage: events for wallet A are not sent to wallet B
 *   - Server-side filtering by eventType query parameter
 *   - Server-side filtering by playerId query parameter
 *   - Combined eventType + playerId filtering
 *   - Clients with no filters receive all wallet-relevant events (wildcard)
 *   - Keep-alive: the interval timer writes ": ping" frames
 *   - Disconnect cleanup: unsubscribe is called when the client closes
 *   - SSE_MAX_CONNECTIONS enforced with 503
 *   - /api/v1/events/stream mirrors /api/events/stream
 */

import http from 'http';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { EventBroadcaster, broadcaster, BroadcastEvent } from '../../src/services/eventBroadcaster';
import { getSseRetryMs } from '../../src/routes/events';
import config from '../../src/config';

// The stream resolves the connecting wallet's player (cuid2) and matches
// player-scoped events on payload.player_id. These tests broadcast payloads
// keyed by wallet, so map each wallet to a player whose ID is that wallet.
jest.mock('../../src/db', () => ({
  ...jest.requireActual('../../src/db'),
  getPlayerByWallet: jest.fn(async (wallet: string) => ({ player_id: wallet, wallet })),
}));

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Test wallets ─────────────────────────────────────────────────────────────

const WALLET_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GAWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

// ─── SSE HTTP helper ──────────────────────────────────────────────────────────
//
// supertest is synchronous and closes responses immediately, which doesn't work
// well for SSE streams.  We use Node's built-in http module so we can keep the
// connection open long enough to receive frames, then destroy it.

interface SseConnection {
  chunks: string[];
  destroy: () => void;
  /** Wait until at least `count` non-empty data chunks have been received. */
  waitForChunks: (count: number, timeoutMs?: number) => Promise<void>;
}

function openSseConnection(
  server: http.Server,
  path: string,
  token?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; conn: SseConnection }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const chunks: string[] = [];
    let resolved = false;

    const options: http.RequestOptions = {
      host: '127.0.0.1',
      port: addr.port,
      path,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      const conn: SseConnection = {
        chunks,
        destroy: () => { req.destroy(); res.destroy(); },
        waitForChunks(count, timeoutMs = 1000) {
          return new Promise<void>((res2, rej2) => {
            const deadline = setTimeout(() => rej2(new Error(`Timeout waiting for ${count} chunk(s)`)), timeoutMs);
            const check = () => {
              if (chunks.length >= count) {
                clearTimeout(deadline);
                res2();
              }
            };
            // Already have enough
            check();
            // Poll
            const interval = setInterval(() => { check(); }, 20);
            // Clean up interval once resolved
            Promise.race([
              new Promise<void>((r) => setTimeout(r, timeoutMs)),
            ]).finally(() => clearInterval(interval));
          });
        },
      };

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk.toString());
      });

      res.on('error', reject);

      if (!resolved) {
        resolved = true;
        resolve({ statusCode: res.statusCode!, headers: res.headers, conn });
      }
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── Server fixture ───────────────────────────────────────────────────────────

let server: http.Server;

beforeAll((done) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  // Reset broadcaster between tests to avoid subscriber leakage.
  EventBroadcaster._resetForTests();
});

// ─── Auth tests ───────────────────────────────────────────────────────────────

describe('GET /api/events/stream — authentication', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const { statusCode, conn } = await openSseConnection(server, '/api/events/stream');
    conn.destroy();
    expect(statusCode).toBe(401);
  });

  it('returns 401 with an invalid token', async () => {
    const { statusCode, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      'not-a-valid-jwt',
    );
    conn.destroy();
    expect(statusCode).toBe(401);
  });

  it('returns 401 with an expired token', async () => {
    const expired = jwt.sign({ sub: WALLET_A, role: 'scout' }, SECRET, { expiresIn: '-1s' });
    const { statusCode, conn } = await openSseConnection(server, '/api/events/stream', expired);
    conn.destroy();
    expect(statusCode).toBe(401);
  });

  it('returns 200 with a valid Bearer token', async () => {
    const { statusCode, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    conn.destroy();
    expect(statusCode).toBe(200);
  });
});

// ─── SSE headers ─────────────────────────────────────────────────────────────

describe('GET /api/events/stream — response headers', () => {
  it('sets Content-Type to text/event-stream', async () => {
    const { headers, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    conn.destroy();
    expect(headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('sets Cache-Control to no-cache', async () => {
    const { headers, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    conn.destroy();
    expect(headers['cache-control']).toMatch(/no-cache/);
  });
});

// ─── Connected event ──────────────────────────────────────────────────────────

describe('GET /api/events/stream — connected event', () => {
  it('sends an initial "connected" event immediately on connection', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );

    // Wait for the "connected" frame
    await conn.waitForChunks(1, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toContain('event: connected');
    expect(all).toContain(`"wallet":"${WALLET_A}"`);
  });

  it('sends a retry: frame with sensible delay on connection', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toMatch(/retry:\s*\d+/);
    const match = all.match(/retry:\s*(\d+)/);
    expect(match).not.toBeNull();
    const retryVal = parseInt(match![1], 10);
    // Default base is 5000; jitter (up to 20%) gives range [5000, 6000)
    expect(retryVal).toBeGreaterThanOrEqual(5000);
    expect(retryVal).toBeLessThanOrEqual(6000);
  });

  it('uses the configured config.sse.retryMs', async () => {
    const originalRetry = config.sse.retryMs;
    try {
      config.sse.retryMs = 2500;
      const { conn } = await openSseConnection(
        server,
        '/api/events/stream',
        makeToken(WALLET_A),
      );

      await conn.waitForChunks(1, 1000).catch(() => {});
      conn.destroy();

      const all = conn.chunks.join('');
      const match = all.match(/retry:\s*(\d+)/);
      expect(match).not.toBeNull();
      const retryVal = parseInt(match![1], 10);
      // Base is 2500; jitter (up to 20%) gives range [2500, 3000)
      expect(retryVal).toBeGreaterThanOrEqual(2500);
      expect(retryVal).toBeLessThanOrEqual(3000);
    } finally {
      config.sse.retryMs = originalRetry;
    }
  });

  it('produces jittered retry values across connections', () => {
    const samples = new Set<number>();
    for (let i = 0; i < 30; i++) {
      samples.add(getSseRetryMs(5000));
    }
    // With 30 samples drawn from [5000, 5999], multiple distinct values must exist
    expect(samples.size).toBeGreaterThan(1);
    for (const val of samples) {
      expect(val).toBeGreaterThanOrEqual(5000);
      expect(val).toBeLessThanOrEqual(6000);
    }
  });
});

// ─── Event delivery ───────────────────────────────────────────────────────────

describe('GET /api/events/stream — event delivery', () => {
  it('delivers a broadcast event relevant to the connected wallet', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );

    // Wait for the "connected" frame before broadcasting
    await conn.waitForChunks(1, 500).catch(() => {});

    // Broadcast an event relevant to WALLET_A (player_id matches)
    const event: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, milestone_type: 'performance' },
    };
    broadcaster.broadcast(event);

    // Wait for the event frame to arrive
    await conn.waitForChunks(2, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toContain('event: milestone_approved');
    expect(all).toContain(`"player_id":"${WALLET_A}"`);
  });

  it('delivers a scout_subscribed event to the subscribed scout wallet', async () => {
    const scoutToken = makeToken(WALLET_A, 'scout');
    const { conn } = await openSseConnection(server, '/api/events/stream', scoutToken);

    await conn.waitForChunks(1, 500).catch(() => {});

    broadcaster.broadcast({
      type: 'scout_subscribed',
      payload: { scout: WALLET_A, tier: 'premium', expires_at: 9999999 },
    });

    await conn.waitForChunks(2, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toContain('event: scout_subscribed');
    expect(all).toContain('"tier":"premium"');
  });

  it('delivers a contact_unlocked event to the relevant scout', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A, 'scout'),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    broadcaster.broadcast({
      type: 'contact_unlocked',
      payload: { scout: WALLET_A, player_id: 'player-xyz' },
    });

    await conn.waitForChunks(2, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toContain('event: contact_unlocked');
    expect(all).toContain('"player_id":"player-xyz"');
  });
});

// ─── Filtering / no cross-tenant leakage ─────────────────────────────────────

describe('GET /api/events/stream — filtering (no cross-tenant leakage)', () => {
  it('does NOT deliver events meant for a different wallet', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_B),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    // Broadcast an event for WALLET_A only
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, milestone_type: 'performance' },
    });

    // Give it a moment to arrive (it shouldn't)
    await new Promise((r) => setTimeout(r, 100));
    conn.destroy();

    // WALLET_B's stream should only have the connected frame, not the milestone event
    const all = conn.chunks.join('');
    expect(all).not.toContain('event: milestone_approved');
  });

  it('delivers to WALLET_A but not WALLET_B when both are connected', async () => {
    const { conn: connA } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    const { conn: connB } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_B),
    );

    await Promise.all([
      connA.waitForChunks(1, 500).catch(() => {}),
      connB.waitForChunks(1, 500).catch(() => {}),
    ]);

    broadcaster.broadcast({
      type: 'scout_subscribed',
      payload: { scout: WALLET_A, tier: 'basic' },
    });

    await new Promise((r) => setTimeout(r, 150));

    connA.destroy();
    connB.destroy();

    const allA = connA.chunks.join('');
    const allB = connB.chunks.join('');

    expect(allA).toContain('event: scout_subscribed');
    expect(allB).not.toContain('event: scout_subscribed');
  });

  it('delivers to both wallets when a trial_offer_logged event affects both', async () => {
    const scoutToken = makeToken(WALLET_A, 'scout');
    const playerToken = makeToken(WALLET_B, 'player');

    const { conn: connA } = await openSseConnection(server, '/api/events/stream', scoutToken);
    const { conn: connB } = await openSseConnection(server, '/api/events/stream', playerToken);

    await Promise.all([
      connA.waitForChunks(1, 500).catch(() => {}),
      connB.waitForChunks(1, 500).catch(() => {}),
    ]);

    broadcaster.broadcast({
      type: 'trial_offer_logged',
      payload: { scout: WALLET_A, player_id: WALLET_B, details_uri: 'ipfs://abc' },
    });

    await new Promise((r) => setTimeout(r, 150));

    connA.destroy();
    connB.destroy();

    expect(connA.chunks.join('')).toContain('event: trial_offer_logged');
    expect(connB.chunks.join('')).toContain('event: trial_offer_logged');
  });
});

// ─── Server-side filtering by eventType ──────────────────────────────────────

describe('GET /api/events/stream — server-side eventType filter', () => {
  it('delivers only the subscribed event type when eventType param is set', async () => {
    const { conn } = await openSseConnection(
      server,
      `/api/events/stream?eventType=milestone_approved`,
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    // Broadcast both an approved and a registered event relevant to WALLET_A
    broadcaster.broadcast({
      type: 'player_registered',
      payload: { wallet: WALLET_A },
    });
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, milestone_type: 'performance' },
    });

    await conn.waitForChunks(2, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    // Should receive milestone_approved
    expect(all).toContain('event: milestone_approved');
    // Should NOT receive player_registered (filtered out)
    expect(all).not.toContain('event: player_registered');
  });

  it('does NOT deliver events of a different type when eventType filter is active', async () => {
    const { conn } = await openSseConnection(
      server,
      `/api/events/stream?eventType=scout_subscribed`,
      makeToken(WALLET_A, 'scout'),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    broadcaster.broadcast({
      type: 'contact_unlocked',
      payload: { scout: WALLET_A, player_id: 'player-xyz' },
    });

    await new Promise((r) => setTimeout(r, 100));
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).not.toContain('event: contact_unlocked');
  });

  it('receives all event types when no eventType filter is provided (wildcard)', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A, 'scout'),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    broadcaster.broadcast({
      type: 'scout_subscribed',
      payload: { scout: WALLET_A, tier: 'basic' },
    });
    broadcaster.broadcast({
      type: 'contact_unlocked',
      payload: { scout: WALLET_A, player_id: 'player-xyz' },
    });

    await conn.waitForChunks(3, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toContain('event: scout_subscribed');
    expect(all).toContain('event: contact_unlocked');
  });
});

// ─── Server-side filtering by playerId ───────────────────────────────────────

describe('GET /api/events/stream — server-side playerId filter', () => {
  const PLAYER_42 = 'GPLAYER42AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const PLAYER_99 = 'GPLAYER99AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('delivers only events whose payload contains the specified playerId', async () => {
    const { conn } = await openSseConnection(
      server,
      `/api/events/stream?playerId=${PLAYER_42}`,
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    // Relevant event — player_id matches
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: PLAYER_42, wallet: WALLET_A },
    });
    // Irrelevant event — different player_id
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: PLAYER_99, wallet: WALLET_A },
    });

    await conn.waitForChunks(2, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).toContain(`"player_id":"${PLAYER_42}"`);
    expect(all).not.toContain(`"player_id":"${PLAYER_99}"`);
  });

  it('does not receive events for a different playerId', async () => {
    const { conn } = await openSseConnection(
      server,
      `/api/events/stream?playerId=${PLAYER_42}`,
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: PLAYER_99, wallet: WALLET_A },
    });

    await new Promise((r) => setTimeout(r, 100));
    conn.destroy();

    const all = conn.chunks.join('');
    expect(all).not.toContain('event: milestone_approved');
  });
});

// ─── Combined eventType + playerId filtering ──────────────────────────────────

describe('GET /api/events/stream — combined eventType + playerId filter', () => {
  const PLAYER_42 = 'GPLAYER42AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('delivers only events matching both filters simultaneously', async () => {
    const { conn } = await openSseConnection(
      server,
      `/api/events/stream?eventType=milestone_approved&playerId=${PLAYER_42}`,
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 500).catch(() => {});

    // Matches both filters
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: PLAYER_42, wallet: WALLET_A },
    });
    // Wrong event type
    broadcaster.broadcast({
      type: 'player_registered',
      payload: { player_id: PLAYER_42, wallet: WALLET_A },
    });
    // Wrong playerId
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, wallet: WALLET_A },
    });

    await conn.waitForChunks(2, 1000).catch(() => {});
    conn.destroy();

    const all = conn.chunks.join('');
    // The one fully-matching event must arrive
    expect(all).toContain('event: milestone_approved');
    expect(all).toContain(`"player_id":"${PLAYER_42}"`);
    // The wrong-type event must not arrive
    expect(all).not.toContain('event: player_registered');
  });
});

// ─── SSE_MAX_CONNECTIONS ──────────────────────────────────────────────────────

describe('GET /api/events/stream — SSE_MAX_CONNECTIONS', () => {
  it('returns 503 when the connection limit is reached', async () => {
    // Temporarily cap connections to 1 and inject a fake subscriber so the
    // broadcaster reports count=1.
    const originalMax = config.sse.maxConnections;
    const testServer = http.createServer(app);
    await new Promise<void>((res) => testServer.listen(0, '127.0.0.1', res));

    try {
      config.sse.maxConnections = 1;

      // Manually reach the limit by forcing broadcaster.subscriberCount >= 1
      const fakeSub = {
        wallet: 'GFAKE',
        send: () => {},
      };
      broadcaster.subscribe(fakeSub);

      // Now a second connection should get 503.
      // We use supertest-style direct HTTP call with the test server but
      // open as an SSE connection to get the status code.
      const { statusCode, headers, conn } = await openSseConnection(
        testServer,
        '/api/events/stream',
        makeToken(WALLET_A),
      );
      await conn.waitForChunks(1);
      conn.destroy();

      broadcaster.unsubscribe(fakeSub);
      expect(statusCode).toBe(503);
      expect(headers['retry-after']).toBe('30');
      expect(JSON.parse(conn.chunks.join(''))).toMatchObject({
        success: false,
        code: 'SSE_CAPACITY',
      });
    } finally {
      config.sse.maxConnections = originalMax;
      await new Promise<void>((res) => testServer.close(res));
    }
  });
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────

describe('GET /api/events/stream — keep-alive', () => {
  it('sends ": ping" keep-alive frames on the configured interval', async () => {
    // The interval is read from config.sse when each stream opens, so a short
    // override lets the test observe pings without waiting 15 seconds.
    const originalInterval = config.sse.keepaliveIntervalMs;
    const testServer = http.createServer(app);
    await new Promise<void>((res) => testServer.listen(0, '127.0.0.1', res));

    try {
      config.sse.keepaliveIntervalMs = 80;

      const { conn } = await openSseConnection(
        testServer,
        '/api/events/stream',
        makeToken(WALLET_A),
      );

      // Wait long enough for at least two ping cycles (80ms × 3 = 240ms)
      await new Promise((r) => setTimeout(r, 300));
      conn.destroy();

      const all = conn.chunks.join('');
      expect(all).toContain('event: connected');
      expect(all).toContain(': ping');
    } finally {
      config.sse.keepaliveIntervalMs = originalInterval;
      await new Promise<void>((res) => testServer.close(res));
    }
  });
});

// ─── API versioning ───────────────────────────────────────────────────────────

describe('GET /api/v1/events/stream — versioned alias', () => {
  it('returns 200 on the /api/v1 prefix', async () => {
    const { statusCode, conn } = await openSseConnection(
      server,
      '/api/v1/events/stream',
      makeToken(WALLET_A),
    );
    conn.destroy();
    expect(statusCode).toBe(200);
  });

  it('returns 401 without a token on /api/v1 prefix', async () => {
    const { statusCode, conn } = await openSseConnection(server, '/api/v1/events/stream');
    conn.destroy();
    expect(statusCode).toBe(401);
  });
});

// ─── Disconnect cleanup ───────────────────────────────────────────────────────

describe('GET /api/events/stream — disconnect cleanup', () => {
  it('decrements subscriberCount when client disconnects', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 500).catch(() => {});
    const countWhileConnected = broadcaster.subscriberCount;
    conn.destroy();

    // Allow the 'close' event to propagate
    await new Promise((r) => setTimeout(r, 100));

    expect(countWhileConnected).toBeGreaterThan(0);
    expect(broadcaster.subscriberCount).toBe(countWhileConnected - 1);
  });

  it('does not deliver events to a disconnected client', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );

    await conn.waitForChunks(1, 500).catch(() => {});
    conn.destroy();

    // Allow cleanup to run
    await new Promise((r) => setTimeout(r, 100));

    // Broadcast after disconnect — should not throw and conn should not receive it
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(conn.chunks.join('')).not.toContain('event: milestone_approved');
  });
});
