/**
 * Tests for src/services/sorobanRpcCheck.ts (issue #1824).
 *
 * The acceptance criterion is: a mismatched passphrase causes readiness to
 * fail with an explicit message (mocked RPC). A stuck ledger is detected.
 */

import {
  probeSorobanRpcCheck,
  runSorobanRpcStartupCheck,
} from '../../src/services/sorobanRpcCheck';

// ── Mock stellar SDK ──────────────────────────────────────────────────────────

const mockGetNetwork = jest.fn();
const mockGetLatestLedger = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as Record<string, unknown>;
  return {
    ...actual,
    rpc: {
      ...((actual.rpc as Record<string, unknown>) ?? {}),
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: mockGetNetwork,
        getLatestLedger: mockGetLatestLedger,
      })),
    },
  };
});

// ── Mock config ───────────────────────────────────────────────────────────────

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    sorobanRpcUrl: 'http://localhost:8000',
    networkPassphrase: 'Test SDF Network ; September 2015',
    stellarHealthCheckEnabled: true,
    stellarRpcTimeoutMs: 5000,
    nodeEnv: 'test',
    sorobanRpc: {
      minProtocolVersion: 20,
      strictProtocolVersion: false,
      ledgerStuckMs: 60_000,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupRpc(passphrase: string, protocolVersion: number, ledgerSeq: number) {
  mockGetNetwork.mockResolvedValue({ passphrase, protocolVersion });
  mockGetLatestLedger.mockResolvedValue({ sequence: ledgerSeq });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('probeSorobanRpcCheck — passphrase validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok when passphrase matches config', async () => {
    setupRpc('Test SDF Network ; September 2015', 22, 1000);
    const result = await probeSorobanRpcCheck();
    expect(result.passphrase).toBe('ok');
    expect(result.overall).toBe('ok');
  });

  it('returns error when passphrase does not match config', async () => {
    setupRpc('Public Global Stellar Network ; September 2015', 22, 1000);
    const result = await probeSorobanRpcCheck();
    expect(result.passphrase).toBe('error');
    expect(result.passphraseDetail).toMatch(/does not match/i);
    expect(result.overall).toBe('error');
  });

  it('returns error when RPC is unreachable', async () => {
    mockGetNetwork.mockRejectedValue(new Error('connection refused'));
    const result = await probeSorobanRpcCheck();
    expect(result.passphrase).toBe('error');
    expect(result.passphraseDetail).toMatch(/unreachable/i);
    expect(result.overall).toBe('error');
  });
});

describe('probeSorobanRpcCheck — protocol version', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok when protocol version meets minimum', async () => {
    setupRpc('Test SDF Network ; September 2015', 22, 1000);
    const result = await probeSorobanRpcCheck();
    expect(result.protocolVersion).toBe('ok');
    expect(result.protocolVersionDetail).toContain('22');
  });

  it('returns warning when protocol version is below minimum', async () => {
    setupRpc('Test SDF Network ; September 2015', 19, 1000);
    const result = await probeSorobanRpcCheck();
    expect(result.protocolVersion).toBe('warning');
    expect(result.protocolVersionDetail).toMatch(/below.*minimum/i);
  });

  it('returns warning when protocol version is not reported', async () => {
    mockGetNetwork.mockResolvedValue({ passphrase: 'Test SDF Network ; September 2015' });
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
    const result = await probeSorobanRpcCheck();
    expect(result.protocolVersion).toBe('warning');
    expect(result.protocolVersionDetail).toMatch(/did not report/i);
  });
});

describe('probeSorobanRpcCheck — ledger liveness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset internal snapshot between tests via module reload.
    jest.resetModules();
  });

  it('reports liveness ok on first observation', async () => {
    jest.isolateModules(async () => {
      jest.mock('@stellar/stellar-sdk', () => ({
        ...jest.requireActual('@stellar/stellar-sdk'),
        rpc: {
          Server: jest.fn().mockImplementation(() => ({
            getNetwork: jest.fn().mockResolvedValue({
              passphrase: 'Test SDF Network ; September 2015',
              protocolVersion: 22,
            }),
            getLatestLedger: jest.fn().mockResolvedValue({ sequence: 5000 }),
          })),
        },
      }));
      jest.mock('../../src/config', () => ({
        __esModule: true,
        default: {
          sorobanRpcUrl: 'http://localhost:8000',
          networkPassphrase: 'Test SDF Network ; September 2015',
          stellarHealthCheckEnabled: true,
          stellarRpcTimeoutMs: 5000,
          nodeEnv: 'test',
          sorobanRpc: {
            minProtocolVersion: 20,
            strictProtocolVersion: false,
            ledgerStuckMs: 60_000,
          },
        },
      }));
      jest.mock('../../src/utils/logger', () => ({
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }));
      const { probeSorobanRpcCheck: probe } = await import('../../src/services/sorobanRpcCheck');
      const result = await probe();
      expect(result.ledgerLiveness).toBe('ok');
      expect(result.ledgerLivenessDetail).toMatch(/first observation/i);
    });
  });

  it('detects a stuck ledger when sequence does not advance past the stuck threshold', async () => {
    // Simulate time passing: same sequence returned twice, >stuckMs apart.
    // We test the detection logic directly by calling the RPC mock with a
    // fixed ledger and verifying the warning path.
    setupRpc('Test SDF Network ; September 2015', 22, 9999);

    // First call sets the snapshot.
    await probeSorobanRpcCheck();

    // Advance time to after the stuck threshold (we mock Date.now).
    const realNow = Date.now;
    Date.now = jest.fn().mockReturnValue(realNow() + 70_000);

    try {
      // Same ledger sequence returned — still 9999.
      const result = await probeSorobanRpcCheck();
      // The ledger has not advanced and 70 s > 60 s stuck threshold.
      expect(result.ledgerLiveness).toBe('warning');
      expect(result.ledgerLivenessDetail).toMatch(/has not advanced/i);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('runSorobanRpcStartupCheck — production hard failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws when passphrase mismatches in production', async () => {
    // Re-mock config with production nodeEnv.
    jest.resetModules();
    jest.mock('../../src/config', () => ({
      __esModule: true,
      default: {
        sorobanRpcUrl: 'http://localhost:8000',
        networkPassphrase: 'Test SDF Network ; September 2015',
        stellarHealthCheckEnabled: true,
        stellarRpcTimeoutMs: 5000,
        nodeEnv: 'production',
        sorobanRpc: { minProtocolVersion: 20, strictProtocolVersion: false, ledgerStuckMs: 60_000 },
      },
    }));
    jest.mock('@stellar/stellar-sdk', () => ({
      ...jest.requireActual('@stellar/stellar-sdk'),
      rpc: {
        Server: jest.fn().mockImplementation(() => ({
          getNetwork: jest.fn().mockResolvedValue({
            passphrase: 'Public Global Stellar Network ; September 2015', // mismatch
            protocolVersion: 22,
          }),
          getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
        })),
      },
    }));
    jest.mock('../../src/utils/logger', () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));

    const { runSorobanRpcStartupCheck: startupCheck } =
      await import('../../src/services/sorobanRpcCheck');
    await expect(startupCheck()).rejects.toThrow(/FATAL/);
  });
});
