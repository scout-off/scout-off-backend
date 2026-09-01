import express from 'express';
import request from 'supertest';
import {
  metricsMiddleware,
  createMetricsHandler,
  resetMetrics,
  PROMETHEUS_CONTENT_TYPE,
  LATENCY_BUCKETS_MS,
} from '../../src/middleware/metrics';

// Build a minimal app that mounts only the metrics middleware and the /metrics
// handler. This deliberately avoids importing the full app so the endpoint's
// behaviour and output format can be validated in isolation.
function buildApp() {
  const app = express();
  app.use(metricsMiddleware);
  app.get('/ok', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/boom', (_req, res) => {
    res.status(500).json({ error: 'boom' });
  });
  app.get('/missing', (_req, res) => {
    res.status(404).json({ error: 'nope' });
  });
  app.get('/metrics', createMetricsHandler(() => 7));
  return app;
}

describe('GET /metrics — Prometheus exposition', () => {
  beforeEach(() => {
    delete process.env.METRICS_ENABLED;
    resetMetrics();
  });

  it('returns 200 with the Prometheus text content-type and requires no auth', async () => {
    const res = await request(buildApp()).get('/metrics'); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(PROMETHEUS_CONTENT_TYPE).toContain('version=0.0.4');
  });

  it('exposes request count, duration histogram, and error-rate metric families', async () => {
    const app = buildApp();
    // Generate traffic so the series are populated.
    await request(app).get('/ok');
    await request(app).get('/ok');
    await request(app).get('/boom'); // 5xx
    await request(app).get('/missing'); // 4xx

    const body = (await request(app).get('/metrics')).text;

    // Request count (counter)
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toMatch(/http_requests_total\{route="GET \/ok"\} 2/);

    // Request duration (histogram): a bucket per boundary, +Inf, _sum, _count
    expect(body).toContain('# TYPE http_request_duration_ms histogram');
    for (const bound of LATENCY_BUCKETS_MS) {
      expect(body).toContain(`http_request_duration_ms_bucket{le="${bound}"}`);
    }
    expect(body).toMatch(/http_request_duration_ms_bucket\{le="\+Inf"\} \d+/);
    expect(body).toMatch(/http_request_duration_ms_sum \d+/);
    expect(body).toMatch(/http_request_duration_ms_count \d+/);

    // Error rate (counter)
    expect(body).toContain('# TYPE http_errors_total counter');
    expect(body).toMatch(/http_errors_total\{range="4xx"\} 1/);
    expect(body).toMatch(/http_errors_total\{range="5xx"\} 1/);

    // Injected indexer gauge
    expect(body).toContain('# TYPE indexer_ledger_lag gauge');
    expect(body).toMatch(/indexer_ledger_lag 7/);
  });

  it('produces a well-formed histogram whose +Inf bucket equals the total count', async () => {
    const app = buildApp();
    await request(app).get('/ok');
    await request(app).get('/ok');
    await request(app).get('/ok');

    const body = (await request(app).get('/metrics')).text;
    const inf = body.match(/http_request_duration_ms_bucket\{le="\+Inf"\} (\d+)/);
    const count = body.match(/http_request_duration_ms_count (\d+)/);
    expect(inf).not.toBeNull();
    expect(count).not.toBeNull();
    expect(inf![1]).toBe(count![1]); // +Inf bucket == observation count
    expect(Number(count![1])).toBe(3); // exactly the three /ok requests observed
    expect(body.endsWith('\n')).toBe(true);
  });

  it('still serves the endpoint (empty series) when no traffic has been recorded', async () => {
    const body = (await request(buildApp()).get('/metrics')).text;
    // Families are always declared even with zero observations.
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('# TYPE http_request_duration_ms histogram');
    expect(body).toMatch(/http_errors_total\{range="4xx"\} 0/);
    expect(body).toMatch(/http_request_duration_ms_count 0/);
  });
});
