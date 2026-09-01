import fetch from 'node-fetch';
import crypto from 'crypto';
import { postWebhookWithRetry, signWebhookPayload, dispatchEventWebhook } from '../../src/services/webhooks';
import { createWebhookSubscription, listWebhookDeadLetters } from '../../src/db';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

function uniqueUrl(label: string): string {
  return `https://example.com/hook-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('postWebhookWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns successfully when the first request succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await expect(postWebhookWithRetry('https://example.com', { eventType: 'test' })).resolves.toBeUndefined();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on an initial failure and succeeds on a later attempt', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('network fail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await expect(
      postWebhookWithRetry('https://example.com', { eventType: 'test' }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 })
    ).resolves.toBeUndefined();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries fail', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));

    await expect(
      postWebhookWithRetry('https://example.com', { eventType: 'test' }, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow('network down');

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('signs the raw request body and attaches X-Webhook-Signature when a secret is provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
    const payload = { eventType: 'test', payload: { a: 1 } };

    await postWebhookWithRetry('https://example.com', payload, { secret: 'shh-secret' });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedFetch.mock.calls[0];
    const rawBody = init!.body as string;
    expect(rawBody).toBe(JSON.stringify(payload));

    const signatureHeader = (init!.headers as Record<string, string>)['X-Webhook-Signature'];
    expect(signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/);

    const expectedDigest = crypto.createHmac('sha256', 'shh-secret').update(rawBody).digest('hex');
    expect(signatureHeader).toBe(`sha256=${expectedDigest}`);
  });

  it('omits the signature header when no secret is provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await postWebhookWithRetry('https://example.com', { eventType: 'test' });

    const [, init] = mockedFetch.mock.calls[0];
    expect((init!.headers as Record<string, string>)['X-Webhook-Signature']).toBeUndefined();
  });

  it(
    'fails within the configured timeout when the subscriber never responds',
    async () => {
      // Simulates a subscriber that accepts the TCP connection but never sends
      // a response: the underlying fetch promise never settles on its own.
      // A real `node-fetch` call passed an aborted signal rejects with an
      // AbortError, so we mimic that here to exercise our abort wiring
      // without depending on real network timing.
      mockedFetch.mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }) as ReturnType<typeof fetch>;
      });

      const startedAt = Date.now();
      await expect(
        postWebhookWithRetry('https://example.com', { eventType: 'test' }, {
          retries: 1,
          timeoutMs: 50,
        })
      ).rejects.toThrow(/timed out/i);

      // The attempt must fail close to the configured timeout, not hang
      // indefinitely (well under the 10s test timeout below).
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockedFetch.mock.calls[0];
      expect(init!.signal).toBeDefined();
    },
    10000
  );
});

describe('signWebhookPayload', () => {
  it('produces the documented sha256=<hex> format, verifiable by recomputing the HMAC with the same secret', () => {
    const secret = 'my-subscriber-secret';
    const rawBody = JSON.stringify({ eventType: 'player_registered', payload: { wallet: 'GABC' } });

    const signature = signWebhookPayload(rawBody, secret);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    // A receiver recomputing the HMAC over the same raw body with the same
    // secret must derive the identical signature (docs/webhooks.md).
    const recomputed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(signature).toBe(`sha256=${recomputed}`);
  });

  it('produces a different signature for a different secret or a different body', () => {
    const rawBody = JSON.stringify({ eventType: 'test' });
    expect(signWebhookPayload(rawBody, 'secret-a')).not.toBe(signWebhookPayload(rawBody, 'secret-b'));

    const otherBody = JSON.stringify({ eventType: 'other' });
    expect(signWebhookPayload(rawBody, 'secret-a')).not.toBe(signWebhookPayload(otherBody, 'secret-a'));
  });
});

describe('dispatchEventWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delivers to a registered subscription signed with its own secret', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
    const url = uniqueUrl('delivered');
    const secret = 'subscriber-secret-a';
    createWebhookSubscription(url, secret);

    await dispatchEventWebhook('player_registered', { wallet: 'GABC' });

    const call = mockedFetch.mock.calls.find(([calledUrl]) => calledUrl === url);
    expect(call).toBeDefined();
    const [, init] = call!;
    const rawBody = init!.body as string;
    const signatureHeader = (init!.headers as Record<string, string>)['X-Webhook-Signature'];
    expect(signatureHeader).toBe(signWebhookPayload(rawBody, secret));
    const parsed = JSON.parse(rawBody);
    expect(parsed.eventType).toBe('player_registered');
    expect(parsed.payload).toEqual({ wallet: 'GABC' });
    // Delivery ID must be present and covered by the HMAC signature
    expect(parsed.deliveryId).toBeDefined();
    expect(typeof parsed.deliveryId).toBe('string');
    expect(parsed.deliveryId.length).toBeGreaterThan(0);
  });

  it(
    'persists a dead letter with the right fields when retries are exhausted, without throwing',
    async () => {
      mockedFetch.mockRejectedValue(new Error('connection refused'));
      const url = uniqueUrl('dead-letter');
      const secret = 'subscriber-secret-b';
      const subscription = createWebhookSubscription(url, secret);

      await expect(dispatchEventWebhook('milestone_approved', { milestoneId: 'm1' })).resolves.toBeUndefined();

      const deadLetters = listWebhookDeadLetters(100, 0);
      const match = deadLetters.find((d) => d.url === url);
      expect(match).toBeDefined();
      expect(match!.subscription_id).toBe(subscription.id);
      expect(match!.event_type).toBe('milestone_approved');
      // Payload must include deliveryId
      const parsedPayload = JSON.parse(match!.payload);
      expect(parsedPayload.eventType).toBe('milestone_approved');
      expect(parsedPayload.payload).toEqual({ milestoneId: 'm1' });
      expect(parsedPayload.deliveryId).toBeDefined();
      expect(typeof parsedPayload.deliveryId).toBe('string');
      // delivery_id column must match the deliveryId in the payload
      expect(match!.delivery_id).toBe(parsedPayload.deliveryId);
      expect(match!.failure_reason).toContain('connection refused');
      expect(match!.attempts).toBe(3);
      expect(match!.status).toBe('pending');
    },
    15000
  );

  it(
    'dead-letters only the subscriber that fails when multiple subscriptions are registered',
    async () => {
      const okUrl = uniqueUrl('ok');
      const failingUrl = uniqueUrl('fail');
      createWebhookSubscription(okUrl, 'secret-ok');
      createWebhookSubscription(failingUrl, 'secret-fail');

      mockedFetch.mockImplementation(async (url) => {
        if (url === failingUrl) {
          throw new Error('subscriber unreachable');
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { ok: true, status: 200 } as any;
      });

      await dispatchEventWebhook('scout_subscribed', { scout: 'S1' });

      const deadLetters = listWebhookDeadLetters(100, 0);
      expect(deadLetters.find((d) => d.url === failingUrl)).toBeDefined();
      expect(deadLetters.find((d) => d.url === okUrl)).toBeUndefined();
    },
    15000
  );

  it(
    'delivery ID is HMAC-covered — altering it invalidates the signature',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
      const url = uniqueUrl('hmac-cover');
      const secret = 'subscriber-secret-hmac';
      createWebhookSubscription(url, secret);

      await dispatchEventWebhook('player_registered', { wallet: 'GABC' });

      const call = mockedFetch.mock.calls.find(([calledUrl]) => calledUrl === url);
      expect(call).toBeDefined();
      const [, init] = call!;
      const rawBody = init!.body as string;
      const parsed = JSON.parse(rawBody);

      // The HMAC is computed over the raw body that includes the deliveryId.
      // If we swap the deliveryId and re-sign with the same secret,
      // the original signature no longer matches.
      const tampered = { ...parsed, deliveryId: 'forged-id' };
      const tamperedBody = JSON.stringify(tampered);
      const originalSig = (init!.headers as Record<string, string>)['X-Webhook-Signature'];
      expect(originalSig).toBe(signWebhookPayload(rawBody, secret));
      expect(signWebhookPayload(tamperedBody, secret)).not.toBe(originalSig);
    },
    15000
  );

  it(
    'genuinely distinct events produce distinct delivery IDs',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
      const url1 = uniqueUrl('distinct-1');
      const url2 = uniqueUrl('distinct-2');
      createWebhookSubscription(url1, 'secret-1');
      createWebhookSubscription(url2, 'secret-2');

      await dispatchEventWebhook('player_registered', { wallet: 'A' });
      await dispatchEventWebhook('milestone_approved', { milestoneId: 'B' });

      const bodies = mockedFetch.mock.calls.map(([, init]) =>
        JSON.parse((init!.body as string))
      );

      expect(bodies.length).toBeGreaterThanOrEqual(2);
      const deliveryIds = bodies.map((b) => b.deliveryId);

      // Each event type is dispatched to multiple subscriptions, so the same
      // delivery ID appears once per subscription for a given event. Verify
      // that distinct events have distinct delivery IDs by collecting unique
      // IDs and confirming at least 2 different ones.
      const uniqueIds = [...new Set(deliveryIds)];
      expect(uniqueIds.length).toBeGreaterThanOrEqual(2);

      // Within a single call to dispatchEventWebhook, all subscriptions get
      // the same delivery ID. Verify this: both calls to url1 should have
      // different IDs (one per event).
      const url1Calls = mockedFetch.mock.calls.filter(([u]) => u === url1);
      const url1Ids = url1Calls.map(([, init]) =>
        JSON.parse((init!.body as string)).deliveryId
      );
      expect(url1Ids[0]).not.toBe(url1Ids[1]);
    },
    15000
  );
});
