/**
 * scripts/k6/config.js
 *
 * Shared configuration for the ScoutOff k6 load-test suite.
 *
 * Environment variables (all optional — sensible defaults provided):
 *   K6_BASE_URL       Base URL of the server under test (default: http://localhost:4000)
 *   K6_ADMIN_TOKEN    Pre-generated admin JWT (default: uses TEST_ADMIN_JWT env var)
 *   K6_SCOUT_TOKEN    Pre-generated scout JWT (default: uses TEST_SCOUT_JWT env var)
 *   K6_PLAYER_ID      Player ID used for single-player profile tests (default: seed-player-001)
 *   K6_SCOUT_WALLET   Scout wallet used for subscription-status tests
 */

export const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:4000';

// Pre-generated test JWTs — never use real SEP-10 signed tokens in CI.
// Generate these with: node scripts/generate-test-jwt.js --role admin
export const ADMIN_TOKEN = __ENV.K6_ADMIN_TOKEN || __ENV.TEST_ADMIN_JWT || '';
export const SCOUT_TOKEN = __ENV.K6_SCOUT_TOKEN || __ENV.TEST_SCOUT_JWT || '';

export const PLAYER_ID   = __ENV.K6_PLAYER_ID    || 'seed-player-001';
export const SCOUT_WALLET = __ENV.K6_SCOUT_WALLET || 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZL8AM5KST7NKJVDKZUZ';

/** Abort the entire test run if the server is unreachable. */
export function requireServer() {
  // k6 does not support arbitrary Node-style requests at init time,
  // so we rely on the scenario executor to surface errors naturally.
}
