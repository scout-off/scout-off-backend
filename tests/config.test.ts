process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = 'test-secret';

describe('config NODE_ENV toggles', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalAdminWallet = process.env.ADMIN_WALLET;
  const originalPlatformSecretKey = process.env.PLATFORM_SECRET_KEY;
  const originalSep10ServerSecret = process.env.SEP10_SERVER_SECRET;
  const originalApiKeyLookupSecret = process.env.API_KEY_LOOKUP_SECRET;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalAdminWallet !== undefined) {
      process.env.ADMIN_WALLET = originalAdminWallet;
    } else {
      delete process.env.ADMIN_WALLET;
    }
    if (originalPlatformSecretKey !== undefined) {
      process.env.PLATFORM_SECRET_KEY = originalPlatformSecretKey;
    } else {
      delete process.env.PLATFORM_SECRET_KEY;
    }
    if (originalSep10ServerSecret !== undefined) {
      process.env.SEP10_SERVER_SECRET = originalSep10ServerSecret;
    } else {
      delete process.env.SEP10_SERVER_SECRET;
    }
    if (originalApiKeyLookupSecret !== undefined) {
      process.env.API_KEY_LOOKUP_SECRET = originalApiKeyLookupSecret;
    } else {
      delete process.env.API_KEY_LOOKUP_SECRET;
    }
    jest.resetModules();
  });

  async function loadConfig(env: string) {
    process.env.NODE_ENV = env;
    // Ensure ADMIN_WALLET is set when loading production/staging config
    if (env === 'production' || env === 'staging') {
      process.env.ADMIN_WALLET = 'GADMINWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }
    // PLATFORM_SECRET_KEY is required in every non-test environment
    if (env !== 'test') {
      process.env.PLATFORM_SECRET_KEY = 'SPLATFORMSECRETKEY1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }
    // SEP10_SERVER_SECRET is required in production
    if (env === 'production') {
      process.env.SEP10_SERVER_SECRET = 'SSEP10SERVERSECRET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      // API_KEY_LOOKUP_SECRET is required in production (#1033)
      process.env.API_KEY_LOOKUP_SECRET = 'a'.repeat(64);
    }
    jest.resetModules();
    const mod = await import('../src/config');
    return mod.default;
  }

  async function loadHelpers(env: string) {
    process.env.NODE_ENV = env;
    if (env === 'production' || env === 'staging') {
      process.env.ADMIN_WALLET = 'GADMINWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }
    if (env !== 'test') {
      process.env.PLATFORM_SECRET_KEY = 'SPLATFORMSECRETKEY1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }
    if (env === 'production') {
      process.env.SEP10_SERVER_SECRET = 'SSEP10SERVERSECRET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      // API_KEY_LOOKUP_SECRET is required in production (#1033)
      process.env.API_KEY_LOOKUP_SECRET = 'a'.repeat(64);
    }
    jest.resetModules();
    return import('../src/config');
  }

  it('development: debug log, showErrorDetails=true, useMockServices=true', async () => {
    const cfg = await loadConfig('development');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.showErrorDetails).toBe(true);
    expect(cfg.useMockServices).toBe(true);
  });

  it('test: warn log, showErrorDetails=true, useMockServices=true', async () => {
    const cfg = await loadConfig('test');
    expect(cfg.logLevel).toBe('warn');
    expect(cfg.showErrorDetails).toBe(true);
    expect(cfg.useMockServices).toBe(true);
  });

  it('staging: info log, showErrorDetails=false, useMockServices=false', async () => {
    const cfg = await loadConfig('staging');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.showErrorDetails).toBe(false);
    expect(cfg.useMockServices).toBe(false);
  });

  it('production: warn log, showErrorDetails=false, useMockServices=false', async () => {
    const cfg = await loadConfig('production');
    expect(cfg.logLevel).toBe('warn');
    expect(cfg.showErrorDetails).toBe(false);
    expect(cfg.useMockServices).toBe(false);
  });

  it('staging and production settings are distinct from development', async () => {
    const dev = await loadConfig('development');
    const prod = await loadConfig('production');
    expect(dev.showErrorDetails).not.toBe(prod.showErrorDetails);
    expect(dev.useMockServices).not.toBe(prod.useMockServices);
  });

  it('isProduction() returns true for production', async () => {
    const { isProduction } = await loadHelpers('production');
    expect(isProduction()).toBe(true);
  });

  it('isStaging() returns true for staging', async () => {
    const { isStaging } = await loadHelpers('staging');
    expect(isStaging()).toBe(true);
  });

  it('isDevelopment() returns true for development', async () => {
    const { isDevelopment } = await loadHelpers('development');
    expect(isDevelopment()).toBe(true);
  });

  it('throws on invalid NODE_ENV', async () => {
    process.env.NODE_ENV = 'invalid_env';
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow('Invalid NODE_ENV');
  });
});

