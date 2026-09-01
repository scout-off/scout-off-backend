/**
 * Scenario 3 — Single player profile
 *
 * GET /api/players/:id
 *
 * Assumes a cache hit (Redis or in-process LRU) so the target is aggressive.
 *
 * SLO targets:
 *   p99 < 100 ms   error rate < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, PLAYER_ID } from '../config.js';

const profileErrors = new Counter('player_profile_errors');

export const playerProfileOptions = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_duration:   ['p(99)<100'],
    http_req_failed:     ['rate<0.01'],
    player_profile_errors: ['count<1'],
  },
};

export default function playerProfileVU() {
  const res = http.get(`${BASE_URL}/api/players/${PLAYER_ID}`, {
    tags: { scenario: 'player_profile' },
  });

  const ok = check(res, {
    'profile status 200 or 404': (r) => r.status === 200 || r.status === 404,
    'profile has success flag': (r) => {
      try { return typeof JSON.parse(r.body).success === 'boolean'; } catch { return false; }
    },
  });

  if (!ok) profileErrors.add(1);
  sleep(0.05);
}
