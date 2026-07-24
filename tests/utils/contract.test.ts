import {
  Keypair,
  SorobanRpc,
  Networks,
  Account,
  nativeToScVal,
  Transaction,
  FeeBumpTransaction,
  xdr,
} from '@stellar/stellar-sdk';
import { SorobanTransactionBuilder, strVal } from '../../src/utils/contract';

describe('SorobanTransactionBuilder', () => {
  const dummyContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const dummyKeypair = Keypair.random();
  const sponsorKeypair = Keypair.random();
  const networkPassphrase = Networks.TESTNET;

  let mockRpcServer: jest.Mocked<SorobanRpc.Server>;
  let builder: SorobanTransactionBuilder;

  beforeEach(() => {
    mockRpcServer = {
      getAccount: jest.fn(),
      simulateTransaction: jest.fn(),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    } as unknown as jest.Mocked<SorobanRpc.Server>;

    builder = new SorobanTransactionBuilder({
      server: mockRpcServer,
      networkPassphrase,
    });
  });

  describe('buildContractCall', () => {
    it('fetches account sequence and builds transaction', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'register_player',
        [strVal('test')],
        dummyKeypair.publicKey()
      );

      expect(mockRpcServer.getAccount).toHaveBeenCalledWith(dummyKeypair.publicKey());
      expect(tx).toBeInstanceOf(Transaction);
      expect(tx.sequence).toBe('101');
    });

    it('throws error if account fetch fails', async () => {
      mockRpcServer.getAccount.mockRejectedValue(new Error('Account not found'));

      await expect(
        builder.buildContractCall(dummyContractId, 'test', [], dummyKeypair.publicKey())
      ).rejects.toThrow('Failed to fetch account sequence');
    });
  });

  describe('simulate', () => {
    it('simulates transaction and returns assembled prepared tx and auth entries', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'health',
        [],
        dummyKeypair.publicKey()
      );

      const sorobanData = new xdr.SorobanTransactionData({
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({
            readOnly: [],
            readWrite: [],
          }),
          instructions: 100,
          readBytes: 100,
          writeBytes: 100,
        }),
        resourceFee: new xdr.Int64(1000),
        ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
      });

      const mockAuthEntry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: xdr.ScAddress.scAddressTypeContract(
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
              ),
              functionName: 'health',
              args: [],
            })
          ),
          subInvocations: [],
        }),
      });

      const mockSimResult = {
        minResourceFee: '1000',
        results: [
          {
            auth: [mockAuthEntry.toXDR('base64')],
            retval: nativeToScVal('ok'),
          },
        ],
        transactionData: sorobanData.toXDR('base64'),
      };

      mockRpcServer.simulateTransaction.mockResolvedValue(mockSimResult as unknown as SorobanRpc.Api.SimulateTransactionResponse);

      const result = await builder.simulate(tx);
      expect(result.preparedTx).toBeInstanceOf(Transaction);
      expect(result.authEntries).toBeDefined();
    });

    it('throws error if simulation returns an error', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'health',
        [],
        dummyKeypair.publicKey()
      );

      mockRpcServer.simulateTransaction.mockResolvedValue({
        error: 'Host function failed',
      } as unknown as SorobanRpc.Api.SimulateTransactionResponse);

      await expect(builder.simulate(tx)).rejects.toThrow('Simulation failed: Host function failed');
    });
  });

  describe('sign & fee-bump', () => {
    it('signs transaction directly with signer keypair', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'health',
        [],
        dummyKeypair.publicKey()
      );

      const signedTx = builder.sign(tx, dummyKeypair);
      expect(signedTx.signatures.length).toBe(1);
    });

    it('creates fee-bump transaction when sponsor keypair is provided', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'health',
        [],
        dummyKeypair.publicKey()
      );

      const feeBumpTx = builder.sign(tx, dummyKeypair, sponsorKeypair);
      expect(feeBumpTx).toBeInstanceOf(FeeBumpTransaction);
    });
  });

  describe('submit & retries', () => {
    it('retries on TRY_AGAIN_LATER status and eventually succeeds', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'health',
        [],
        dummyKeypair.publicKey()
      );

      mockRpcServer.sendTransaction
        .mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER' } as unknown as SorobanRpc.Api.SendTransactionResponse)
        .mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER' } as unknown as SorobanRpc.Api.SendTransactionResponse)
        .mockResolvedValueOnce({ status: 'PENDING', hash: 'txhash123' } as unknown as SorobanRpc.Api.SendTransactionResponse);

      mockRpcServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        returnValue: nativeToScVal('ok'),
      } as unknown as SorobanRpc.Api.GetTransactionResponse);

      const result = await builder.submit(tx, { tryAgainDelayMs: 10, pollIntervalMs: 10 });
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
    });

    it('handles sequence number conflicts by fetching fresh account and retrying', async () => {
      const mockAccount1 = new Account(dummyKeypair.publicKey(), '100');
      const mockAccount2 = new Account(dummyKeypair.publicKey(), '105');

      mockRpcServer.getAccount
        .mockResolvedValueOnce(mockAccount1 as unknown as Account)
        .mockResolvedValueOnce(mockAccount2 as unknown as Account);

      const sorobanData = new xdr.SorobanTransactionData({
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
          instructions: 100,
          readBytes: 100,
          writeBytes: 100,
        }),
        resourceFee: new xdr.Int64(1000),
        ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
      });

      const mockSimResult = {
        minResourceFee: '1000',
        results: [{ auth: [] }],
        transactionData: sorobanData.toXDR('base64'),
      };
      mockRpcServer.simulateTransaction.mockResolvedValue(mockSimResult as unknown as SorobanRpc.Api.SimulateTransactionResponse);

      const tx = await builder.buildContractCall(
        dummyContractId,
        'health',
        [],
        dummyKeypair.publicKey()
      );

      mockRpcServer.sendTransaction
        .mockRejectedValueOnce({ response: { status: 400 }, message: 'Bad sequence 400' })
        .mockResolvedValueOnce({ status: 'PENDING', hash: 'txhash456' } as unknown as SorobanRpc.Api.SendTransactionResponse);

      mockRpcServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      } as unknown as SorobanRpc.Api.GetTransactionResponse);

      const result = await builder.submit(
        tx,
        { tryAgainDelayMs: 10, pollIntervalMs: 10, autoRefreshSequenceOnConflict: true },
        {
          contractId: dummyContractId,
          functionName: 'health',
          args: [],
          sourcePublicKey: dummyKeypair.publicKey(),
          signerKeypair: dummyKeypair,
        }
      );

      expect(mockRpcServer.getAccount).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
    });
  });

  describe('executeContractCall end-to-end', () => {
    it('executes end-to-end chain build -> simulate -> sign -> submit', async () => {
      const mockAccount = new Account(dummyKeypair.publicKey(), '100');
      mockRpcServer.getAccount.mockResolvedValue(mockAccount as unknown as Account);

      const sorobanData = new xdr.SorobanTransactionData({
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
          instructions: 100,
          readBytes: 100,
          writeBytes: 100,
        }),
        resourceFee: new xdr.Int64(1000),
        ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
      });

      const mockSimResult = {
        minResourceFee: '1000',
        results: [{ auth: [] }],
        transactionData: sorobanData.toXDR('base64'),
      };
      mockRpcServer.simulateTransaction.mockResolvedValue(mockSimResult as unknown as SorobanRpc.Api.SimulateTransactionResponse);

      mockRpcServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'e2ehash789',
      } as unknown as SorobanRpc.Api.SendTransactionResponse);

      mockRpcServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        returnValue: nativeToScVal('success_val'),
      } as unknown as SorobanRpc.Api.GetTransactionResponse);

      const res = await builder.executeContractCall(
        dummyContractId,
        'register_player',
        [strVal('player1')],
        dummyKeypair,
        { submitOptions: { pollIntervalMs: 10 } }
      );

      expect(res).toBe('success_val');
    });
  });
});
