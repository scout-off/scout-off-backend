/**
 * SSE live authorization enforcement (#1019).
 *
 * Verifies the full lifecycle of an established authenticated SSE connection:
 *   1. connect with a JWT carrying a jti
 *   2. receive authorized wallet-scoped events
 *   3. revoke the token / blocklist the wallet
 *   4. revocation is detected within the documented bound
 *   5. the stream emits `session_ended` and terminates
 *   6. no further protected wallet events are delivered
 *
 * Detection bound documentation (docs/auth.md): immediate for revocations
 * processed in-process; ≤ SSE_AUTH_SWEEP_INTERVAL_MS (default 30 s) for
 * cross-process changes. These tests exercise the immediate in-process path
 * and assert detection well within 1 s.
 */

import http from 'http';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { EventBroadcaster, broadcaster } from '../../src/services/eventBroadcaster';
import { revokeToken } from '../../src/services/tokenBlocklist';
import { blocklistWallet, unblocklistWallet, _resetWalletBlocklistForTests } from '../../src/services/walletBlocklist';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

const WALLET_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GAWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeToken(wallet: string, role = 'scout', jti?: string): string {
  return jwt.sign(
    { sub: wallet, role, ...(jti ? { jti } : {}) },
    SECRET,
    { expiresIn: '1h' },
  );
}

// ─── SSE HTTP helper (same as sseStream.test.ts) ─────────────────────────────

interface SseConnection {
  chunks: string[];
  destroy: () => void;
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
            check();
            const interval = setInterval(check, 20);
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
  EventBroadcaster._resetForTests();
  _resetWalletBlocklistForTests();
});

afterEach(async () => {
  await unblocklistWallet(WALLET_A);
  await unblocklistWallet(WALLET_B);
});

/** Wait until the connection's collected frames contain `session_ended`. */
async function waitForSessionEnded(
  conn: SseConnection,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conn.chunks.join('').includes('event: session_ended')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for session_ended frame');
}

// ─── Token revocation ─────────────────────────────────────────────────────────

describe('SSE — token revocation terminates the stream', () => {
  it('delivers wallet events, then terminates on token revocation within the bound', async () => {
    const jti = `jti-${Date.now()}`;
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A, 'scout', jti),
    );

    await conn.waitForChunks(1, 1000).catch(() => {});

    // 1. Authorized wallet-scoped event is delivered.
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, milestone_type: 'performance' },
    });
    await conn.waitForChunks(2, 1000).catch(() => {});
    expect(conn.chunks.join('')).toContain('event: milestone_approved');

    // 2. Revoke the token (in-process → immediate detection path).
    const startedAt = Date.now();
    await revokeToken(jti, Math.floor(Date.now() / 1000) + 3600);

    // 3. Detection within the documented bound (immediate; assert < 1 s).
    await waitForSessionEnded(conn, 1500);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1000);

    const all = conn.chunks.join('');
    expect(all).toContain('event: session_ended');
    expect(all).toContain('"reason":"token_revoked"');

    // 4. No subsequent protected wallet events are delivered.
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, milestone_type: 'after-revoke' },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.chunks.join('')).not.toContain('after-revoke');

    conn.destroy();
  });

  it('does not terminate another connection whose token was not revoked', async () => {
    const jtiA = `jti-a-${Date.now()}`;
    const jtiB = `jti-b-${Date.now()}`;
    const { conn: connA } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A, 'scout', jtiA),
    );
    const { conn: connB } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_B, 'scout', jtiB),
    );
    await Promise.all([
      connA.waitForChunks(1, 1000).catch(() => {}),
      connB.waitForChunks(1, 1000).catch(() => {}),
    ]);

    await revokeToken(jtiA, Math.floor(Date.now() / 1000) + 3600);

    await waitForSessionEnded(connA, 1500);
    expect(connA.chunks.join('')).toContain('event: session_ended');
    // connB is unaffected.
    expect(connB.chunks.join('')).not.toContain('event: session_ended');

    connA.destroy();
    connB.destroy();
  });

  it('rejects a connection whose token is already revoked (401)', async () => {
    const jti = `jti-revoked-${Date.now()}`;
    await revokeToken(jti, Math.floor(Date.now() / 1000) + 3600);

    const { statusCode, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A, 'scout', jti),
    );
    conn.destroy();
    expect(statusCode).toBe(401);
  });
});

// ─── Wallet blocklisting ──────────────────────────────────────────────────────

describe('SSE — wallet blocklisting terminates the stream', () => {
  it('terminates an established stream when the wallet is blocklisted', async () => {
    const { conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    await conn.waitForChunks(1, 1000).catch(() => {});

    // Wallet-scoped event delivered before the block.
    broadcaster.broadcast({
      type: 'scout_subscribed',
      payload: { scout: WALLET_A, tier: 'basic' },
    });
    await conn.waitForChunks(2, 1000).catch(() => {});
    expect(conn.chunks.join('')).toContain('event: scout_subscribed');

    // Block the wallet → immediate termination.
    const startedAt = Date.now();
    await blocklistWallet(WALLET_A, 'abuse');
    await waitForSessionEnded(conn, 1500);
    expect(Date.now() - startedAt).toBeLessThan(1000);

    const all = conn.chunks.join('');
    expect(all).toContain('event: session_ended');
    expect(all).toContain('"reason":"wallet_blocklisted"');

    // No further protected events delivered.
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A, milestone_type: 'after-block' },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.chunks.join('')).not.toContain('after-block');

    conn.destroy();
  });

  it('denies a new connection from a blocklisted wallet (403)', async () => {
    await blocklistWallet(WALLET_A, 'abuse');

    const { statusCode, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    conn.destroy();
    expect(statusCode).toBe(403);
  });

  it('allows the wallet again after it is unblocked', async () => {
    await blocklistWallet(WALLET_A, 'abuse');
    await unblocklistWallet(WALLET_A);

    const { statusCode, conn } = await openSseConnection(
      server,
      '/api/events/stream',
      makeToken(WALLET_A),
    );
    conn.destroy();
    expect(statusCode).toBe(200);
  });

  it('only terminates the blocklisted wallet, not other wallets', async () => {
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
      connA.waitForChunks(1, 1000).catch(() => {}),
      connB.waitForChunks(1, 1000).catch(() => {}),
    ]);

    await blocklistWallet(WALLET_A, 'abuse');

    await waitForSessionEnded(connA, 1500);
    expect(connA.chunks.join('')).toContain('event: session_ended');
    expect(connB.chunks.join('')).not.toContain('event: session_ended');

    connA.destroy();
    connB.destroy();
  });
});