describe('config required env vars', () => {
  const savedContractId = process.env.CONTRACT_ID;
  const savedJwtSecret = process.env.JWT_SECRET;
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.CONTRACT_ID = savedContractId;
    process.env.JWT_SECRET = savedJwtSecret;
    process.env.NODE_ENV = savedNodeEnv;
    jest.resetModules();
  });

  // CONTRACT_ID is no longer required: the multi-contract architecture (#1016)
  // made each contract ID optional with a fallback chain (specific env var →
  // CONTRACT_ID → ''). Only JWT_SECRET remains a hard requirement.
  it('loads with empty contract IDs when CONTRACT_ID is not set', async () => {
    delete process.env.CONTRACT_ID;
    jest.resetModules();
    const mod = await import('../src/config');
    expect(mod.default.contractId).toBe('');
    expect(mod.default.registerContractId).toBe('');
    expect(mod.default.progressContractId).toBe('');
    expect(mod.default.subscriptionContractId).toBe('');
    expect(mod.default.connectionContractId).toBe('');
  });

  it('throws mentioning JWT_SECRET when JWT_SECRET is not set', async () => {
    delete process.env.JWT_SECRET;
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow('JWT_SECRET');
  });

  it('error message clearly identifies the missing JWT_SECRET variable', async () => {
    delete process.env.JWT_SECRET;
    jest.resetModules();
    let message = '';
    try {
      await import('../src/config');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('JWT_SECRET');
  });

  it('does not throw when both CONTRACT_ID and JWT_SECRET are present', async () => {
    process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    process.env.JWT_SECRET = 'test-secret';
    jest.resetModules();
    await expect(import('../src/config')).resolves.toBeDefined();
  });
});

describe('config DB_DRIVER validation', () => {
  const savedDbDriver = process.env.DB_DRIVER;
  const savedContractId = process.env.CONTRACT_ID;
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (savedDbDriver !== undefined) {
      process.env.DB_DRIVER = savedDbDriver;
    } else {
      delete process.env.DB_DRIVER;
    }
    process.env.CONTRACT_ID = savedContractId;
    process.env.JWT_SECRET = savedJwtSecret;
    jest.resetModules();
  });

  it('accepts DB_DRIVER=sqlite without throwing', async () => {
    process.env.DB_DRIVER = 'sqlite';
    jest.resetModules();
    await expect(import('../src/config')).resolves.toBeDefined();
  });

  it('accepts DB_DRIVER=postgres without throwing', async () => {
    process.env.DB_DRIVER = 'postgres';
    jest.resetModules();
    await expect(import('../src/config')).resolves.toBeDefined();
  });

  it('throws on a typo like "Postgres" (wrong case)', async () => {
    process.env.DB_DRIVER = 'Postgres';
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow(/DB_DRIVER="Postgres" is invalid/);
  });

  it('throws on "postgresql" and names the valid values', async () => {
    process.env.DB_DRIVER = 'postgresql';
    jest.resetModules();
    let message = '';
    try {
      await import('../src/config');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('postgresql');
    expect(message).toContain('sqlite');
    expect(message).toContain('postgres');
  });
});

