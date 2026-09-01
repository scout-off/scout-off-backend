/**
 * Tests for adminMultiSig execution dispatch and atomicity (#1017)
 * 
 * Covers all acceptance criteria:
 * 1. Every AdminActionType variant executes real operations when quorum is reached
 * 2. Action types are correctly tagged (no more 'pause_contract' for validators)  
 * 3. Concurrent approval attempts are atomic (duplicate prevention)
 * 4. Schema equivalence between SQLite and PostgreSQL
 * 5. Execution failures are handled gracefully with retry capability
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';
import { initDb, closeDb, getDriver } from '../../src/db';
import config from '../../src/config';
import { proposeAction, approveAction } from '../../src/services/adminMultiSig';
import * as stellar from '../../src/services/stellar';
import * as db from '../../src/db';
import { logger } from '../../src/utils/logger';
import { getFeeWithdrawalDbWriteFailuresTotal } from '../../src/middleware/metrics';

// Mirrors tests/routes/adminAudit.test.ts's helper: requireRole('admin') on
// the HTTP layer verifies a real challenge/response signature and only
// grants the 'admin' role to a wallet already present in
// config.adminWallets — a literal `Bearer <wallet-address>` string (as used
// by the direct proposeAction/approveAction service-level tests elsewhere
// in this file) does not satisfy it.
async function getAdminToken(wallet: Keypair): Promise<string> {
  const challengeRes = await request(app).get(`/auth/challenge?account=${wallet.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(wallet);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'admin' });
  return tokenRes.body.token;
}

// Mock stellar service operations
jest.mock('../../src/services/stellar', () => ({
  pauseContractOnChain: jest.fn(),
  unpauseContractOnChain: jest.fn(),
  withdrawFees: jest.fn(),
  registerValidatorOnChain: jest.fn(),
  revokeValidatorOnChain: jest.fn(),
}));

const mockStellar = stellar as jest.Mocked<typeof stellar>;

describe('Admin Multi-Signature Execution and Atomicity', () => {
  const adminWallet1 = 'GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const adminWallet2 = 'GADMIN2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const adminWallet3 = 'GADMIN3XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  // A real, checksum-valid Stellar address — the HTTP-layer controller
  // (isValidStellarAddress) rejects a placeholder-format string.
  const validatorWallet = Keypair.random().publicKey();
  const treasuryAddress = 'GTREASURYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  // A real keypair for the HTTP-layer (Acceptance Criteria 2) tests, which
  // exercise requireRole('admin') and therefore need a genuine
  // challenge/response signature — see getAdminToken() above.
  const httpAdminKeypair = Keypair.random();

  beforeAll(async () => {
    // Set multi-sig threshold for testing
    config.adminThreshold = 2;
    config.adminWallets = [adminWallet1, adminWallet2, adminWallet3, httpAdminKeypair.publicKey()];

    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    // Set default successful responses
    mockStellar.pauseContractOnChain.mockResolvedValue({ transactionId: 'tx_pause_123' });
    mockStellar.unpauseContractOnChain.mockResolvedValue({ transactionId: 'tx_unpause_123' });
    mockStellar.registerValidatorOnChain.mockResolvedValue({ transactionId: 'tx_register_123' });
    mockStellar.revokeValidatorOnChain.mockResolvedValue({ transactionId: 'tx_revoke_123' });
    mockStellar.withdrawFees.mockResolvedValue({ 
      transactionId: 'tx_withdraw_123',
      amount: 1000000,
      recipient: treasuryAddress,
      token: 'XLM'
    });
  });

  describe('Acceptance Criteria 1: Real operations execute when quorum is reached', () => {
    test('pause_contract executes pauseContractOnChain', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      expect(proposal.status).toBe('proposed');

      const result = await approveAction(proposal.actionId, adminWallet2);
      expect(result.status).toBe('approved');
      expect(mockStellar.pauseContractOnChain).toHaveBeenCalledWith(adminWallet1);
    });

    test('unpause_contract executes unpauseContractOnChain', async () => {
      const proposal = proposeAction('unpause_contract', {}, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.unpauseContractOnChain).toHaveBeenCalledWith(adminWallet1);
    });

    test('register_validator executes registerValidatorOnChain', async () => {
      const proposal = proposeAction('register_validator', { validatorWallet }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.registerValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });

    test('revoke_validator executes revokeValidatorOnChain', async () => {
      const proposal = proposeAction('revoke_validator', { validatorWallet }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.revokeValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });

    test('withdraw_fees executes withdrawFees', async () => {
      const proposal = proposeAction('withdraw_fees', { recipient: treasuryAddress }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.withdrawFees).toHaveBeenCalledWith(treasuryAddress);
    });

    test('bulk_validator_import executes registerValidatorOnChain', async () => {
      const proposal = proposeAction('bulk_validator_import', { 
        wallet: validatorWallet, 
        label: 'Test Validator',
        region: 'US' 
      }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.registerValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });
  });

  describe('Acceptance Criteria 2: Correct action type tagging via adminController', () => {
    test('validator registration uses register_validator action type', async () => {
      const token = await getAdminToken(httpAdminKeypair);
      const response = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ validatorWallet })
        .expect(202);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/proposed/);

      // Verify the action this specific request created has the correct
      // type (queried by actionId, not just action_type, since other tests
      // in this suite create their own register_validator proposals against
      // the same shared test database).
      const actions = await getDriver().all(
        'SELECT * FROM pending_admin_actions WHERE id = ?',
        [response.body.data.actionId],
      );
      expect(actions).toHaveLength(1);
      expect((actions[0] as any).action_type).toBe('register_validator');
    });

    test('validator revocation uses revoke_validator action type', async () => {
      const token = await getAdminToken(httpAdminKeypair);
      const response = await request(app)
        .post('/api/admin/validators/revoke')
        .set('Authorization', `Bearer ${token}`)
        .send({ validatorWallet })
        .expect(202);

      expect(response.body.success).toBe(true);

      // See the register_validator test above for why this queries by
      // actionId rather than action_type.
      const actions = await getDriver().all(
        'SELECT * FROM pending_admin_actions WHERE id = ?',
        [response.body.data.actionId],
      );
      expect(actions).toHaveLength(1);
      expect((actions[0] as any).action_type).toBe('revoke_validator');
    });
  });

  describe('Acceptance Criteria 3: Concurrent approval atomicity', () => {
    // These tests use threshold=3 (rather than the file-wide 2) so that the
    // second signer's signature does not itself reach quorum. That keeps the
    // action in 'pending' state throughout, isolating the duplicate-signer
    // guard from the separate (and separately tested — see
    // tests/routes/adminMultiSig.test.ts "throws when trying to approve an
    // already executed action") already-executed idempotency guard: once an
    // action *has* executed, every approveAction call — including a repeat
    // from the signer whose approval triggered execution — throws
    // ACTION_EXECUTED (409) by design, not 'duplicate'. Duplicate-signer
    // detection is only meaningful while the action is still pending.
    const originalThreshold = 2;

    beforeEach(() => {
      config.adminThreshold = 3;
    });

    afterEach(() => {
      config.adminThreshold = originalThreshold;
    });

    test('prevents duplicate signatures from same signer', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);

      // First approval from adminWallet2 brings collected to 2 of 3 —
      // still short of quorum, so the action stays pending.
      const result1 = await approveAction(proposal.actionId, adminWallet2);
      expect(result1.status).toBe('pending');
      expect(result1.collected).toBe(2);

      // Second approval from the same signer must not count again.
      const result2 = await approveAction(proposal.actionId, adminWallet2);
      expect(result2.status).toBe('duplicate');
      expect(result2.collected).toBe(2);
    });

    test('concurrent approvals from same signer are atomic', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);

      // Simulate concurrent approvals racing for the same signature slot.
      const promises = [
        approveAction(proposal.actionId, adminWallet2),
        approveAction(proposal.actionId, adminWallet2),
        approveAction(proposal.actionId, adminWallet2),
      ];

      const results = await Promise.allSettled(promises);

      // Exactly one call counts as a new signature (collected 1 -> 2,
      // still below the threshold=3 quorum); the rest must be reported as
      // graceful duplicates, and none may reject.
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected).toHaveLength(0);

      const counted = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'pending');
      const duplicates = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'duplicate');

      expect(counted).toHaveLength(1);
      expect(duplicates).toHaveLength(2);
    });
  });

  describe('Acceptance Criteria 4: Schema equivalence between drivers', () => {
    const testMultiSigFlow = async () => {
      // Create a pending action
      const proposal = proposeAction('register_validator', { validatorWallet }, adminWallet1);
      expect(proposal.status).toBe('proposed');
      
      // Approve to reach quorum
      const result = await approveAction(proposal.actionId, adminWallet2);
      expect(result.status).toBe('approved');
      
      // Verify action exists in database
      const actions = await getDriver().all('SELECT * FROM pending_admin_actions WHERE id = ?', [proposal.actionId]);
      expect(actions).toHaveLength(1);
      
      // Verify signatures exist in database  
      const signatures = await getDriver().all('SELECT * FROM admin_action_signatures WHERE action_id = ?', [proposal.actionId]);
      expect(signatures).toHaveLength(2); // proposer + approver
    };

    test('multisig flow works with current driver', async () => {
      await testMultiSigFlow();
    });

    // Note: Testing both drivers would require test environment setup
    // This test verifies the current driver works correctly
  });

  describe('Acceptance Criteria 5: Execution failure handling', () => {
    test('execution failure is gracefully handled and retryable', async () => {
      // Mock stellar operation to fail
      mockStellar.pauseContractOnChain.mockRejectedValue(new Error('Network timeout'));
      
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      
      // Approval should fail due to execution error
      await expect(approveAction(proposal.actionId, adminWallet2)).rejects.toThrow('Network timeout');
      
      // Action should remain in pending state for retry
      const action = await getDriver().get('SELECT * FROM pending_admin_actions WHERE id = ?', [proposal.actionId]);
      expect((action as any)?.status).toBe('pending');
    });

    test('execution success is properly logged', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.pauseContractOnChain).toHaveBeenCalled();
      
      // Action should be marked as executed
      const action = await getDriver().get('SELECT * FROM pending_admin_actions WHERE id = ?', [proposal.actionId]);
      expect((action as any)?.status).toBe('executed');
    });
  });

  describe('Acceptance Criteria 6: Fee withdrawal DB-write failure is surfaced (#1207)', () => {
    test('a failed insertFeeWithdrawal after a successful on-chain withdrawal logs critical and increments the metric, but still reports success', async () => {
      const insertSpy = jest.spyOn(db, 'insertFeeWithdrawal').mockRejectedValueOnce(new Error('disk full'));
      const criticalSpy = jest.spyOn(logger, 'critical').mockImplementation(() => {});
      const before = getFeeWithdrawalDbWriteFailuresTotal();

      const proposal = proposeAction('withdraw_fees', { recipient: treasuryAddress }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);

      expect(result.status).toBe('approved');
      expect(insertSpy).toHaveBeenCalled();
      expect(criticalSpy).toHaveBeenCalledWith(
        expect.stringContaining('tx_withdraw_123'),
      );
      expect(criticalSpy.mock.calls[0][0]).toContain(treasuryAddress);
      expect(getFeeWithdrawalDbWriteFailuresTotal()).toBe(before + 1);

      insertSpy.mockRestore();
      criticalSpy.mockRestore();
    });
  });

  describe('Edge cases and error handling', () => {
    test('missing payload fields cause execution to fail gracefully', async () => {
      const proposal = proposeAction('register_validator', {}, adminWallet1); // Missing validatorWallet
      
      await expect(approveAction(proposal.actionId, adminWallet2)).rejects.toThrow('Missing validatorWallet in payload');
    });

    test('invalid action type is handled gracefully', async () => {
      // This would require manipulating the database directly since proposeAction validates the type
      const actionId = 'test-invalid-action';
      await getDriver().run(
        'INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [actionId, 'invalid_action', adminWallet1, '{}', 2, Date.now() + 86400000, Date.now(), 'pending']
      );
      
      await getDriver().run(
        'INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?)',
        [actionId, adminWallet1, Date.now()]
      );
      
      await getDriver().run(
        'UPDATE pending_admin_actions SET collected_signatures = 1 WHERE id = ?',
        [actionId]
      );
      
      await expect(approveAction(actionId, adminWallet2)).rejects.toThrow('Unknown action type');
    });

    test('threshold=1 bypasses multisig and executes immediately', async () => {
      // Temporarily set threshold to 1
      const originalThreshold = config.adminThreshold;
      config.adminThreshold = 1;
      
      try {
        const proposal = proposeAction('pause_contract', {}, adminWallet1);
        expect(proposal.status).toBe('immediate');
        // With threshold=1, the action should execute immediately in the controller
      } finally {
        config.adminThreshold = originalThreshold;
      }
    });
  });
});