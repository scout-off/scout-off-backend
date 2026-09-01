/**
 * Table-driven tests for production vs staging config validation.
 *
 * These tests pin the exact error messages for critical startup guards.
 * Each variable is tested with:
 *   - NODE_ENV=production + unset → must throw with documented message
 *   - NODE_ENV=staging + unset   → must warn (via console.warn), not throw
 *   - NODE_ENV=development/test + unset → tolerated (fallbacks apply)
 *
 * A regression that downgrades a production throw to a warning would be
 * caught immediately, protecting against misconfigured production deploys.
 *
 * Key: the exact error messages must be preserved; refactoring that changes
 * wording would break the tests and force deliberate review of the change.
 */

// Silence console.warn during tests so we can inspect the warnings
const originalWarn = console.warn;
let capturedWarnings: string[] = [];

beforeEach(() => {
  capturedWarnings = [];
  console.warn = jest.fn((msg: string) => {
    capturedWarnings.push(msg);
  });
});

afterEach(() => {
  console.warn = originalWarn;
  jest.resetModules();
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Load config in isolation, clearing all prior module cache.
 * Pre-sets the required env vars unless explicitly testing their absence.
 */
async function loadConfigWithEnv(opts: {
  nodeEnv: string;
  adminWallet?: string;
  sep10ServerSecret?: string;
  apiKeyLookupSecret?: string;
  platformSecretKey?: string;
  jwtSecret?: string;
}): Promise<any> {
  // Set required base vars
  process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  process.env.NODE_ENV = opts.nodeEnv;

  // Set each optional var only if provided, otherwise unset it
  if (opts.adminWallet !== undefined) {
    process.env.ADMIN_WALLET = opts.adminWallet;
  } else {
    delete process.env.ADMIN_WALLET;
  }

  if (opts.sep10ServerSecret !== undefined) {
    process.env.SEP10_SERVER_SECRET = opts.sep10ServerSecret;
  } else {
    delete process.env.SEP10_SERVER_SECRET;
  }

  if (opts.apiKeyLookupSecret !== undefined) {
    process.env.API_KEY_LOOKUP_SECRET = opts.apiKeyLookupSecret;
  } else {
    delete process.env.API_KEY_LOOKUP_SECRET;
  }

  if (opts.platformSecretKey !== undefined) {
    process.env.PLATFORM_SECRET_KEY = opts.platformSecretKey;
  } else {
    delete process.env.PLATFORM_SECRET_KEY;
  }

  if (opts.jwtSecret !== undefined) {
    process.env.JWT_SECRET = opts.jwtSecret;
  } else {
    delete process.env.JWT_SECRET;
  }

  // Clear module cache and load fresh
  jest.resetModules();
  capturedWarnings = [];
  console.warn = jest.fn((msg: string) => {
    capturedWarnings.push(msg);
  });

  try {
    const mod = await import('../src/config');
    return { success: true, config: mod.default };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── ADMIN_WALLET tests ────────────────────────────────────────────────────────

describe('config validation: ADMIN_WALLET', () => {
  const VALID_WALLET = 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validSecret = 'a'.repeat(64);

  it('production: throws when ADMIN_WALLET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: undefined,
      platformSecretKey: 'SKEY1',
      sep10ServerSecret: 'SKEY2',
      apiKeyLookupSecret: validSecret,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ADMIN_WALLET is required in production but is not set');
    expect(result.error).toContain('Set the ADMIN_WALLET environment variable');
  });

  it('staging: warns (not throws) when ADMIN_WALLET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'staging',
      adminWallet: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.join('')).toContain('ADMIN_WALLET is not set in staging');
    expect(capturedWarnings.join('')).toContain('Admin-seeding will be disabled');
  });

  it('development: silently tolerates missing ADMIN_WALLET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'development',
      adminWallet: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0); // No warning
  });

  it('test: silently tolerates missing ADMIN_WALLET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'test',
      adminWallet: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0); // No warning
  });

  it('production: accepts a valid ADMIN_WALLET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      platformSecretKey: 'SKEY1',
      sep10ServerSecret: 'SKEY2',
      apiKeyLookupSecret: validSecret,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(result.config.adminWallet).toBe(VALID_WALLET);
  });
});

// ─── SEP10_SERVER_SECRET tests ─────────────────────────────────────────────────