describe('config PINATA_GATEWAY validation', () => {
  const savedPinataGateway = process.env.PINATA_GATEWAY;
  const savedContractId = process.env.CONTRACT_ID;
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (savedPinataGateway !== undefined) {
      process.env.PINATA_GATEWAY = savedPinataGateway;
    } else {
      delete process.env.PINATA_GATEWAY;
    }
    process.env.CONTRACT_ID = savedContractId;
    process.env.JWT_SECRET = savedJwtSecret;
    jest.resetModules();
  });

  it('accepts a valid HTTPS PINATA_GATEWAY without throwing', async () => {
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';
    jest.resetModules();
    await expect(import('../src/config')).resolves.toBeDefined();
  });

  it('accepts an unset PINATA_GATEWAY without throwing', async () => {
    delete process.env.PINATA_GATEWAY;
    jest.resetModules();
    await expect(import('../src/config')).resolves.toBeDefined();
  });

  it('throws on an HTTP (non-HTTPS) PINATA_GATEWAY', async () => {
    process.env.PINATA_GATEWAY = 'http://gateway.pinata.cloud';
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow(/Invalid PINATA_GATEWAY/);
  });

  it('throws on a malformed PINATA_GATEWAY URL', async () => {
    process.env.PINATA_GATEWAY = 'not-a-url';
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow(/Invalid PINATA_GATEWAY/);
  });
});

describe('config.pinata.gateways fallback', () => {
  const savedIpfsGateways = process.env.IPFS_GATEWAYS;
  const savedContractId = process.env.CONTRACT_ID;
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (savedIpfsGateways !== undefined) {
      process.env.IPFS_GATEWAYS = savedIpfsGateways;
    } else {
      delete process.env.IPFS_GATEWAYS;
    }
    process.env.CONTRACT_ID = savedContractId;
    process.env.JWT_SECRET = savedJwtSecret;
    jest.resetModules();
  });

  it('falls back to the three default gateways when IPFS_GATEWAYS is unset', async () => {
    delete process.env.IPFS_GATEWAYS;
    jest.resetModules();
    const { default: config } = await import('../src/config');
    expect(config.pinata.gateways).toEqual([
      'https://gateway.pinata.cloud',
      'https://cloudflare-ipfs.com',
      'https://ipfs.io',
    ]);
  });

  it('uses IPFS_GATEWAYS when set to a comma-separated list', async () => {
    process.env.IPFS_GATEWAYS = 'https://a.example.com, https://b.example.com';
    jest.resetModules();
    const { default: config } = await import('../src/config');
    expect(config.pinata.gateways).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });
});

