import fetch from 'node-fetch';
import { Request, Response, NextFunction } from 'express';
import { listDeadLetters, replayDeadLetter } from '../../src/controllers/webhookAdminController';
import {
  createWebhookSubscription,
  insertWebhookDeadLetter,
  getWebhookDeadLetterById,
  markWebhookDeadLetterReplayed,
} from '../../src/db';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

function uniqueUrl(label: string): string {
  return `https://example.com/admin-hook-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mockRes() {
  const res: Partial<Response> & { status: jest.Mock; json: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

describe('listDeadLetters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a paginated list including a freshly inserted dead letter', async () => {
    const url = uniqueUrl('list');
    const sub = createWebhookSubscription(url, 'list-secret');
    const rawPayload = JSON.stringify({ eventType: 'trial_offer_logged', payload: { a: 1 } });
    insertWebhookDeadLetter({
      subscriptionId: sub.id,
      url,
      eventType: 'trial_offer_logged',
      payload: rawPayload,
      failureReason: 'Webhook dispatch failed with status 500',
      attempts: 3,
    });

    const req = { query: { page: 1, pageSize: 20 } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await listDeadLetters(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = res.json.mock.calls[0][0] as any;
    expect(body.success).toBe(true);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(typeof body.total).toBe('number');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = body.data.find((d: any) => d.url === url);
    expect(match).toBeDefined();
    expect(match.subscriptionId).toBe(sub.id);
    expect(match.eventType).toBe('trial_offer_logged');
    expect(match.status).toBe('pending');
    // The controller maps the DB row's `attempts` column to the API field
    // `retryCount` (see listDeadLetters()'s doc comment), and exposes only a
    // 200-char `payloadPreview` slice, not the full parsed payload.
    expect(match.retryCount).toBe(3);
    expect(match.payloadPreview).toBe(rawPayload.slice(0, 200));
  });

  it('returns 400 for an invalid pageSize', async () => {
    const req = { query: { page: 1, pageSize: 1000 } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await listDeadLetters(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('replayDeadLetter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('re-attempts delivery and marks the row replayed on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    const url = uniqueUrl('replay-success');
    const sub = createWebhookSubscription(url, 'replay-secret');
    const deadLetter = insertWebhookDeadLetter({
      subscriptionId: sub.id,
      url,
      eventType: 'player_registered',
      payload: JSON.stringify({ eventType: 'player_registered', payload: { wallet: 'GABC' } }),
      failureReason: 'Webhook dispatch failed with status 500',
      attempts: 3,
    });

    const req = { params: { id: String(deadLetter.id) } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await replayDeadLetter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { id: deadLetter.id, status: 'replayed' } })
    );

    const stored = getWebhookDeadLetterById(deadLetter.id);
    expect(stored!.status).toBe('replayed');
    expect(stored!.replayed_at).not.toBeNull();

    // Verify it re-signed with the subscription's secret over the raw payload bytes.
    const call = mockedFetch.mock.calls.find(([calledUrl]) => calledUrl === url);
    expect(call).toBeDefined();
    const [, init] = call!;
    expect((init!.headers as Record<string, string>)['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it(
    'returns 502 and keeps the delivery dead-lettered when the replay also fails',
    async () => {
      mockedFetch.mockRejectedValue(new Error('still unreachable'));

      const url = uniqueUrl('replay-failure');
      const sub = createWebhookSubscription(url, 'replay-secret-2');
      const deadLetter = insertWebhookDeadLetter({
        subscriptionId: sub.id,
        url,
        eventType: 'fees_withdrawn',
        payload: JSON.stringify({ eventType: 'fees_withdrawn', payload: {} }),
        failureReason: 'original failure',
        attempts: 3,
      });

      const req = { params: { id: String(deadLetter.id) } } as unknown as Request;
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await replayDeadLetter(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(502);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = res.json.mock.calls[0][0] as any;
      expect(body.success).toBe(false);
      expect(body.data.status).toBe('pending');
      // The response body's data.retryCount mirrors the DB's `attempts` column
      // (see requeueDeadLetter()'s error branch, which sends `retryCount: attempts`).
      expect(body.data.retryCount).toBe(6); // 3 original + 3 replay attempts

      const stored = getWebhookDeadLetterById(deadLetter.id);
      expect(stored!.status).toBe('pending');
      expect(stored!.attempts).toBe(6);
      expect(stored!.failure_reason).toContain('still unreachable');
    },
    15000
  );

  it('returns 404 for an id that does not exist', async () => {
    const req = { params: { id: '999999999' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await replayDeadLetter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('returns 400 for a non-numeric id', async () => {
    const req = { params: { id: 'not-a-number' } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await replayDeadLetter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 409 when the delivery has already been replayed', async () => {
    const url = uniqueUrl('already-replayed');
    const sub = createWebhookSubscription(url, 'replay-secret-3');
    const deadLetter = insertWebhookDeadLetter({
      subscriptionId: sub.id,
      url,
      eventType: 'contact_unlocked',
      payload: JSON.stringify({ eventType: 'contact_unlocked', payload: {} }),
      failureReason: 'original failure',
      attempts: 3,
    });
    markWebhookDeadLetterReplayed(deadLetter.id);

    const req = { params: { id: String(deadLetter.id) } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await replayDeadLetter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
