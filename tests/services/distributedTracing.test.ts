import { context, propagation, trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { RequestOptions } from 'https';
import { encodeTracedMessage, consumeTracedMessage, injectTraceHeaders } from '../../src/utils/traceContext';
import { recordTxCorrelation, lookupTxSpanContext, withRestoredCorrelation } from '../../src/services/txCorrelation';
import { postWebhookWithRetry } from '../../src/services/webhooks';
import { safeFetch, type RequestFn } from '../../src/utils/safeFetch';
import { resetTables } from '../helpers/db';
import { createInvalidationHandler, INVALIDATION_CHANNEL, namespacedKey } from '../../src/services/cache';
import { InMemoryCacheStore } from '../../src/services/inMemoryCacheStore';
import { indexEvents } from '../../src/services/indexer';
import { server } from '../../src/services/stellar';
import { nativeToScVal } from '@stellar/stellar-sdk';
import config from '../../src/config';
import * as database from '../../src/db';

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/services/stellar', () => ({ server: { getEvents: jest.fn() } }));

describe('distributed tracing boundaries', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('boundary-test');

  beforeAll(() => provider.register({ propagator: new W3CTraceContextPropagator() }));
  beforeEach(async () => {
    exporter.reset();
    jest.clearAllMocks();
    await resetTables(['tx_correlations', 'tx_trace_context']);
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('sends valid W3C headers belonging to the webhook delivery span', async () => {
    (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue({ ok: true, status: 200 } as never);
    await tracer.startActiveSpan('request', async (requestSpan) => {
      try {
        await postWebhookWithRetry('https://example.com/hook', {}, { retries: 1 });
        const headers = (fetch as jest.Mock).mock.calls[0][1].headers;
        expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        const delivery = exporter.getFinishedSpans().find((span) => span.name === 'webhooks.postWithRetry')!;
        expect(headers.traceparent).toBe(`00-${requestSpan.spanContext().traceId}-${delivery.spanContext().spanId}-01`);
      } finally { requestSpan.end(); }
    });
  });

  it('injects active trace context into the pinned safeFetch request', async () => {
    let sent: RequestOptions | undefined;
    const request: RequestFn = (options, cb) => {
      sent = options;
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void; setTimeout(): void };
      req.destroy = () => undefined;
      req.setTimeout = () => undefined;
      req.end = () => {
        const body = Readable.from([Buffer.from('evidence')]);
        Object.assign(body, { statusCode: 200, headers: {} });
        setImmediate(() => cb(body as never));
      };
      return req as never;
    };
    await tracer.startActiveSpan('safe-fetch-origin', async (span) => {
      try {
        const expected = injectTraceHeaders().traceparent;
        await safeFetch('https://example.com/evidence', {
          maxBytes: 100, request,
          resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        });
        expect((sent!.headers as Record<string, string>).traceparent).toBe(expected);
      } finally { span.end(); }
    });
  });

  it.each(['redis.cache.invalidate', 'redis.security.consume', 'redis.sse.consume'])(
    'carries context and creates linked consumer spans for %s', async (name) => {
      let message = '';
      let origin = { traceId: '', spanId: '', traceFlags: TraceFlags.NONE };
      await tracer.startActiveSpan('publisher', async (span) => {
        origin = span.spanContext();
        message = encodeTracedMessage({ wallet: 'wallet' });
        span.end();
      });
      expect(JSON.parse(message).trace.traceparent).toContain(origin.traceId);
      await context.with(ROOT_CONTEXT, () => consumeTracedMessage(message, name, (data) => {
        expect(data).toEqual({ wallet: 'wallet' });
        expect(trace.getActiveSpan()).toBeDefined();
      }));
      const consumer = exporter.getFinishedSpans().find((span) => span.name === name)!;
      expect(consumer.links[0].context).toMatchObject(origin);
    },
  );

  it('accepts unwrapped legacy payloads', async () => {
    const handler = jest.fn();
    await consumeTracedMessage('{"wallet":"legacy"}', 'legacy.consume', handler);
    expect(handler).toHaveBeenCalledWith({ wallet: 'legacy' });
  });

  it('skips the trace-context database lookup with the no-op propagator', async () => {
    const fields = jest.spyOn(propagation, 'fields').mockReturnValue([]);
    const driver = jest.spyOn(database, 'getDriver');
    try {
      expect(await lookupTxSpanContext('disabled-tracing')).toBeUndefined();
      expect(driver).not.toHaveBeenCalled();
    } finally {
      fields.mockRestore();
      driver.mockRestore();
    }
  });

  it('runs cache invalidation under a linked span while accepting legacy messages', async () => {
    const store = new InMemoryCacheStore();
    const handler = createInvalidationHandler(store);
    await store.set(namespacedKey('players:list:all'), ['player'], 60_000);
    let message = '';
    await tracer.startActiveSpan('cache-publisher', async (span) => {
      message = encodeTracedMessage({ type: 'player_list', action: 'invalidate' });
      span.end();
    });
    await handler(INVALIDATION_CHANNEL, message);
    expect(await store.get(namespacedKey('players:list:all'))).toBeUndefined();
    expect(exporter.getFinishedSpans().find((span) => span.name === 'redis.cache.invalidate')!.links).toHaveLength(1);
    await store.set(namespacedKey('players:list:all'), ['player'], 60_000);
    await handler(INVALIDATION_CHANNEL, 'legacy invalidation');
    expect(await store.get(namespacedKey('players:list:all'))).toBeUndefined();
  });

  it('persists the submission context without a correlation id and links delayed indexer events', async () => {
    let origin = { traceId: '', spanId: '', traceFlags: TraceFlags.NONE };
    await tracer.startActiveSpan('submission', async (span) => {
      origin = span.spanContext();
      await recordTxCorrelation('trace-only-transaction');
      span.end();
    });
    expect(await lookupTxSpanContext('trace-only-transaction')).toMatchObject(origin);
    await context.with(ROOT_CONTEXT, () => withRestoredCorrelation(
      'trace-only-transaction', 'indexer.applyEvent', async () => undefined, undefined,
      { 'stellar.ledger': 123, 'scoutoff.event_type': 'player_registered' },
    ));
    const indexed = exporter.getFinishedSpans().find((span) => span.name === 'indexer.applyEvent')!;
    expect(indexed.links[0].context).toMatchObject(origin);
    expect(indexed.attributes).toMatchObject({
      'stellar.tx_hash': 'trace-only-transaction', 'stellar.ledger': 123,
      'scoutoff.event_type': 'player_registered',
    });
  });

  it('preserves an unsampled origin instead of force sampling receivers', async () => {
    const remote = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: TraceFlags.NONE, isRemote: true };
    const originContext = trace.setSpanContext(ROOT_CONTEXT, remote);
    const message = context.with(originContext, () => encodeTracedMessage({ value: 1 }));
    expect(JSON.parse(message).trace.traceparent).toMatch(/-00$/);
    await consumeTracedMessage(message, 'unsampled.consume', () => {
      expect(trace.getActiveSpan()!.spanContext().traceFlags).toBe(TraceFlags.NONE);
      expect(trace.getActiveSpan()!.isRecording()).toBe(false);
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  // The existing indexer ingestion path still uses the synchronous SQLite handle.
  (config.dbDriver === 'postgres' ? it.skip : it)('links real indexer event and SSE spans to a persisted origin', async () => {
    let origin = { traceId: '', spanId: '', traceFlags: TraceFlags.NONE };
    await tracer.startActiveSpan('originating-request', async (span) => {
      origin = span.spanContext();
      await recordTxCorrelation('real-indexer-trace');
      span.end();
    });
    (server.getEvents as jest.Mock).mockResolvedValue({
      latestLedger: 100_000,
      events: [{
        id: '100000-1-0', ledger: 100_000, txHash: 'real-indexer-trace',
        topic: [nativeToScVal('contact_unlocked', { type: 'symbol' })],
        value: nativeToScVal({ scout: 'wallet', player_id: 'player' }),
      }],
    });
    await indexEvents();
    for (const name of ['indexer.applyEvent', 'indexer.sseDispatch']) {
      const span = exporter.getFinishedSpans().find((entry) => entry.name === name)!;
      expect(span.links.some((link) => link.context.spanId === origin.spanId)).toBe(true);
      expect(span.attributes).toMatchObject({
        'stellar.tx_hash': 'real-indexer-trace', 'stellar.ledger': 100_000,
        'scoutoff.event_type': 'contact_unlocked',
      });
    }
  });
});
