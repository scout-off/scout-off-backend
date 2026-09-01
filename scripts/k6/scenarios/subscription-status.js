/**
 * Scenario 4 — Subscription status check
 *
 * GET /api/scouts/:wallet/subscription
 *
 * Requires a valid scout JWT (set K6_SCOUT_TOKEN or TEST_SCOUT_JWT).
 *
 * SLO targets:
 *   p95 < 150 ms   error rate < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, SCOUT_TOKEN, SCOUT_WALLET } from '../config.js';

const subErrors = new Counter('subscription_errors');

export const subscriptionStatusOptions = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_duration:  ['p(95)<150'],
    http_req_failed:    ['rate<0.01'],
    subscription_errors: ['count<1'],
  },
};

export default function subscriptionStatusVU() {
  const headers = SCOUT_TOKEN
    ? { Authorization: `Bearer ${SCOUT_TOKEN}` }
    : {};

  const res = http.get(
    `${BASE_URL}/api/scouts/${SCOUT_WALLET}/subscription`,
    { headers, tags: { scenario: 'subscription_status' } },
  );

  const ok = check(res, {
    'subscription status responds': (r) =>
      r.status === 200 || r.status === 401 || r.status === 404,
    'subscription has body': (r) => r.body.length > 0,
  });

  if (!ok) subErrors.add(1);
  sleep(0.05);
}
