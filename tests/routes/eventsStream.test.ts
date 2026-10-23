import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

jest.mock('../../src/db', () => ({
  getPlayerByWallet: jest.fn().mockResolvedValue({ player_id: 'player-cuid-1' }),
}));

jest.mock('../../src/services/tokenBlocklist', () => ({
  isTokenRevoked: jest.fn().mockResolvedValue(false),
  getActiveRevokedJtis: jest.fn().mockResolvedValue([]),
  onTokenRevoked: jest.fn(() => () => {}),
}));

jest.mock('../../src/services/walletBlocklist', () => ({
  isWalletBlocklisted: jest.fn().mockResolvedValue(false),
  refreshBlockedWallets: jest.fn().mockResolvedValue([]),
  onWalletBlocked: jest.fn(() => () => {}),
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import eventsRouter from '../../src/routes/events';
import { broadcaster } from '../../src/services/eventBroadcaster';
import config from '../../src/config';

const app = express();
app.use('/api/events', eventsRouter);

const WALLET_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GAWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeToken(wallet: string, expiresIn: string): string {
  return jwt.sign(
    { sub: wallet, role: 'player', jti: `sse-test-${wallet}` },
    config.jwtSecret,
    { expiresIn },
  );
}

async function waitForSubscriberCount(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (broadcaster.subscriberCount === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${count} SSE subscribers; got ${broadcaster.subscriberCount}`);
}

const openRequests: Array<{ abort: () => void }> = [];
const originalSseConfig = { ...config.sse };

function openStream(wallet: string): { abort: () => void } {
  const stream = request(app)
    .get('/api/events/stream')
    .set('Authorization', `Bearer ${makeToken(wallet, '1m')}`);
  stream.end(() => undefined);
  openRequests.push(stream);
  return stream;
}

afterEach(async () => {
  for (const stream of openRequests.splice(0)) stream.abort();
  await waitForSubscriberCount(0);
  Object.assign(config.sse, originalSseConfig);
});

describe('GET /api/events/stream session limits', () => {
  it('caps streams per wallet without blocking other wallets', async () => {
    config.sse.maxConnections = 0;
    config.sse.maxConnectionsPerWallet = 1;

    const firstWalletStream = openStream(WALLET_A);
    await waitForSubscriberCount(1);

    const otherWalletStream = openStream(WALLET_B);
    await waitForSubscriberCount(2);

    const excessStream = await request(app)
      .get('/api/events/stream')
      .set('Authorization', `Bearer ${makeToken(WALLET_A, '1m')}`);

    expect(excessStream.status).toBe(429);
    expect(excessStream.body.error).toMatch(/connection limit/i);

    firstWalletStream.abort();
    otherWalletStream.abort();
    await waitForSubscriberCount(0);
  });

  it('closes an established stream when its access JWT expires', async () => {
    const token = makeToken(WALLET_A, '2s');
    const responsePromise = request(app)
      .get('/api/events/stream')
      .set('Authorization', `Bearer ${token}`)
      .then((result) => result);
    await waitForSubscriberCount(1);
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: { player_id: 'player-cuid-1' },
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: connected');
    expect(response.text).toContain('event: milestone_approved');
    expect(response.text).toContain('event: session_ended');
    expect(response.text).toContain('"reason":"token_expired"');
    expect(broadcaster.subscriberCount).toBe(0);
  });
});
