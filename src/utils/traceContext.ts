import {
  context, propagation, trace, isSpanContextValid, ROOT_CONTEXT,
  SpanKind, SpanStatusCode, type Attributes, type SpanContext,
} from '@opentelemetry/api';

export type TraceCarrier = Record<string, string>;

/** W3C propagator respects the active span's sampling flag and tracestate. */
export function injectTraceHeaders(headers: TraceCarrier = {}): TraceCarrier {
  propagation.inject(context.active(), headers);
  return headers;
}

export function encodeTracedMessage(data: unknown): string {
  const active = trace.getSpanContext(context.active());
  // Preserve the legacy wire format when tracing has no valid context.
  if (!active || !isSpanContextValid(active)) return JSON.stringify(data);
  return JSON.stringify({ data, trace: injectTraceHeaders() });
}

export function extractTraceContext(carrier: TraceCarrier): SpanContext | undefined {
  const extracted = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, carrier));
  return extracted && isSpanContextValid(extracted) ? extracted : undefined;
}

/** Legacy messages pass through; asynchronous consumers link rather than reparent. */
export async function consumeTracedMessage<T>(
  message: string,
  name: string,
  fn: (data: unknown) => T | Promise<T>,
  attributes: Attributes = {},
): Promise<T> {
  const parsed: unknown = JSON.parse(message);
  let data = parsed;
  let origin: SpanContext | undefined;
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'trace' in parsed) {
    const envelope = parsed as { data: unknown; trace: unknown };
    data = envelope.data;
    if (envelope.trace && typeof envelope.trace === 'object') {
      const carrier: TraceCarrier = {};
      for (const key of ['traceparent', 'tracestate']) {
        const value = (envelope.trace as Record<string, unknown>)[key];
        if (typeof value === 'string') carrier[key] = value;
      }
      origin = extractTraceContext(carrier);
    }
  }
  if (!origin) return fn(data);
  // Use the extracted parent for sampling, and a link for the async boundary.
  const parent = trace.setSpanContext(ROOT_CONTEXT, origin);
  return trace.getTracer('scout-off-backend').startActiveSpan(name, {
    kind: SpanKind.CONSUMER, links: [{ context: origin }], attributes,
  }, parent, async (span) => {
    try {
      return await fn(data);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
