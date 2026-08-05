process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = 'test-secret';

describe('config NODE_ENV toggles', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalAdminWallet = process.env.ADMIN_WALLET;
  const originalPlatformSecretKey = process.env.PLATFORM_SECRET_KEY;
  const originalSep10ServerSecret = process.env.SEP10_SERVER_SECRET;

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

  it('throws mentioning CONTRACT_ID when CONTRACT_ID is not set', async () => {
    delete process.env.CONTRACT_ID;
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow('CONTRACT_ID');
  });

  it('throws mentioning JWT_SECRET when JWT_SECRET is not set', async () => {
    delete process.env.JWT_SECRET;
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow('JWT_SECRET');
  });

  it('error message clearly identifies the missing CONTRACT_ID variable', async () => {
    delete process.env.CONTRACT_ID;
    jest.resetModules();
    let message = '';
    try {
      await import('../src/config');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('CONTRACT_ID');
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
