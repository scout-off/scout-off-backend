/**
 * #1143 — IPFS / Stellar HTTP timeouts.
 *
 * Asserts axios calls receive `timeout: config.ipfsHttpTimeoutMs` and that
 * `rpc.Server` is constructed with `timeout: config.stellarRpcTimeoutMs`.
 */

const IPFS_TIMEOUT_MS = 1234;
const STELLAR_TIMEOUT_MS = 5678;

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    pinata: { apiKey: 'test-key', secret: 'test-secret', gateway: 'https://gateway.pinata.cloud' },
    logLevel: 'warn',
    nodeEnv: 'test',
    pinJsonCacheTtlMs: 300_000,
    ipfsHttpTimeoutMs: 1234,
    stellarRpcTimeoutMs: 5678,
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    network: 'testnet',
  },
}));

jest.mock('axios');
import axios from 'axios';

const mockedPost = jest.fn();
const mockedGet = jest.fn();
const mockedDelete = jest.fn();
(axios as jest.Mocked<typeof axios>).post = mockedPost;
(axios as jest.Mocked<typeof axios>).get = mockedGet;
(axios as jest.Mocked<typeof axios>).delete = mockedDelete;
(axios as jest.Mocked<typeof axios>).isAxiosError = jest.fn().mockReturnValue(false);

jest.mock('../../src/db', () => ({
  insertPendingPin: jest.fn().mockResolvedValue(true),
  getPendingPins: jest.fn().mockResolvedValue([]),
  deletePendingPin: jest.fn(),
  deletePendingPinByHash: jest.fn(),
  isPendingPinByHash: jest.fn().mockResolvedValue(false),
  incrementPendingPinAttempts: jest.fn(),
  setPendingPinResolvedCid: jest.fn(),
  getResolvedCidByHash: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
  },
}));

import { pinJson, checkHealth, clearPinJsonCache } from '../../src/services/ipfs';
import config from '../../src/config';

describe('IPFS HTTP timeouts (#1143)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPinJsonCache();
  });

  it('pinJson passes timeout matching config.ipfsHttpTimeoutMs to axios.post', async () => {
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'QmTimeoutCid' } });

    await pinJson({ playerId: 'P-timeout' });

    expect(config.ipfsHttpTimeoutMs).toBe(IPFS_TIMEOUT_MS);
    expect(mockedPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ timeout: IPFS_TIMEOUT_MS }),
    );
  });

  it('checkHealth passes timeout matching config.ipfsHttpTimeoutMs to axios.get', async () => {
    mockedGet.mockResolvedValue({ data: {} });

    await checkHealth();

    expect(mockedGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: IPFS_TIMEOUT_MS }),
    );
  });

  it('rejects when axios never resolves within the configured timeout (deferred + fake timers)', async () => {
    jest.useFakeTimers();
    try {
      // Simulate axios honouring the timeout option: reject after `timeout` ms
      // while the underlying request promise never resolves.
      mockedPost.mockImplementation((_url: string, _body: unknown, opts?: { timeout?: number }) => {
        return new Promise((_resolve, reject) => {
          const ms = opts?.timeout ?? 0;
          setTimeout(() => {
            const err = new Error(`timeout of ${ms}ms exceeded`);
            (err as Error & { code: string }).code = 'ECONNABORTED';
            reject(err);
          }, ms);
          // Intentional: no resolve path — request hangs forever.
        });
      });

      const pending = pinJson({ playerId: 'P-hang' });
      const expectation = expect(pending).rejects.toMatchObject({ code: 'ECONNABORTED' });

      await jest.advanceTimersByTimeAsync(IPFS_TIMEOUT_MS);
      await expectation;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Stellar RPC timeouts (#1143)', () => {
  it('constructs rpc.Server with timeout and sets httpClient.defaults.timeout', () => {
    const serverCtor = jest.fn().mockImplementation(() => ({
      httpClient: { defaults: { timeout: 0 } },
      getLatestLedger: jest.fn(),
      getAccount: jest.fn(),
      simulateTransaction: jest.fn(),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    }));

    jest.resetModules();
    jest.doMock('@stellar/stellar-sdk', () => ({
      rpc: {
        Server: serverCtor,
        Api: {
          isSimulationError: jest.fn().mockReturnValue(false),
          GetTransactionStatus: {
            NOT_FOUND: 'NOT_FOUND',
            SUCCESS: 'SUCCESS',
            FAILED: 'FAILED',
          },
        },
        assembleTransaction: jest.fn(),
      },
      Networks: {
        TESTNET: 'Test SDF Network ; September 2015',
        PUBLIC: 'Public Global Stellar Network ; September 2015',
      },
      Contract: jest.fn().mockImplementation(() => ({ call: jest.fn() })),
      TransactionBuilder: jest.fn().mockImplementation(() => ({
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue({}),
      })),
      BASE_FEE: '100',
      Keypair: {
        random: jest.fn().mockReturnValue({ publicKey: () => 'GBADUMMY' }),
        fromSecret: jest.fn().mockReturnValue({
          publicKey: () => 'GPLATFORM',
          sign: jest.fn(),
        }),
      },
      Account: jest.fn().mockImplementation(() => ({})),
      Address: { fromString: jest.fn().mockReturnValue({ toScVal: () => ({}) }) },
      scValToNative: jest.fn(),
      nativeToScVal: jest.fn(),
    }));
    jest.doMock('../../src/config', () => ({
      __esModule: true,
      default: {
        pinata: { apiKey: 'test-key', secret: 'test-secret', gateway: 'https://gateway.pinata.cloud' },
        logLevel: 'warn',
        nodeEnv: 'test',
        pinJsonCacheTtlMs: 300_000,
        ipfsHttpTimeoutMs: IPFS_TIMEOUT_MS,
        stellarRpcTimeoutMs: STELLAR_TIMEOUT_MS,
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        network: 'testnet',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      },
    }));
    jest.doMock('../../src/utils/circuitBreaker', () => ({
      stellarBreaker: {
        execute: <T>(fn: () => T) => fn(),
      },
    }));
    jest.doMock('../../src/utils/signer', () => ({
      getPlatformKeypair: jest.fn().mockReturnValue({
        publicKey: () => 'GPLATFORM',
        sign: jest.fn(),
      }),
    }));

    // Fresh load so Server is constructed with our mocks.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/services/stellar');

    expect(serverCtor).toHaveBeenCalledWith(
      'https://soroban-testnet.stellar.org',
      expect.objectContaining({
        allowHttp: false,
        timeout: STELLAR_TIMEOUT_MS,
      }),
    );

    const instance = serverCtor.mock.results[0]?.value as {
      httpClient: { defaults: { timeout: number } };
    };
    expect(instance.httpClient.defaults.timeout).toBe(STELLAR_TIMEOUT_MS);
  });
});