describe('parseNumericEnv validation', () => {
  const savedEnv: Record<string, string | undefined> = {};

  const envVars = [
    'PORT',
    'PLATFORM_FEE_BPS',
    'ADMIN_THRESHOLD',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_MAX',
    'AUTH_RATE_LIMIT_WINDOW_MS',
    'AUTH_RATE_LIMIT_MAX',
    'PLAYER_IMPORT_RATE_LIMIT_WINDOW_MS',
    'PLAYER_IMPORT_RATE_LIMIT_MAX',
    'REQUEST_TIMEOUT_MS',
    'LOG_SAMPLE_RATE',
    'SUBSCRIPTION_GRACE_PERIOD_HOURS',
    'PLAYER_CACHE_TTL_MS',
    'JWT_ACCESS_TTL_SECONDS',
    'PLAYER_IMPORT_MAX_BATCH',
    'PIN_JSON_CACHE_TTL_MS',
    'EVIDENCE_MAX_BYTES',
    'ADMIN_ACTION_TTL_MS',
    'COMPRESSION_THRESHOLD',
  ];

  beforeEach(() => {
    // Snapshot all affected vars so we can restore them after each test
    for (const key of envVars) {
      savedEnv[key] = process.env[key];
    }
    // Ensure required env vars are set
    process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    for (const key of envVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    jest.resetModules();
  });

  async function loadConfig() {
    jest.resetModules();
    const mod = await import('../src/config');
    return mod.default;
  }

  async function expectThrowsContaining(substring: string) {
    jest.resetModules();
    let message = '';
    try {
      await import('../src/config');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(substring);
  }

  // ── PORT ────────────────────────────────────────────────────────────────────

  it('PORT: non-numeric string throws naming PORT', async () => {
    process.env.PORT = 'not-a-number';
    await expectThrowsContaining('PORT');
  });

  it('PORT: 99999 exceeds max (65535) and throws naming PORT', async () => {
    process.env.PORT = '99999';
    await expectThrowsContaining('PORT');
  });

  it('PORT: valid value 3000 loads without error', async () => {
    process.env.PORT = '3000';
    const cfg = await loadConfig();
    expect(cfg.port).toBe(3000);
  });

  it('PORT: 0 is valid (OS-assigned port)', async () => {
    process.env.PORT = '0';
    const cfg = await loadConfig();
    expect(cfg.port).toBe(0);
  });

  // ── PLATFORM_FEE_BPS ────────────────────────────────────────────────────────

  it('PLATFORM_FEE_BPS: non-numeric string throws naming PLATFORM_FEE_BPS', async () => {
    process.env.PLATFORM_FEE_BPS = 'not-a-number';
    await expectThrowsContaining('PLATFORM_FEE_BPS');
  });

  it('PLATFORM_FEE_BPS: 10001 exceeds max (10000) and throws naming PLATFORM_FEE_BPS', async () => {
    process.env.PLATFORM_FEE_BPS = '10001';
    await expectThrowsContaining('PLATFORM_FEE_BPS');
  });

  it('PLATFORM_FEE_BPS: valid value 250 loads without error', async () => {
    process.env.PLATFORM_FEE_BPS = '250';
    const cfg = await loadConfig();
    expect(cfg.platformFeeBps).toBe(250);
  });

  // ── ADMIN_THRESHOLD ─────────────────────────────────────────────────────────

  it('ADMIN_THRESHOLD: non-numeric string throws naming ADMIN_THRESHOLD', async () => {
    process.env.ADMIN_THRESHOLD = 'not-a-number';
    await expectThrowsContaining('ADMIN_THRESHOLD');
  });

  it('ADMIN_THRESHOLD: 0 is below min (1) and throws naming ADMIN_THRESHOLD', async () => {
    process.env.ADMIN_THRESHOLD = '0';
    await expectThrowsContaining('ADMIN_THRESHOLD');
  });

  it('ADMIN_THRESHOLD: valid value 2 loads without error', async () => {
    process.env.ADMIN_THRESHOLD = '2';
    const cfg = await loadConfig();
    expect(cfg.adminThreshold).toBe(2);
  });

  // ── JWT_ACCESS_TTL_SECONDS ───────────────────────────────────────────────────

  it('JWT_ACCESS_TTL_SECONDS: non-numeric string throws naming JWT_ACCESS_TTL_SECONDS', async () => {
    process.env.JWT_ACCESS_TTL_SECONDS = 'not-a-number';
    await expectThrowsContaining('JWT_ACCESS_TTL_SECONDS');
  });

  it('JWT_ACCESS_TTL_SECONDS: valid value 1800 loads without error', async () => {
    process.env.JWT_ACCESS_TTL_SECONDS = '1800';
    const cfg = await loadConfig();
    expect(cfg.jwtAccessTtlSeconds).toBe(1800);
  });

  it('JWT_ACCESS_TTL_SECONDS: 0 is below min (1) and throws naming JWT_ACCESS_TTL_SECONDS', async () => {
    process.env.JWT_ACCESS_TTL_SECONDS = '0';
    await expectThrowsContaining('JWT_ACCESS_TTL_SECONDS');
  });

  // ── PLAYER_CACHE_TTL_MS ──────────────────────────────────────────────────────

  it('PLAYER_CACHE_TTL_MS: non-numeric string throws naming PLAYER_CACHE_TTL_MS', async () => {
    process.env.PLAYER_CACHE_TTL_MS = 'not-a-number';
    await expectThrowsContaining('PLAYER_CACHE_TTL_MS');
  });

  it('PLAYER_CACHE_TTL_MS: valid value 30000 loads without error', async () => {
    process.env.PLAYER_CACHE_TTL_MS = '30000';
    const cfg = await loadConfig();
    expect(cfg.playerCacheTtlMs).toBe(30000);
  });

  it('PLAYER_CACHE_TTL_MS: 0 is valid (min is 0)', async () => {
    process.env.PLAYER_CACHE_TTL_MS = '0';
    const cfg = await loadConfig();
    expect(cfg.playerCacheTtlMs).toBe(0);
  });

  // ── REQUEST_TIMEOUT_MS ───────────────────────────────────────────────────────

  it('REQUEST_TIMEOUT_MS: non-numeric string throws naming REQUEST_TIMEOUT_MS', async () => {
    process.env.REQUEST_TIMEOUT_MS = 'not-a-number';
    await expectThrowsContaining('REQUEST_TIMEOUT_MS');
  });

  it('REQUEST_TIMEOUT_MS: valid value 5000 loads without error', async () => {
    process.env.REQUEST_TIMEOUT_MS = '5000';
    const cfg = await loadConfig();
    expect(cfg.requestTimeoutMs).toBe(5000);
  });

  it('REQUEST_TIMEOUT_MS: 0 is below min (1) and throws naming REQUEST_TIMEOUT_MS', async () => {
    process.env.REQUEST_TIMEOUT_MS = '0';
    await expectThrowsContaining('REQUEST_TIMEOUT_MS');
  });

  // ── LOG_SAMPLE_RATE ──────────────────────────────────────────────────────────

  it('LOG_SAMPLE_RATE: non-numeric string throws naming LOG_SAMPLE_RATE', async () => {
    process.env.LOG_SAMPLE_RATE = 'not-a-number';
    await expectThrowsContaining('LOG_SAMPLE_RATE');
  });

  it('LOG_SAMPLE_RATE: 1.5 exceeds max (1) and throws naming LOG_SAMPLE_RATE', async () => {
    process.env.LOG_SAMPLE_RATE = '1.5';
    await expectThrowsContaining('LOG_SAMPLE_RATE');
  });

  it('LOG_SAMPLE_RATE: valid value 0.5 loads without error', async () => {
    process.env.LOG_SAMPLE_RATE = '0.5';
    const cfg = await loadConfig();
    expect(cfg.requestLog.sampleRate).toBe(0.5);
  });

  // ── PLAYER_IMPORT_MAX_BATCH ──────────────────────────────────────────────────

  it('PLAYER_IMPORT_MAX_BATCH: non-numeric string throws naming PLAYER_IMPORT_MAX_BATCH', async () => {
    process.env.PLAYER_IMPORT_MAX_BATCH = 'not-a-number';
    await expectThrowsContaining('PLAYER_IMPORT_MAX_BATCH');
  });

  it('PLAYER_IMPORT_MAX_BATCH: valid value 100 loads without error', async () => {
    process.env.PLAYER_IMPORT_MAX_BATCH = '100';
    const cfg = await loadConfig();
    expect(cfg.playerImport.maxBatchSize).toBe(100);
  });

  it('PLAYER_IMPORT_MAX_BATCH: 0 is below min (1) and throws naming PLAYER_IMPORT_MAX_BATCH', async () => {
    process.env.PLAYER_IMPORT_MAX_BATCH = '0';
    await expectThrowsContaining('PLAYER_IMPORT_MAX_BATCH');
  });

  // ── PIN_JSON_CACHE_TTL_MS ────────────────────────────────────────────────────

  it('PIN_JSON_CACHE_TTL_MS: non-numeric string throws naming PIN_JSON_CACHE_TTL_MS', async () => {
    process.env.PIN_JSON_CACHE_TTL_MS = 'not-a-number';
    await expectThrowsContaining('PIN_JSON_CACHE_TTL_MS');
  });

  it('PIN_JSON_CACHE_TTL_MS: valid value 120000 loads without error', async () => {
    process.env.PIN_JSON_CACHE_TTL_MS = '120000';
    const cfg = await loadConfig();
    expect(cfg.pinJsonCacheTtlMs).toBe(120000);
  });

  it('PIN_JSON_CACHE_TTL_MS: 0 is valid (min is 0)', async () => {
    process.env.PIN_JSON_CACHE_TTL_MS = '0';
    const cfg = await loadConfig();
    expect(cfg.pinJsonCacheTtlMs).toBe(0);
  });

  // ── EVIDENCE_MAX_BYTES ───────────────────────────────────────────────────────

  it('EVIDENCE_MAX_BYTES: non-numeric string throws naming EVIDENCE_MAX_BYTES', async () => {
    process.env.EVIDENCE_MAX_BYTES = 'not-a-number';
    await expectThrowsContaining('EVIDENCE_MAX_BYTES');
  });

  it('EVIDENCE_MAX_BYTES: valid value 1048576 loads without error', async () => {
    process.env.EVIDENCE_MAX_BYTES = '1048576';
    const cfg = await loadConfig();
    expect(cfg.evidenceMaxBytes).toBe(1048576);
  });

  it('EVIDENCE_MAX_BYTES: 0 is below min (1) and throws naming EVIDENCE_MAX_BYTES', async () => {
    process.env.EVIDENCE_MAX_BYTES = '0';
    await expectThrowsContaining('EVIDENCE_MAX_BYTES');
  });

  // ── ADMIN_ACTION_TTL_MS ──────────────────────────────────────────────────────

  it('ADMIN_ACTION_TTL_MS: non-numeric string throws naming ADMIN_ACTION_TTL_MS', async () => {
    process.env.ADMIN_ACTION_TTL_MS = 'not-a-number';
    await expectThrowsContaining('ADMIN_ACTION_TTL_MS');
  });

  it('ADMIN_ACTION_TTL_MS: valid value 7200000 loads without error', async () => {
    process.env.ADMIN_ACTION_TTL_MS = '7200000';
    const cfg = await loadConfig();
    expect(cfg.adminActionTtlMs).toBe(7200000);
  });

  it('ADMIN_ACTION_TTL_MS: 0 is below min (1) and throws naming ADMIN_ACTION_TTL_MS', async () => {
    process.env.ADMIN_ACTION_TTL_MS = '0';
    await expectThrowsContaining('ADMIN_ACTION_TTL_MS');
  });

  // ── COMPRESSION_THRESHOLD ────────────────────────────────────────────────────

  it('COMPRESSION_THRESHOLD: non-numeric string throws naming COMPRESSION_THRESHOLD', async () => {
    process.env.COMPRESSION_THRESHOLD = 'not-a-number';
    await expectThrowsContaining('COMPRESSION_THRESHOLD');
  });

  it('COMPRESSION_THRESHOLD: valid value 2048 loads without error', async () => {
    process.env.COMPRESSION_THRESHOLD = '2048';
    const cfg = await loadConfig();
    expect(cfg.compressionThresholdBytes).toBe(2048);
  });

  it('COMPRESSION_THRESHOLD: 0 is below min (1) and throws naming COMPRESSION_THRESHOLD', async () => {
    process.env.COMPRESSION_THRESHOLD = '0';
    await expectThrowsContaining('COMPRESSION_THRESHOLD');
  });

  it('COMPRESSION_THRESHOLD_BYTES fallback is used when COMPRESSION_THRESHOLD is unset', async () => {
    delete process.env.COMPRESSION_THRESHOLD;
    process.env.COMPRESSION_THRESHOLD_BYTES = '512';
    const cfg = await loadConfig();
    expect(cfg.compressionThresholdBytes).toBe(512);
    delete process.env.COMPRESSION_THRESHOLD_BYTES;
  });
});
