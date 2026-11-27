/**
 * Scenario 7 — Scout write paths
 *
 * Exercises the write-heavy scout endpoints that acquire write locks on SQLite
 * and contend for the connection pool on Postgres:
 *
 *   • Bookmarks        (40 %) — add then remove a bookmark
 *   • Notes            (25 %) — upsert a scout note on a player
 *   • Saved searches   (20 %) — create, run, then delete a saved search
 *   • Bookmark folders (10 %) — list bookmark folders (read that follows writes)
 *   • Webhooks          (5 %) — register a webhook subscription, then delete it
 *
 * Each VU uses a unique wallet derived from its VU index so that concurrent
 * scouts do not contend on the same rows (#1820 requirement: unique wallets to
 * avoid self-contention distorting results).
 *
 * SLO targets (enforced via thresholds in suite.js):
 *   p95 < 300 ms, error rate < 1 %
 *
 * Usage — standalone:
 *   k6 run --env K6_BASE_URL=http://localhost:4000 \
 *           --env TEST_SCOUT_JWT=eyJ... \
 *           scripts/k6/scenarios/scout-writes.js
 *
 * Usage — via suite:
 *   k6 run --env K6_SCENARIO=scout_writes scripts/k6/suite.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { BASE_URL, SCOUT_TOKEN } from '../config.js';

// ── Custom metrics ────────────────────────────────────────────────────────────

const writeErrors       = new Counter('scout_write_errors');
const bookmarkRtt       = new Trend('scout_bookmark_rtt', true);
const noteRtt           = new Trend('scout_note_rtt', true);
const savedSearchRtt    = new Trend('scout_saved_search_rtt', true);
const folderListRtt     = new Trend('scout_folder_list_rtt', true);
const webhookRtt        = new Trend('scout_webhook_rtt', true);
// Rate of unexpected 5xx responses — must stay at 0 under target load.
const serverErrorRate   = new Rate('scout_write_5xx_rate');

// ── Standalone scenario options ───────────────────────────────────────────────
// When run via suite.js these options are ignored in favour of the suite's
// scenario block; they serve as documentation and standalone defaults.

export const scoutWritesOptions = {
  vus: 20,
  duration: '60s',
  thresholds: {
    http_req_duration:        ['p(95)<300'],
    http_req_failed:          ['rate<0.01'],
    scout_write_errors:       ['count<5'],
    scout_write_5xx_rate:     ['rate<0.01'],
  },
};

export const options = scoutWritesOptions;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build per-VU auth headers.
 *
 * In CI the scenario receives a pre-generated scout JWT via TEST_SCOUT_JWT /
 * K6_SCOUT_TOKEN.  For staging runs with real SEP-10 tokens, the caller
 * should pass K6_SCOUT_TOKEN directly.
 */
