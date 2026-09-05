// Set required env vars before any module is loaded in tests
process.env.CONTRACT_ID =
  process.env.CONTRACT_ID ??
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
// Use an in-memory SQLite database for all tests.
//
// WHY :memory:?
//   • Each test run starts with a clean, empty database — no leftover rows
//     from previous runs can cause tests to interfere with each other.
//   • Tests are fast: no disk I/O, no file locking, no cleanup needed.
//   • The database is automatically destroyed when the process exits.
//
// IMPORTANT: never override DB_PATH to a real file path in your local
// environment when running tests.  Pointing tests at scout-off.db (or any
// other persistent file) will mix test data with development data, produce
// non-deterministic results, and may corrupt your local database.
process.env.DB_PATH = process.env.DB_PATH ?? ":memory:";
// Use port 0 so each test file's server instance binds to a random
// available port, preventing EADDRINUSE conflicts across test suites.
process.env.PORT = process.env.PORT ?? "0";
process.env.STELLAR_HEALTH_CHECK = "false";
// Default admin wallet for tests exercising admin-wallet-gated actions
// (pauseContract/unpauseContract/withdrawFeesController). Individual test
// files construct admin JWTs for this same wallet where needed. Must be set
// here (before src/config is first imported transitively via src/db below)
// since config.ts computes config.adminWallets once at module load time.
process.env.ADMIN_WALLET =
  process.env.ADMIN_WALLET ??
  "GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4";
// Deterministic 32-byte key for webhook secret encryption-at-rest (#686) so
// tests exercise the real AES-256-GCM path instead of the insecure dev-only
// fallback used when this var is unset outside production.
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY =
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??
  "0".repeat(63) + "1";
// Deterministic 32-byte hex pepper for api_keys.lookup_hash (#1033). Set here
// (before src/config is first imported) so tests exercise the real HMAC
// derivation instead of the insecure dev-only fallback, and so the suites that
// reload config with NODE_ENV=production do not trip the startup guard that
// requires this variable in production.
process.env.API_KEY_LOOKUP_SECRET =
  process.env.API_KEY_LOOKUP_SECRET ??
  "a".repeat(63) + "b";

// jest-circus (the default runner since Jest 27, sole runner in Jest 30)
// removed the global `fail()` helper that jest-jasmine2 provided. Several
// suites still call it. Restore a minimal equivalent.
if (typeof (globalThis as { fail?: unknown }).fail !== "function") {
  (globalThis as { fail?: (reason?: unknown) => never }).fail = (
    reason: unknown = "fail() was called",
  ): never => {
    throw reason instanceof Error
      ? reason
      : new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
  };
}

import { initDb } from "../src/db";

// initDb() is async (required to support DB_DRIVER=postgres's async
// connection setup) — this file runs as setupFilesAfterEnv rather than
// setupFiles specifically so that `beforeAll` (installed by the test
// framework) is available here to await it before any test in the file runs.
beforeAll(async () => {
  await initDb();
});
