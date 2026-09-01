/**
 * Tests for dead-letter threshold alerting (#1131).
 */

import {
  evaluateDeadLetterAlerts,
} from '../../src/services/webhookDeadLetterAlerts';
import * as metrics from '../../src/middleware/metrics';

describe('evaluateDeadLetterAlerts', () => {
  beforeEach(() => {
    metrics.resetMetrics();
    process.env.WEBHOOK_DLQ_SIZE_THRESHOLD = '10';
    process.env.WEBHOOK_DLQ_RATE_THRESHOLD = '5';
    process.env.WEBHOOK_DLQ_RATE_WINDOW_MS = '60000';
    delete process.env.PLATFORM_ADMIN_NOTIFY_URL;
    // Config module caches values at import time — exercise via direct threshold
    // by stubbing through the evaluate path's config import is hard; instead we
    // rely on the job's default config and override via jest.resetModules when
    // needed. Here we test the pure evaluate function with a notify hook and
    // force sizeExceeded by passing total above the module's configured default (100)
    // OR re-require config. Simplest path: use totals above default 100.
  });

  afterEach(() => {
    delete process.env.WEBHOOK_DLQ_SIZE_THRESHOLD;
    delete process.env.WEBHOOK_DLQ_RATE_THRESHOLD;
    delete process.env.WEBHOOK_DLQ_RATE_WINDOW_MS;
  });

  it('emits critical log and notifies when size threshold is crossed', async () => {
    const criticalSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notify = jest.fn().mockResolvedValue(undefined);

    // Seed insert-rate timestamps below rate threshold.
    metrics.resetWebhookDeadLetterInsertTimestamps();

    const bySubscription = [
      { subscription_id: 7, count: 80 },
      { subscription_id: 3, count: 40 },
    ];

    // Default size threshold is 100 — 120 crosses it.
    const result = await evaluateDeadLetterAlerts(120, bySubscription, { notify });

    expect(result.sizeExceeded).toBe(true);
    expect(result.notified).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: 'webhook_dead_letter_threshold_crossed',
        total: 120,
      }),
    );
    expect(criticalSpy).toHaveBeenCalledWith(
      '[critical]',
      expect.stringContaining('webhook_dead_letter_threshold_crossed'),
    );
    expect(criticalSpy).toHaveBeenCalledWith(
      '[critical]',
      expect.stringContaining('sub=7:80'),
    );

    const gauge = metrics.getWebhookDeadLetterGauge();
    expect(gauge['7']).toBe(80);
    expect(gauge['3']).toBe(40);

    criticalSpy.mockRestore();
  });

  it('fires on insert-rate threshold even when size is below limit', async () => {
    const criticalSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notify = jest.fn().mockResolvedValue(undefined);

    // Simulate a burst of inserts within the window (default rateThreshold=50).
    metrics.resetWebhookDeadLetterInsertTimestamps();
    for (let i = 0; i < 55; i++) {
      metrics.incrementWebhookDeadLettersTotal();
    }

    const result = await evaluateDeadLetterAlerts(10, [{ subscription_id: 1, count: 10 }], {
      notify,
    });

    expect(result.sizeExceeded).toBe(false);
    expect(result.rateExceeded).toBe(true);
    expect(result.insertsInWindow).toBe(55);
    expect(result.notified).toBe(true);
    expect(criticalSpy).toHaveBeenCalledWith(
      '[critical]',
      expect.stringContaining('webhook_dead_letter_threshold_crossed'),
    );

    criticalSpy.mockRestore();
  });

  it('does not alert when below both thresholds', async () => {
    const criticalSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notify = jest.fn();

    metrics.resetWebhookDeadLetterInsertTimestamps();
    const result = await evaluateDeadLetterAlerts(5, [{ subscription_id: 1, count: 5 }], {
      notify,
    });

    expect(result.sizeExceeded).toBe(false);
    expect(result.rateExceeded).toBe(false);
    expect(result.notified).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(criticalSpy).not.toHaveBeenCalledWith(
      '[critical]',
      expect.stringContaining('webhook_dead_letter_threshold_crossed'),
    );

    criticalSpy.mockRestore();
  });
});
