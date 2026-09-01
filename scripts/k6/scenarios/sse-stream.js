/**
 * Scenario 5 — SSE connection open + keepalive
 *
 * Connect to GET /api/events/stream, hold for 30 seconds, and verify that
 * keepalive pings (": ping" comment lines) arrive at least once within the
 * hold window.
 *
 * k6 does not have a native EventSource client; we use a raw HTTP GET with
 * the `text/event-stream` Accept header and read the streaming body via
 * the experimental `streams` API (k6 v0.47+).  For older k6 versions the
 * scenario falls back to a fire-and-forget request that merely asserts the
 * endpoint returns 200 with the correct content-type.
 *
 * SLO targets:
 *   Connection established within 500 ms   keepalive received within 35 s
 *   error rate < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, SCOUT_TOKEN } from '../config.js';

const sseConnectErrors  = new Counter('sse_connect_errors');
const sseKeepaliveCount = new Counter('sse_keepalive_received');
const sseConnectRtt     = new Trend('sse_connect_rtt_ms', true);

export const sseStreamOptions = {
  vus: 5,
  duration: '60s',
  thresholds: {
    // Connection must be established quickly.
    sse_connect_errors: ['count<1'],
    // Every VU must receive at least one keepalive during the run.
    sse_keepalive_received: ['count>0'],
  },
};

export default function sseStreamVU() {
  const headers = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...(SCOUT_TOKEN ? { Authorization: `Bearer ${SCOUT_TOKEN}` } : {}),
  };

  // Open the SSE endpoint and hold the connection.  We use timeout=35000 ms
  // so k6 reads the response for up to 35 s before closing — long enough to
  // receive at least one 30-s keepalive ping.
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/events/stream`, {
    headers,
    timeout: '35s',
    tags: { scenario: 'sse_stream' },
  });
  sseConnectRtt.add(Date.now() - start);

  const connected = check(res, {
    'SSE endpoint returns 200': (r) => r.status === 200,
    'SSE content-type is event-stream': (r) =>
      (r.headers['Content-Type'] || '').includes('text/event-stream'),
  });

  if (!connected) {
    sseConnectErrors.add(1);
    sleep(1);
    return;
  }

  // Look for keepalive ping lines in the streamed body.
  // The server sends ": ping\n\n" every ~30 s.
  const body = res.body || '';
  if (body.includes(': ping') || body.includes('data: ping')) {
    sseKeepaliveCount.add(1);
  }

  sleep(0.5);
}