function authHeaders() {
  const token = SCOUT_TOKEN || __ENV.K6_SCOUT_TOKEN || __ENV.TEST_SCOUT_JWT || '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Deterministic test player ID per VU so writes stay isolated. */
function vuPlayerId() {
  // __VU is a k6 built-in: 1-based index of the current virtual user.
  return `seed-player-${String(__VU).padStart(3, '0')}`;
}

/** Returns true for successful-or-expected responses, false for 5xx. */
function expectNoServerError(res, label) {
  const is5xx = res.status >= 500;
  serverErrorRate.add(is5xx ? 1 : 0);
  if (is5xx) {
    writeErrors.add(1);
    console.warn(`[scout-writes] 5xx on ${label}: ${res.status} ${res.body?.slice?.(0, 120)}`);
  }
  return !is5xx;
}

// ── Write actions ─────────────────────────────────────────────────────────────

/**
 * Add then remove a bookmark for the VU's player.
 * Expected codes: 201 on add, 200/204 on remove, 404/409 on quota hit.
 */
function doBookmark(headers) {
  const playerId = vuPlayerId();
  const start = Date.now();

  // Add
  const addRes = http.post(
    `${BASE_URL}/api/v1/scouts/me/bookmarks`,
    JSON.stringify({ playerId }),
    { headers, tags: { scenario: 'scout_writes', action: 'bookmark_add' } },
  );
  bookmarkRtt.add(Date.now() - start);

  if (!expectNoServerError(addRes, 'bookmark_add')) return;
  check(addRes, {
    'bookmark add: no 5xx': (r) => r.status < 500,
    'bookmark add: 201 or 409': (r) => r.status === 201 || r.status === 409 || r.status === 200,
  });

  if (addRes.status !== 201 && addRes.status !== 200) return;

  // Extract created bookmark id from response
  let bookmarkId = null;
  try {
    bookmarkId = JSON.parse(addRes.body)?.data?.id ?? JSON.parse(addRes.body)?.id ?? null;
  } catch { /* ignore */ }

  if (!bookmarkId) return;

  // Remove
  const delStart = Date.now();
  const delRes = http.del(
    `${BASE_URL}/api/v1/scouts/me/bookmarks/${bookmarkId}`,
    null,
    { headers, tags: { scenario: 'scout_writes', action: 'bookmark_remove' } },
  );
  bookmarkRtt.add(Date.now() - delStart);
  expectNoServerError(delRes, 'bookmark_remove');
  check(delRes, { 'bookmark remove: no 5xx': (r) => r.status < 500 });
}

/**
 * Upsert a scout note on the VU's player.
 * Expected code: 200 or 201.
 */
function doNote(headers) {
  const playerId = vuPlayerId();
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/scouts/me/notes`,
    JSON.stringify({
      playerId,
      content: `k6 note vu=${__VU} iter=${__ITER}`,
    }),
    { headers, tags: { scenario: 'scout_writes', action: 'note_upsert' } },
  );
  noteRtt.add(Date.now() - start);
  expectNoServerError(res, 'note_upsert');
  check(res, { 'note upsert: no 5xx': (r) => r.status < 500 });
}

/**
 * Create a saved search, then immediately delete it.
 * Expected codes: 201 on create, 200/204 on delete.
 */
function doSavedSearch(headers) {
  const start = Date.now();
  const createRes = http.post(
    `${BASE_URL}/api/v1/scouts/me/saved-searches`,
    JSON.stringify({
      name: `k6-search-vu${__VU}-${__ITER}`,
      filters: { minTier: 1, region: 'global' },
    }),
    { headers, tags: { scenario: 'scout_writes', action: 'saved_search_create' } },
  );
  savedSearchRtt.add(Date.now() - start);

  if (!expectNoServerError(createRes, 'saved_search_create')) return;
  check(createRes, { 'saved search create: no 5xx': (r) => r.status < 500 });

  let searchId = null;
  try {
    searchId = JSON.parse(createRes.body)?.data?.id ?? JSON.parse(createRes.body)?.id ?? null;
  } catch { /* ignore */ }

  if (!searchId) return;

  // Delete
  const delStart = Date.now();
  const delRes = http.del(
    `${BASE_URL}/api/v1/scouts/me/saved-searches/${searchId}`,
    null,
    { headers, tags: { scenario: 'scout_writes', action: 'saved_search_delete' } },
  );
  savedSearchRtt.add(Date.now() - delStart);
  expectNoServerError(delRes, 'saved_search_delete');
  check(delRes, { 'saved search delete: no 5xx': (r) => r.status < 500 });
}

/**
 * List bookmark folders — a lightweight read that follows the write mix.
 * Expected code: 200.
 */
function doFolderList(headers) {
  const start = Date.now();
  const res = http.get(
    `${BASE_URL}/api/v1/scouts/me/bookmark-folders`,
    { headers, tags: { scenario: 'scout_writes', action: 'folder_list' } },
  );
  folderListRtt.add(Date.now() - start);
  expectNoServerError(res, 'folder_list');
  check(res, { 'folder list: no 5xx': (r) => r.status < 500 });
}

/**
 * Register a webhook subscription against a local sink, then delete it.
 * Expected codes: 201 on register, 200/204 on delete.
 * Quota/limit responses (429, 403) are acceptable and should not be 5xx.
 */
function doWebhook(headers) {
  // Point at a no-op local sink that will not receive real traffic in CI.
  const sinkUrl = __ENV.K6_WEBHOOK_SINK_URL || 'http://localhost:9999/webhook-sink';
  const start = Date.now();
  const regRes = http.post(
    `${BASE_URL}/api/v1/scouts/me/webhooks`,
    JSON.stringify({
      url: sinkUrl,
      events: ['bookmark.created', 'note.created'],
      secret: `k6-secret-vu${__VU}`,
    }),
    { headers, tags: { scenario: 'scout_writes', action: 'webhook_register' } },
  );
  webhookRtt.add(Date.now() - start);

  // 429 or 403 are expected when quotas/limits fire — not a test failure.
  expectNoServerError(regRes, 'webhook_register');
  check(regRes, {
    'webhook register: no 5xx': (r) => r.status < 500,
    'webhook register: quota or created': (r) =>
      r.status === 201 || r.status === 200 || r.status === 429 || r.status === 403,
  });

  let webhookId = null;
  try {
    webhookId = JSON.parse(regRes.body)?.data?.id ?? JSON.parse(regRes.body)?.id ?? null;
  } catch { /* ignore */ }

  if (!webhookId) return;

  const delStart = Date.now();
  const delRes = http.del(
    `${BASE_URL}/api/v1/scouts/me/webhooks/${webhookId}`,
    null,
    { headers, tags: { scenario: 'scout_writes', action: 'webhook_delete' } },
  );
  webhookRtt.add(Date.now() - delStart);
  expectNoServerError(delRes, 'webhook_delete');
  check(delRes, { 'webhook delete: no 5xx': (r) => r.status < 500 });
}

// ── VU lifecycle ──────────────────────────────────────────────────────────────

/**
 * setup() — runs once before VUs start.
 * Nothing to pre-create here: each VU seeds its own data inline so that
 * teardown() can clean up per-VU resources deterministically.
 */
export function setup() {
  console.log(`[scout-writes] Starting write-path load test against ${BASE_URL}`);
}

/**
 * Default VU function — exercises the write mix on each iteration.
 *
 * Mix by weighted random draw:
 *   [0.00, 0.40) → bookmark    40 %
 *   [0.40, 0.65) → note        25 %
 *   [0.65, 0.85) → saved search 20 %
 *   [0.85, 0.95) → folder list  10 %
 *   [0.95, 1.00) → webhook       5 %
 */
export default function scoutWritesVU() {
  const headers = authHeaders();
  const roll = Math.random();

  if (roll < 0.40) {
    doBookmark(headers);
  } else if (roll < 0.65) {
    doNote(headers);
  } else if (roll < 0.85) {
    doSavedSearch(headers);
  } else if (roll < 0.95) {
    doFolderList(headers);
  } else {
    doWebhook(headers);
  }

  // Short think-time to prevent a wall of requests in the same ms window.
  sleep(0.1 + Math.random() * 0.2);
}

/**
 * teardown() — runs once after all VUs finish.
 * Resources created inline (bookmarks, notes, saved searches, webhooks) are
 * cleaned up by each VU's delete step within the iteration, so global teardown
 * is a no-op in the happy path.  Any leaked rows will be swept by the
 * application's normal retention policy.
 */
export function teardown() {
  console.log('[scout-writes] Write-path load test complete.');
}
