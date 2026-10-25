import fetch from 'node-fetch';
import config from '../../src/config';
import { dispatchEventWebhook } from '../../src/services/webhooks';
import { reactivateAfterPing, resetWebhookBreakers } from '../../src/services/webhookHealth';
import {
  createWebhookSubscription,
  getWebhookSubscriptionById,
  listWebhookDeadLetters,
} from '../../src/db';
import { getWebhookCircuitOpenTotal } from '../../src/middleware/metrics';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

function uniqueUrl(label: string): string {
  return `https://example.com/health-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const callsTo = (url: string) => mockedFetch.mock.calls.filter(([u]) => u === url).length;

describe('webhook endpoint health (#1512)', () => {
  const originalWebhook = { ...config.webhook };
  const originalBreaker = { ...config.circuitBreaker.webhook };

  beforeEach(() => {
    jest.clearAllMocks();
    resetWebhookBreakers();
  });
  afterEach(() => {
    Object.assign(config.webhook, originalWebhook);
    Object.assign(config.circuitBreaker.webhook, originalBreaker);
  });

  it('suspends after the consecutive-failure threshold and stops all delivery attempts', async () => {
    config.webhook.suspendAfterFailures = 2;
    config.circuitBreaker.webhook.failureThreshold = 100;
    mockedFetch.mockRejectedValue(new Error('connection refused'));
    const url = uniqueUrl('suspend');
    const sub = createWebhookSubscription(url, 'secret-suspend');

    await dispatchEventWebhook('player_registered', { n: 1 });
    expect(getWebhookSubscriptionById(sub.id)!.status).toBe('degraded');
    await dispatchEventWebhook('player_registered', { n: 2 });

    const suspended = getWebhookSubscriptionById(sub.id)!;
    expect(suspended.status).toBe('suspended');
    expect(suspended.consecutive_failures).toBe(2);
    expect(suspended.suspended_reason).toMatch(/2 consecutive failures/);
    expect(suspended.suspended_at).toBeGreaterThan(0);

    const callsBefore = callsTo(url);
    await dispatchEventWebhook('player_registered', { n: 3 });
    expect(callsTo(url)).toBe(callsBefore);
  }, 30000);

  it('skips the HTTP call and dead-letters with circuit_open while the circuit is open', async () => {
    config.circuitBreaker.webhook.failureThreshold = 1;
    config.circuitBreaker.webhook.resetTimeoutMs = 600000;
    mockedFetch.mockRejectedValue(new Error('connection refused'));
    const url = uniqueUrl('circuit');
    const sub = createWebhookSubscription(url, 'secret-circuit');

    await dispatchEventWebhook('player_registered', { n: 1 });
    const callsAfterFirst = callsTo(url);
    expect(callsAfterFirst).toBeGreaterThan(0);

    const openBefore = getWebhookCircuitOpenTotal();
    await dispatchEventWebhook('player_registered', { n: 2 });
    expect(callsTo(url)).toBe(callsAfterFirst);
    expect(getWebhookCircuitOpenTotal()).toBe(openBefore + 1);

    const letters = listWebhookDeadLetters(200, 0).filter((d) => d.subscription_id === sub.id);
    expect(letters.some((d) => d.failure_reason === 'circuit_open')).toBe(true);
    // A skipped delivery is not a new failure against the endpoint.
    expect(getWebhookSubscriptionById(sub.id)!.consecutive_failures).toBe(1);
  }, 30000);

  it('reactivates only when the test ping succeeds', async () => {
    config.webhook.suspendAfterFailures = 1;
    mockedFetch.mockRejectedValue(new Error('down'));
    const url = uniqueUrl('reactivate');
    const created = createWebhookSubscription(url, 'secret-reactivate');
    await dispatchEventWebhook('player_registered', {});
    expect(getWebhookSubscriptionById(created.id)!.status).toBe('suspended');

    const failed = await reactivateAfterPing({ ...created, status: 'suspended' }, 'GOWNER');
    expect(failed.ok).toBe(false);
    expect(getWebhookSubscriptionById(created.id)!.status).toBe('suspended');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
    const ok = await reactivateAfterPing({ ...created, status: 'suspended' }, 'GOWNER');
    expect(ok.ok).toBe(true);
    const row = getWebhookSubscriptionById(created.id)!;
    expect(row.status).toBe('active');
    expect(row.consecutive_failures).toBe(0);
    expect(row.suspended_at).toBeNull();
  }, 30000);
});
