/**
 * scripts/k6/suite.js — ScoutOff k6 load-test suite entry-point
 *
 * Runs all 6 scenarios as named k6 executors (ramping-vus style) so each
 * scenario runs concurrently with independent VU pools and threshold sets.
 *
 * Usage (local):
 *   k6 run scripts/k6/suite.js
 *
 * Usage (single scenario):
 *   k6 run scripts/k6/suite.js --env K6_SCENARIO=player_list
 *
 * Usage (CI against staging):
 *   K6_BASE_URL=https://staging.scoutoff.io \
 *   TEST_ADMIN_JWT=eyJ... TEST_SCOUT_JWT=eyJ... \
 *   k6 run scripts/k6/suite.js
 *
 * Environment variables — see scripts/k6/config.js for the full list.
 *
 * k6 exits with a non-zero code when any threshold is breached, making it
 * suitable as a CI gate (the loadtest.yml workflow checks the exit code).
 */

import authFlowVU          from './scenarios/auth-flow.js';
import playerListVU        from './scenarios/player-list.js';
import playerProfileVU     from './scenarios/player-profile.js';
import subscriptionStatusVU from './scenarios/subscription-status.js';
import sseStreamVU         from './scenarios/sse-stream.js';
import adminStatsVU        from './scenarios/admin-stats.js';

// Re-export each VU function under the name referenced by its scenario's `exec` field.
export const authFlow          = authFlowVU;
export const playerList        = playerListVU;
export const playerProfile     = playerProfileVU;
export const subscriptionStatus = subscriptionStatusVU;
export const sseStream         = sseStreamVU;
export const adminStats        = adminStatsVU;

// ── Scenario filter (optional) ───────────────────────────────────────────────

const SELECTED = __ENV.K6_SCENARIO || null;
function enabled(name) {
  return !SELECTED || SELECTED === name;
}

// ── Suite options ─────────────────────────────────────────────────────────────

export const options = {
  // Aggregate thresholds across all scenarios.
  thresholds: {
    // Global catch-all: no more than 1 % of all HTTP requests fail.
    http_req_failed: ['rate<0.01'],

    // Per-scenario SLO thresholds using k6's tagged metric syntax.
    // Format: 'metric_name{scenario:scenario_name}'
    ...(enabled('auth_flow') ? {
      'http_req_duration{scenario:auth_flow}': ['p(95)<500'],
      'http_req_failed{scenario:auth_flow}':   ['rate<0.01'],
      'auth_errors': ['count<1'],
    } : {}),
    ...(enabled('player_list') ? {
      'http_req_duration{scenario:player_list}': ['p(95)<200'],
      'http_req_failed{scenario:player_list}':   ['rate<0.01'],
      'player_list_errors': ['count<1'],
    } : {}),
    ...(enabled('player_profile') ? {
      'http_req_duration{scenario:player_profile}': ['p(99)<100'],
      'http_req_failed{scenario:player_profile}':   ['rate<0.01'],
      'player_profile_errors': ['count<1'],
    } : {}),
    ...(enabled('subscription_status') ? {
      'http_req_duration{scenario:subscription_status}': ['p(95)<150'],
      'http_req_failed{scenario:subscription_status}':   ['rate<0.01'],
      'subscription_errors': ['count<1'],
    } : {}),
    ...(enabled('sse_stream') ? {
      'sse_connect_errors':     ['count<1'],
      'sse_keepalive_received': ['count>0'],
    } : {}),
    ...(enabled('admin_stats') ? {
      'http_req_duration{scenario:admin_stats}': ['p(95)<300'],
      'http_req_failed{scenario:admin_stats}':   ['rate<0.01'],
      'admin_stats_errors': ['count<1'],
    } : {}),
  },

  scenarios: {
    // ── Scenario 1: Auth flow — p95 < 500 ms ─────────────────────────────
    ...(enabled('auth_flow') ? {
      auth_flow: {
        executor: 'constant-vus',
        exec: 'authFlow',
        vus: 10,
        duration: '30s',
        tags: { scenario: 'auth_flow' },
      },
    } : {}),

    // ── Scenario 2: Player list with filters — p95 < 200 ms ───────────────
    ...(enabled('player_list') ? {
      player_list: {
        executor: 'constant-vus',
        exec: 'playerList',
        vus: 50,
        duration: '30s',
        tags: { scenario: 'player_list' },
      },
    } : {}),

    // ── Scenario 3: Single player profile — p99 < 100 ms ──────────────────
    ...(enabled('player_profile') ? {
      player_profile: {
        executor: 'constant-vus',
        exec: 'playerProfile',
        vus: 20,
        duration: '30s',
        tags: { scenario: 'player_profile' },
      },
    } : {}),

    // ── Scenario 4: Subscription status check — p95 < 150 ms ──────────────
    ...(enabled('subscription_status') ? {
      subscription_status: {
        executor: 'constant-vus',
        exec: 'subscriptionStatus',
        vus: 20,
        duration: '30s',
        tags: { scenario: 'subscription_status' },
      },
    } : {}),

    // ── Scenario 5: SSE connection + keepalive ─────────────────────────────
    ...(enabled('sse_stream') ? {
      sse_stream: {
        executor: 'constant-vus',
        exec: 'sseStream',
        vus: 5,
        duration: '60s',
        tags: { scenario: 'sse_stream' },
      },
    } : {}),

    // ── Scenario 6: Admin stats — p95 < 300 ms ────────────────────────────
    ...(enabled('admin_stats') ? {
      admin_stats: {
        executor: 'constant-vus',
        exec: 'adminStats',
        vus: 5,
        duration: '30s',
        tags: { scenario: 'admin_stats' },
      },
    } : {}),
  },
};

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

export function setup() {
  console.log(`[k6] ScoutOff load test suite starting`);
  console.log(`[k6] Target: ${__ENV.K6_BASE_URL || 'http://localhost:4000'}`);
  if (SELECTED) console.log(`[k6] Running single scenario: ${SELECTED}`);
}

export function teardown() {
  console.log('[k6] Suite complete. Check threshold results above.');
}
