import fetch from 'node-fetch';
import crypto from 'crypto';
import { postWebhookWithRetry, signWebhookPayload, dispatchEventWebhook } from '../../src/services/webhooks';
import { createWebhookSubscription, listWebhookDeadLetters } from '../../src/db';
import { getVersionInfo } from '../../src/version';

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

  it('applies full jitter to exponential backoff delays', async () => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      mockedFetch.mockRejectedValueOnce(new Error('network fail'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFetch.mockResolvedValueOnce({ ok: true, status: 200 } as any);

      const delivery = postWebhookWithRetry(
        'https://example.com',
        { eventType: 'test' },
        { retries: 2, baseDelayMs: 100, maxDelayMs: 100 },
      );
      await jest.advanceTimersByTimeAsync(49);
      expect(mockedFetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toBeUndefined();
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
      jest.useRealTimers();
    }
  });

  it('uses Retry-After for 429/503 responses and drains failed response bodies', async () => {
    jest.useFakeTimers();
    try {
      const body = { resume: jest.fn() };
      mockedFetch
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: { get: () => '2' },
          body,
        } as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ ok: true, status: 200 } as any);

      const delivery = postWebhookWithRetry(
        'https://example.com',
        { eventType: 'test' },
        { retries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      );

      await jest.advanceTimersByTimeAsync(1999);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(body.resume).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toBeUndefined();
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
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

    const requestHeaders = init!.headers as Record<string, string>;
    const signatureHeader = requestHeaders['X-Webhook-Signature'];
    const timestamp = requestHeaders['X-Webhook-Timestamp'];
    expect(signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(timestamp).toMatch(/^\d+$/);

    const expectedDigest = crypto
      .createHmac('sha256', 'shh-secret')
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    expect(signatureHeader).toBe(`sha256=${expectedDigest}`);
  });

  it('omits the signature header when no secret is provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await postWebhookWithRetry('https://example.com', { eventType: 'test' });

    const [, init] = mockedFetch.mock.calls[0];
    expect((init!.headers as Record<string, string>)['X-Webhook-Signature']).toBeUndefined();
    expect((init!.headers as Record<string, string>)['X-Webhook-Timestamp']).toBeUndefined();
  });

  it('sends User-Agent, X-Webhook-Event and X-Webhook-Delivery headers', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await postWebhookWithRetry(
      'https://example.com',
      { eventType: 'player_registered', payload: { wallet: 'GABC' } },
      { eventType: 'player_registered', deliveryId: 'delivery-123' }
    );

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedFetch.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(`ScoutOff-Webhooks/${getVersionInfo().version}`);
    expect(headers['X-Webhook-Event']).toBe('player_registered');
    expect(headers['X-Webhook-Delivery']).toBe('delivery-123');
  });

  it('sends identical headers on every retry attempt', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('network fail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await postWebhookWithRetry(
      'https://example.com',
      { eventType: 'milestone_approved', payload: { milestoneId: 'm1' } },
      { eventType: 'milestone_approved', deliveryId: 'delivery-456', retries: 3, baseDelayMs: 1, maxDelayMs: 2 }
    );

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockedFetch.mock.calls) {
      const headers = init!.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe(`ScoutOff-Webhooks/${getVersionInfo().version}`);
      expect(headers['X-Webhook-Event']).toBe('milestone_approved');
      expect(headers['X-Webhook-Delivery']).toBe('delivery-456');
    }
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
    const timestamp = '1785000000';

    const signature = signWebhookPayload(rawBody, secret, timestamp);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    const recomputed = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    expect(signature).toBe(`sha256=${recomputed}`);
  });

  it('produces a different signature for a different secret or a different body', () => {
    const rawBody = JSON.stringify({ eventType: 'test' });
    const timestamp = '1785000000';
    expect(signWebhookPayload(rawBody, 'secret-a', timestamp)).not.toBe(
      signWebhookPayload(rawBody, 'secret-b', timestamp),
    );

    const otherBody = JSON.stringify({ eventType: 'other' });
    expect(signWebhookPayload(rawBody, 'secret-a', timestamp)).not.toBe(
      signWebhookPayload(otherBody, 'secret-a', timestamp),
    );
    expect(signWebhookPayload(rawBody, 'secret-a', timestamp)).not.toBe(
      signWebhookPayload(rawBody, 'secret-a', '1785000001'),
    );
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
    const requestHeaders = init!.headers as Record<string, string>;
    const signatureHeader = requestHeaders['X-Webhook-Signature'];
    expect(signatureHeader).toBe(
      signWebhookPayload(rawBody, secret, requestHeaders['X-Webhook-Timestamp']),
    );
    const parsed = JSON.parse(rawBody);
    expect(parsed.eventType).toBe('player_registered');
    expect(parsed.payload).toEqual({ wallet: 'GABC' });
    // Delivery ID must be present and covered by the HMAC signature
    expect(parsed.deliveryId).toBeDefined();
    expect(typeof parsed.deliveryId).toBe('string');
    expect(parsed.deliveryId.length).toBeGreaterThan(0);

    // Delivery headers must identify the sender, event and delivery
    const headers = init!.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(`ScoutOff-Webhooks/${getVersionInfo().version}`);
    expect(headers['X-Webhook-Event']).toBe('player_registered');
    expect(headers['X-Webhook-Delivery']).toBe(parsed.deliveryId);
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
      expect(parsedPayload.deliveryId.length).toBeGreaterThan(0);
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

      // The HMAC is computed over the signed timestamp and raw body, which
      // includes the deliveryId.
      // If we swap the deliveryId and re-sign with the same secret,
      // the original signature no longer matches.
      const tampered = { ...parsed, deliveryId: 'forged-id' };
      const tamperedBody = JSON.stringify(tampered);
      const headers = init!.headers as Record<string, string>;
      const timestamp = headers['X-Webhook-Timestamp'];
      const originalSig = headers['X-Webhook-Signature'];
      expect(originalSig).toBe(signWebhookPayload(rawBody, secret, timestamp));
      expect(signWebhookPayload(tamperedBody, secret, timestamp)).not.toBe(originalSig);
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

  it("filters deliveries by subscription event_types (#1309)", async () => {
    const onlyMilestonesUrl = uniqueUrl("only-milestones");
    const onlyContactsUrl = uniqueUrl("only-contacts");

    createWebhookSubscription(onlyMilestonesUrl, "secret-ms", undefined, ["milestone_approved"]);
    createWebhookSubscription(onlyContactsUrl, "secret-ct", undefined, ["contact_unlocked"]);

    await dispatchEventWebhook("milestone_approved", { player_id: "p1" });

    const milestoneCalls = mockedFetch.mock.calls.filter(([u]) => u === onlyMilestonesUrl);
    const contactCalls = mockedFetch.mock.calls.filter(([u]) => u === onlyContactsUrl);

    expect(milestoneCalls.length).toBe(1);
    expect(contactCalls.length).toBe(0);
  });

  it("filters deliveries by scout relevance and avoids cross-scout leaks (#1309)", async () => {
    const scoutA = "GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const scoutB = "GBWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const scoutAUrl = uniqueUrl("scout-a");
    const scoutBUrl = uniqueUrl("scout-b");

    createWebhookSubscription(scoutAUrl, "secret-scout-a", scoutA, ["contact_unlocked", "milestone_approved"]);
    createWebhookSubscription(scoutBUrl, "secret-scout-b", scoutB, ["contact_unlocked", "milestone_approved"]);

    // Scout A unlocks a contact -> Scout A receives it, Scout B must NOT receive it
    await dispatchEventWebhook("contact_unlocked", { scout: scoutA, player_id: "player1" });

    const scoutACalls = mockedFetch.mock.calls.filter(([u]) => u === scoutAUrl);
    const scoutBCalls = mockedFetch.mock.calls.filter(([u]) => u === scoutBUrl);

    expect(scoutACalls.length).toBe(1);
    expect(scoutBCalls.length).toBe(0);

    // Public event milestone_approved -> both scouts receive it
    await dispatchEventWebhook("milestone_approved", { player_id: "player1" });

    const scoutACallsAfter = mockedFetch.mock.calls.filter(([u]) => u === scoutAUrl);
    const scoutBCallsAfter = mockedFetch.mock.calls.filter(([u]) => u === scoutBUrl);

    expect(scoutACallsAfter.length).toBe(2);
    expect(scoutBCallsAfter.length).toBe(1);
  });
});