describe('config validation: SEP10_SERVER_SECRET', () => {
  const VALID_WALLET = 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const VALID_SECRET = 'SSEP10SECRET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validSecret = 'a'.repeat(64);

  it('production: throws when SEP10_SERVER_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: undefined,
      platformSecretKey: 'SKEY1',
      apiKeyLookupSecret: validSecret,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SEP10_SERVER_SECRET is required in production');
    expect(result.error).toContain('stellar keys generate');
    expect(result.error).toContain('cross-instance');
  });

  it('staging: warns (not throws) when SEP10_SERVER_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'staging',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.join('')).toContain('SEP10_SERVER_SECRET is not set in staging');
    expect(capturedWarnings.join('')).toContain('ephemeral keypair');
  });

  it('development: silently tolerates missing SEP10_SERVER_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'development',
      sep10ServerSecret: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0);
  });

  it('test: silently tolerates missing SEP10_SERVER_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'test',
      sep10ServerSecret: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0);
  });

  it('production: accepts a valid SEP10_SERVER_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      platformSecretKey: 'SKEY1',
      apiKeyLookupSecret: validSecret,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(result.config.sep10ServerSecret).toBe(VALID_SECRET);
  });
});

// ─── API_KEY_LOOKUP_SECRET tests ──────────────────────────────────────────────

describe('config validation: API_KEY_LOOKUP_SECRET', () => {
  const VALID_WALLET = 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const VALID_SECRET = 'SSEP10SECRET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validSecret = 'a'.repeat(64);

  it('production: throws when API_KEY_LOOKUP_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      apiKeyLookupSecret: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API_KEY_LOOKUP_SECRET is required in production');
    expect(result.error).toContain('openssl rand -hex 32');
    expect(result.error).toContain('load balancer');
    expect(result.error).toContain('docs/auth.md');
  });

  it('staging: warns (not throws) when API_KEY_LOOKUP_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'staging',
      adminWallet: VALID_WALLET,
      apiKeyLookupSecret: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.join('')).toContain('API_KEY_LOOKUP_SECRET is not set in staging');
    expect(capturedWarnings.join('')).toContain('insecure development-only pepper');
  });

  it('development: silently tolerates missing API_KEY_LOOKUP_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'development',
      apiKeyLookupSecret: undefined,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0);
  });

  it('test: silently tolerates missing API_KEY_LOOKUP_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'test',
      apiKeyLookupSecret: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0);
  });

  it('production: accepts a valid API_KEY_LOOKUP_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      apiKeyLookupSecret: validSecret,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(result.config.apiKeyLookupSecret).toBe(validSecret);
  });
});

// ─── PLATFORM_SECRET_KEY tests ────────────────────────────────────────────────

describe('config validation: PLATFORM_SECRET_KEY', () => {
  const VALID_WALLET = 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const VALID_SECRET = 'SSEP10SECRET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validSecret = 'a'.repeat(64);

  it('production: throws when PLATFORM_SECRET_KEY is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      apiKeyLookupSecret: validSecret,
      platformSecretKey: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PLATFORM_SECRET_KEY is required in non-test environments');
  });

  it('staging: throws when PLATFORM_SECRET_KEY is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'staging',
      adminWallet: VALID_WALLET,
      platformSecretKey: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PLATFORM_SECRET_KEY is required in non-test environments');
  });

  it('development: throws when PLATFORM_SECRET_KEY is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'development',
      platformSecretKey: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PLATFORM_SECRET_KEY is required in non-test environments');
  });

  it('test: silently tolerates missing PLATFORM_SECRET_KEY', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'test',
      platformSecretKey: undefined,
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(capturedWarnings.length).toBe(0);
  });

  it('production: accepts a valid PLATFORM_SECRET_KEY', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      apiKeyLookupSecret: validSecret,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(result.config.platformSecretKey).toBe('SKEY1');
  });
});

// ─── JWT_SECRET tests ─────────────────────────────────────────────────────────

describe('config validation: JWT_SECRET', () => {
  const VALID_WALLET = 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const VALID_SECRET = 'SSEP10SECRET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validSecret = 'a'.repeat(64);

  it('production: throws when JWT_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      apiKeyLookupSecret: validSecret,
      platformSecretKey: 'SKEY1',
      jwtSecret: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('JWT_SECRET is required');
  });

  it('staging: throws when JWT_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'staging',
      adminWallet: VALID_WALLET,
      platformSecretKey: 'SKEY1',
      jwtSecret: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('JWT_SECRET is required');
  });

  it('development: throws when JWT_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'development',
      platformSecretKey: 'SKEY1',
      jwtSecret: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('JWT_SECRET is required');
  });

  it('test: throws when JWT_SECRET is unset', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'test',
      jwtSecret: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('JWT_SECRET is required');
  });

  it('production: accepts a valid JWT_SECRET', async () => {
    const result = await loadConfigWithEnv({
      nodeEnv: 'production',
      adminWallet: VALID_WALLET,
      sep10ServerSecret: VALID_SECRET,
      apiKeyLookupSecret: validSecret,
      platformSecretKey: 'SKEY1',
      jwtSecret: 'my-jwt-secret',
    });

    expect(result.success).toBe(true);
    expect(result.config.jwtSecret).toBe('my-jwt-secret');
  });
});
