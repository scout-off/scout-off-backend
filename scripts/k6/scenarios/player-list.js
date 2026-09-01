/**
 * Scenario 2 — Player list with filters
 *
 * GET /api/players?region=West+Africa&minTier=1
 *
 * SLO targets:
 *   50 virtual users   p95 < 200 ms   error rate < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from '../config.js';

const listErrors = new Counter('player_list_errors');

export const playerListOptions = {
  vus: 50,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed:   ['rate<0.01'],
    player_list_errors: ['count<1'],
  },
};

// Cycle through several realistic filter combinations to exercise the
// region/position/minTier indexes rather than hammering a single query.
const FILTER_SETS = [
  'region=West+Africa&minTier=1',
  'region=europe&minTier=0',
  'region=West+Africa&position=forward&minTier=2',
  'region=africa&position=midfielder&minTier=1',
  'minTier=0',
];

export default function playerListVU() {
  const filters = FILTER_SETS[Math.floor(Math.random() * FILTER_SETS.length)];
  const res = http.get(`${BASE_URL}/api/players?${filters}`, {
    tags: { scenario: 'player_list' },
  });

  const ok = check(res, {
    'player list status 200': (r) => r.status === 200,
    'player list has success flag': (r) => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
  });

  if (!ok) listErrors.add(1);
  sleep(0.05);
}
