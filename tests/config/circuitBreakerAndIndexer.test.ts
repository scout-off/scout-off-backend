import fs from 'fs';
import path from 'path';

/**
 * #1564 — circuit-breaker thresholds live in config and are validated there;
 * the breaker utilities read no environment variables.
 * #1568 — the indexer poll interval is config-driven instead of hard-coded.
 */

const BREAKER_KEYS = [
  'CIRCUIT_BREAKER_FAILURE_THRESHOLD',
  'CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
  'IPFS_BREAKER_FAILURE_THRESHOLD',
  'IPFS_BREAKER_RESET_TIMEOUT_MS',
];

const ENV_KEYS = [...BREAKER_KEYS, 'INDEXER_POLL_INTERVAL_MS'];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret';
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
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
  const mod = await import('../../src/config');
  return mod.default;
}

async function loadErrorMessage(): Promise<string> {
  jest.resetModules();
  try {
    await import('../../src/config');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('circuit breaker config (#1564)', () => {
  it('exposes validated default thresholds for both breakers', async () => {
    const config = await loadConfig();
    expect(config.circuitBreaker.default).toEqual({ failureThreshold: 5, resetTimeoutMs: 30000 });
    expect(config.circuitBreaker.ipfs).toEqual({ failureThreshold: 5, resetTimeoutMs: 30000 });
  });

  it('reads the Stellar breaker thresholds from the generic env vars', async () => {
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '2';
    process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = '45000';
    const config = await loadConfig();
    expect(config.circuitBreaker.default).toEqual({ failureThreshold: 2, resetTimeoutMs: 45000 });
  });

  it('reads the IPFS breaker thresholds from the IPFS env vars', async () => {
    process.env.IPFS_BREAKER_FAILURE_THRESHOLD = '3';
    process.env.IPFS_BREAKER_RESET_TIMEOUT_MS = '1500';
    const config = await loadConfig();
    expect(config.circuitBreaker.ipfs).toEqual({ failureThreshold: 3, resetTimeoutMs: 1500 });
  });

  it('rejects a failure threshold below 1 (would open/never open incorrectly)', async () => {
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '0';
    expect(await loadErrorMessage()).toContain('CIRCUIT_BREAKER_FAILURE_THRESHOLD');
  });

  it('rejects a non-numeric failure threshold', async () => {
    process.env.IPFS_BREAKER_FAILURE_THRESHOLD = 'many';
    expect(await loadErrorMessage()).toContain('IPFS_BREAKER_FAILURE_THRESHOLD');
  });

  it('rejects a reset timeout below 1000 ms', async () => {
    process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = '999';
    expect(await loadErrorMessage()).toContain('CIRCUIT_BREAKER_RESET_TIMEOUT_MS');
  });

  it('rejects an IPFS reset timeout below 1000 ms', async () => {
    process.env.IPFS_BREAKER_RESET_TIMEOUT_MS = '10';
    expect(await loadErrorMessage()).toContain('IPFS_BREAKER_RESET_TIMEOUT_MS');
  });

  it('the breaker utility itself reads no environment variables', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/utils/circuitBreaker.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/process\.env/);
  });

  it('constructs the IPFS breaker from config', async () => {
    process.env.IPFS_BREAKER_FAILURE_THRESHOLD = '4';
    process.env.IPFS_BREAKER_RESET_TIMEOUT_MS = '2500';
    jest.resetModules();
    const { ipfsBreaker } = await import('../../src/services/ipfs');
    const internals = ipfsBreaker as unknown as {
      failureThreshold: number;
      resetTimeoutMs: number;
    };
    expect(internals.failureThreshold).toBe(4);
    expect(internals.resetTimeoutMs).toBe(2500);
  });

  it('constructs the Stellar breaker from config', async () => {
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '6';
    process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = '20000';
    jest.resetModules();
    const { stellarBreaker } = await import('../../src/services/stellarCore');
    const internals = stellarBreaker as unknown as {
      config: { failureThreshold: number; resetTimeoutMs: number };
    };
    expect(internals.config.failureThreshold).toBe(6);
    expect(internals.config.resetTimeoutMs).toBe(20000);
  });
});

describe('indexer poll interval config (#1568)', () => {
  it('defaults to 5000 ms', async () => {
    const config = await loadConfig();
    expect(config.indexerPollIntervalMs).toBe(5000);
  });

  it('accepts a slower interval for staging/testnet', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '30000';
    const config = await loadConfig();
    expect(config.indexerPollIntervalMs).toBe(30000);
  });

  it('accepts the documented bounds (1000 and 300000)', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '1000';
    expect((await loadConfig()).indexerPollIntervalMs).toBe(1000);

    process.env.INDEXER_POLL_INTERVAL_MS = '300000';
    expect((await loadConfig()).indexerPollIntervalMs).toBe(300000);
  });

  it('rejects an interval below 1000 ms', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '999';
    expect(await loadErrorMessage()).toContain('INDEXER_POLL_INTERVAL_MS');
  });

  it('rejects an interval above 300000 ms', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '300001';
    expect(await loadErrorMessage()).toContain('INDEXER_POLL_INTERVAL_MS');
  });

  it('rejects a non-numeric interval', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = 'fast';
    expect(await loadErrorMessage()).toContain('INDEXER_POLL_INTERVAL_MS');
  });

  it('schedules the indexer with the configured interval, not a literal', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');
    expect(source).toContain('setInterval(poll, config.indexerPollIntervalMs)');
    expect(source).not.toMatch(/setInterval\(poll,\s*5_?000\)/);
  });
});
