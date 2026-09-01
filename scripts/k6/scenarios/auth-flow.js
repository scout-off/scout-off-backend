/**
 * Scenario 1 — Auth flow
 *
 * Exercises the full SEP-10 challenge/response token exchange:
 *   GET  /auth/challenge?account=<wallet>
 *   POST /auth/token  { transaction: <signed_xdr>, role: 'scout' }
 *
 * In CI, the transaction signing step uses pre-built test XDR that is not
 * actually validated against the Stellar network (test JWT mode).  For
 * a staging run with real SEP-10 validation, set K6_AUTH_XDR to a valid
 * base64 XDR signed by a test keypair.
 *
 * SLO targets (enforced via thresholds):
 *   p95 < 500 ms   error rate < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL } from '../config.js';

// ── Custom metrics ────────────────────────────────────────────────────────────

const authErrors   = new Counter('auth_errors');
const challengeRtt = new Trend('auth_challenge_rtt', true);
const tokenRtt     = new Trend('auth_token_rtt', true);

// ── Scenario options (exported for the suite entry-point to consume) ──────────

export const authFlowOptions = {
  vus: 10,
  duration: '30s',
  thresholds: {
    // Combined p95 across all requests in this scenario must be < 500 ms.
    http_req_duration: ['p(95)<500'],
    // Error rate must be < 1 %.
    http_req_failed: ['rate<0.01'],
    auth_errors: ['count<1'],
  },
};

// ── Default export — VU code ──────────────────────────────────────────────────

export default function authFlowVU() {
  // ── Step 1: request a SEP-10 challenge ────────────────────────────────────
  // Use a deterministic test wallet so the server can issue a stable challenge.
  const wallet = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZL8AM5KST7NKJVDKZUZ';
  const challengeStart = Date.now();
  const challengeRes = http.get(`${BASE_URL}/auth/challenge?account=${wallet}`, {
    tags: { scenario: 'auth_flow', step: 'challenge' },
  });
  challengeRtt.add(Date.now() - challengeStart);

  const challengeOk = check(challengeRes, {
    'challenge status is 200': (r) => r.status === 200,
    'challenge body has challenge field': (r) => {
      try { return !!JSON.parse(r.body).challenge; } catch { return false; }
    },
  });

  if (!challengeOk) {
    authErrors.add(1);
    sleep(0.5);
    return;
  }

  // ── Step 2: exchange a pre-signed test XDR for a JWT ─────────────────────
  // In CI this uses a fixed test XDR that the server accepts when
  // STELLAR_HEALTH_CHECK=false (test mode).  Replace K6_AUTH_XDR with a real
  // signed transaction for staging runs.
  const testXdr = __ENV.K6_AUTH_XDR || 'AAAAAA=='; // minimal placeholder
  const tokenStart = Date.now();
  const tokenRes = http.post(
    `${BASE_URL}/auth/token`,
    JSON.stringify({ transaction: testXdr, role: 'scout' }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { scenario: 'auth_flow', step: 'token' },
    },
  );
  tokenRtt.add(Date.now() - tokenStart);

  check(tokenRes, {
    'token endpoint responds': (r) => r.status === 200 || r.status === 401,
  });

  sleep(0.1);
}
