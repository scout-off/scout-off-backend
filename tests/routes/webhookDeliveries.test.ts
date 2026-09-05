/**
 * Tests for the webhook delivery-history feature (#1121):
 * - insertWebhookDelivery / getWebhookDeliveries / getWebhookDeliverySummary /
 *   pruneWebhookDeliveries DB helpers
 * - GET /api/admin/webhooks/:id/deliveries returns paginated rows
 * - GET /api/admin/webhooks/:id/summary returns rolled-up stats
 */

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import app from '../../src/app';
import {
  insertWebhookDelivery,
  getWebhookDeliveries,
  getWebhookDeliverySummary,
  pruneWebhookDeliveries,
} from '../../src/db';

// ─── DB helper unit tests ─────────────────────────────────────────────────────

describe('webhook delivery DB helpers', () => {
  const subId = 'test-sub-db';

  it('insertWebhookDelivery + getWebhookDeliveries round-trip', () => {
    insertWebhookDelivery({
      subscriptionId: subId,
      eventType: 'scout_subscribed',
      deliveryId: `wh_test_${Date.now()}`,
      attemptCount: 1,
      status: 'success',
      statusCode: 200,
      latencyMs: 50,
    });

    const { data, total } = getWebhookDeliveries({ subscriptionId: subId });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(data[0].event_type).toBe('scout_subscribed');
    expect(data[0].status).toBe('success');
  });

  it('getWebhookDeliverySummary computes success rate', () => {
    const sub = `test-summary-${Date.now()}`;

    insertWebhookDelivery({
      subscriptionId: sub,
      eventType: 'contact_unlocked',
      deliveryId: `wh_s1_${Date.now()}`,
      attemptCount: 1,
      status: 'success',
    });
    insertWebhookDelivery({
      subscriptionId: sub,
      eventType: 'contact_unlocked',
      deliveryId: `wh_s2_${Date.now()}`,
      attemptCount: 3,
      status: 'failure',
      errorMessage: 'timeout',
    });

    const summary = getWebhookDeliverySummary(sub);
    expect(summary.total).toBe(2);
    expect(summary.successes).toBe(1);
    expect(summary.failures).toBe(1);
    expect(summary.success_rate).toBe(0.5);
    expect(summary.last_success_at).not.toBeNull();
  });

  it('pruneWebhookDeliveries removes old rows', () => {
    const sub = `test-prune-${Date.now()}`;

    // Insert a "very old" row by writing directly with a past timestamp
    // We can't inject timestamp via insertWebhookDelivery so we check pruning
    // removes 0 rows when all records are fresh.
    insertWebhookDelivery({
      subscriptionId: sub,
      eventType: 'fees_withdrawn',
      deliveryId: `wh_p1_${Date.now()}`,
      attemptCount: 1,
      status: 'success',
    });

    // With 0ms retention everything should be pruned
    const pruned = pruneWebhookDeliveries(0);
    expect(pruned).toBeGreaterThanOrEqual(1);
  });
});

// ─── Admin endpoint integration tests ────────────────────────────────────────

// We need an admin JWT. Reuse the JWT signing helper pattern from other tests.
import jwt from 'jsonwebtoken';
import config from '../../src/config';

function makeAdminToken(): string {
  return jwt.sign({ sub: 'GADMIN1234567890', role: 'admin' }, config.jwtSecret, { expiresIn: '1h' });
}

describe('GET /api/admin/webhooks/:id/deliveries', () => {
  const subId = 'https%3A%2F%2Fexample.com%2Fhook';
  const decodedSubId = 'https://example.com/hook';

  beforeAll(() => {
    // Seed two rows for this subscription
    insertWebhookDelivery({
      subscriptionId: decodedSubId,
      eventType: 'player_registered',
      deliveryId: `wh_admin_1_${Date.now()}`,
      attemptCount: 1,
      status: 'success',
      statusCode: 200,
      latencyMs: 80,
    });
    insertWebhookDelivery({
      subscriptionId: decodedSubId,
      eventType: 'milestone_approved',
      deliveryId: `wh_admin_2_${Date.now()}`,
      attemptCount: 2,
      status: 'failure',
      errorMessage: 'upstream timeout',
    });
  });

  it('returns 200 with paginated delivery rows for admin', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .get(`/api/admin/webhooks/${subId}/deliveries`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(`/api/admin/webhooks/${subId}/deliveries`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/webhooks/:id/summary', () => {
  const subId = 'https%3A%2F%2Fexample.com%2Fhook';

  it('returns 200 with success_rate summary for admin', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .get(`/api/admin/webhooks/${subId}/summary`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('success_rate');
    expect(res.body.data).toHaveProperty('total');
    expect(res.body.data).toHaveProperty('last_success_at');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(`/api/admin/webhooks/${subId}/summary`);
    expect(res.status).toBe(401);
  });
});
