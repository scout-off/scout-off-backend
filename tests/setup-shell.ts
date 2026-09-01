// Minimal env setup for shell-script integration tests (no SQLite DB init).
process.env.CONTRACT_ID =
  process.env.CONTRACT_ID ??
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
