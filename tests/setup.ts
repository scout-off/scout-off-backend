// Set required env vars before any module is loaded in tests
process.env.CONTRACT_ID =
  process.env.CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.DB_PATH = process.env.DB_PATH ?? ':memory:';
// Use port 0 so each test file's server instance binds to a random
// available port, preventing EADDRINUSE conflicts across test suites.
process.env.PORT = process.env.PORT ?? '0';
// PostgreSQL defaults for tests — points to a non-existent local instance
// so tests that mock pg won't attempt real connections.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/scoutoff_test';
process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false';
process.env.DB_POOL_MIN = process.env.DB_POOL_MIN ?? '0';
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX ?? '2';
