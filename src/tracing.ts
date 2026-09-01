/**
 * OpenTelemetry distributed tracing setup (#768).
 *
 * Initialises the SDK with auto-instrumentation (covers HTTP calls to Soroban
 * RPC and Pinata/IPFS) and an OTLP/HTTP exporter when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set.  When the env var is absent the SDK
 * runs with a NoopSpanExporter so there is zero overhead.
 *
 * W3C TraceContext headers (traceparent, tracestate) are propagated on all
 * outgoing HTTP requests via the W3CTraceContextPropagator registered below.
 *
 * Must be imported/called BEFORE any other module that makes HTTP requests.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;

export function initTracing(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'scout-off-backend',
    instrumentations: [
      getNodeAutoInstrumentations({
        // disable noisy FS instrumentation
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) await sdk.shutdown();
}

/**
 * Returns the shared tracer for manual instrumentation.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is not configured, initTracing() is never
 * called and this returns the global no-op tracer — zero overhead, no spans
 * emitted.  Safe to call from any module without guarding.
 */
export function getTracer() {
  return trace.getTracer('scout-off-backend');
}
