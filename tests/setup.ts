// Set required env vars before any module is loaded in tests
process.env.CONTRACT_ID =
  process.env.CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.DB_PATH = process.env.DB_PATH ?? ':memory:';
// Use port 0 so each test file's server instance binds to a random
// available port, preventing EADDRINUSE conflicts across test suites.
process.env.PORT = process.env.PORT ?? '0';
