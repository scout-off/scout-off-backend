/**
 * Attaches the current OpenTelemetry trace-id as an `X-Trace-Id` response
 * header so clients can correlate requests with distributed traces (#344).
 *
 * Also propagates the active trace context downstream: outgoing HTTP calls
 * made via axios during request handling — to Pinata/IPFS
 * (src/services/ipfs.ts) and to Soroban RPC (src/services/stellar.ts, via
 * the Stellar SDK's own AxiosClient instance) — get a standard W3C
 * `traceparent` header, so those calls appear as child spans of the
 * originating request in any trace backend.
 *
 * When tracing is disabled (no OTLP endpoint / Noop exporter) the
 * active span is an invalid span whose trace-id is all-zeros; in that case
 * both the response header and the outgoing traceparent header are omitted
 * to avoid noise.
 */

import { Request, Response, NextFunction } from 'express';
import { trace, isSpanContextValid, SpanContext } from '@opentelemetry/api';
import axios, { InternalAxiosRequestConfig } from 'axios';

const TRACEPARENT_VERSION = '00';

/** Formats a span context as a W3C Trace Context `traceparent` header value. */
function formatTraceParent(ctx: SpanContext): string {
  const flags = ctx.traceFlags.toString(16).padStart(2, '0');
  return `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/** Returns the current request's traceparent, or null when tracing is disabled/inactive. */
function currentTraceParent(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return null;
  return formatTraceParent(ctx);
}

export function traceId(req: Request, res: Response, next: NextFunction): void {
  const span = trace.getActiveSpan();
  if (span) {
    const ctx = span.spanContext();
    if (isSpanContextValid(ctx)) {
      res.setHeader('X-Trace-Id', ctx.traceId);
    }
  }
  next();
}

/** Injects `traceparent` into an outgoing axios request when a valid span is active. */
export function propagateTraceParent(requestConfig: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const traceparent = currentTraceParent();
  if (traceparent) {
    requestConfig.headers.set('traceparent', traceparent);
  }
  return requestConfig;
}

// Registered once at module load. src/services/ipfs.ts (Pinata) makes its
// calls through the default axios instance imported here.
//
// Note: In @stellar/stellar-sdk v16+ the Soroban RPC server switched its
// internal HTTP client from axios to the platform's native fetch, so the
// SDK no longer exposes an AxiosClient to intercept. Trace propagation for
// Soroban RPC calls now relies on the OpenTelemetry auto-instrumentation
// layer rather than an explicit axios interceptor.
axios.interceptors.request.use(propagateTraceParent);
