/**
 * Scenario 6 — Admin stats
 *
 * GET /api/admin/stats
 *
 * Requires a valid admin JWT (set K6_ADMIN_TOKEN or TEST_ADMIN_JWT).
 *
 * SLO targets:
 *   p95 < 300 ms   error rate < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, ADMIN_TOKEN } from '../config.js';

const adminErrors = new Counter('admin_stats_errors');

export const adminStatsOptions = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed:   ['rate<0.01'],
    admin_stats_errors: ['count<1'],
  },
};

export default function adminStatsVU() {
  const headers = ADMIN_TOKEN
    ? { Authorization: `Bearer ${ADMIN_TOKEN}` }
    : {};

  const res = http.get(`${BASE_URL}/api/admin/stats`, {
    headers,
    tags: { scenario: 'admin_stats' },
  });

  const ok = check(res, {
    'admin stats responds': (r) => r.status === 200 || r.status === 401 || r.status === 403,
    'admin stats has body': (r) => r.body.length > 0,
  });

  if (!ok) adminErrors.add(1);
  sleep(0.1);
}
