/* eslint-disable @typescript-eslint/no-explicit-any */
import { xdr, rpc, Account } from '@stellar/stellar-sdk';
import {
  invokeContract,
  strVal,
  ContractNetworkError,
  ContractTimeoutError,
  ContractExecutionError,
} from '../../src/utils/contract';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    platformSecret: 'SDRWK2X6WMRKME2IMCAMULUHJ5G3DEFYAWA7QRTSEDXZTRCO6BHR5IOB',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
}));

jest.mock('../../src/services/stellar', () => ({
  __esModule: true,
  networkPassphrase: () => 'Test SDF Network ; September 2015',
  server: {
    getAccount: jest.fn(),
    simulateTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    getTransaction: jest.fn(),
  },
}));

// Mock assembleTransaction so tests that reach that line don't need a full sim result
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  const fakeTx = { sign: jest.fn(), toXDR: jest.fn(() => 'fake-xdr') };
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: jest.fn(() => ({ build: () => fakeTx })),
    },
  };
});

import { server } from '../../src/services/stellar';

const mockServer = server as jest.Mocked<typeof server>;

const PLATFORM_PUB = 'GC7NPCR7RFJXT2GFJKDYNB7RSQ6BPNZXDTGURFUQKEB4VGKMQUZO3FJW';
const FAKE_HASH = 'abc123def456abc123def456abc123def456abc123def456abc123def456ab12';

function makeAccount() {
  return new Account(PLATFORM_PUB, '100');
}

function makeSimResult() {
  return {
    transactionData: {
      toXDR: jest.fn().mockReturnValue(Buffer.alloc(0)),
      resources: jest.fn().mockReturnValue({ instructions: jest.fn().mockReturnValue(0) }),
    },
    minResourceFee: '100',
    cost: { cpuInsns: '0', memBytes: '0' },
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr('base64') }],
    _parsed: true,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('invokeContract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws ContractNetworkError when getAccount fails', async () => {
    mockServer.getAccount.mockRejectedValue(new Error('network down'));

    await expect(invokeContract('get_player', [])).rejects.toThrow(ContractNetworkError);
    await expect(invokeContract('get_player', [])).rejects.toThrow('network down');
  });

  it('throws ContractExecutionError when simulation returns error', async () => {
    mockServer.getAccount.mockResolvedValue(makeAccount() as any);
    mockServer.simulateTransaction.mockResolvedValue({
      error: 'wasm trap: unreachable',
      _parsed: true,
    } as any);
    jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

    await expect(invokeContract('bad_method', [])).rejects.toThrow(ContractExecutionError);
  });

  it('throws ContractNetworkError when simulateTransaction throws', async () => {
    mockServer.getAccount.mockResolvedValue(makeAccount() as any);
    mockServer.simulateTransaction.mockRejectedValue(new Error('rpc timeout'));

    await expect(invokeContract('get_player', [])).rejects.toThrow(ContractNetworkError);
  });

  it('throws ContractExecutionError when sendTransaction returns ERROR', async () => {
    mockServer.getAccount.mockResolvedValue(makeAccount() as any);
    mockServer.simulateTransaction.mockResolvedValue(makeSimResult() as any);
    jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(false);
    // assembleTransaction needs to be skipped — mock sendTransaction to ERROR
    mockServer.sendTransaction.mockResolvedValue({ status: 'ERROR', errorResult: 'bad op', hash: '' } as any);

    await expect(invokeContract('register_player', [])).rejects.toThrow(ContractExecutionError);
  });

  it('throws ContractTimeoutError when transaction never confirms within timeout', async () => {
    mockServer.getAccount.mockResolvedValue(makeAccount() as any);
    mockServer.simulateTransaction.mockResolvedValue(makeSimResult() as any);
    jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(false);
    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: FAKE_HASH } as any);
    mockServer.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as any);

    await expect(invokeContract('get_player', [], 100)).rejects.toThrow(ContractTimeoutError);
  }, 10_000);

  it('throws ContractExecutionError when transaction fails on-chain', async () => {
    mockServer.getAccount.mockResolvedValue(makeAccount() as any);
    mockServer.simulateTransaction.mockResolvedValue(makeSimResult() as any);
    jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(false);
    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: FAKE_HASH } as any);
    mockServer.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.FAILED,
    } as any);

    await expect(invokeContract('get_player', [])).rejects.toThrow(ContractExecutionError);
  });

  it('returns hash and returnValue on success', async () => {
    mockServer.getAccount.mockResolvedValue(makeAccount() as any);
    mockServer.simulateTransaction.mockResolvedValue(makeSimResult() as any);
    jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(false);
    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: FAKE_HASH } as any);
    mockServer.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: xdr.ScVal.scvVoid(),
    } as any);

    const result = await invokeContract('get_player', [strVal('player-1')]);
    expect(result.hash).toBe(FAKE_HASH);
    expect(result.returnValue).toBeDefined();
  });
});
