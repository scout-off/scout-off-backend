jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    adminWallets: [
      'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'GADMIN2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'GADMIN3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ],
    adminThreshold: 3,
    adminActionTtlMs: 60000,
    adminWallet: 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    nodeEnv: 'test',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    jwtSecret: 'test-secret',
    jwtSecretPrevious: '',
    platformSecret: '',
    platformSecretKey: '',
    dbPath: ':memory:',
    stellarHealthCheckEnabled: false,
    useMockServices: true,
    showErrorDetails: true,
    port: 0,
    network: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    platformFeeBps: 500,
    securityHeaders: {
      hsts: 'max-age=31536000',
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      csp: "default-src 'none'",
    },
    webhook: { enabled: false, url: '' },
    rateLimit: { enabled: false, windowMs: 60000, max: 1000 },
    authRateLimit: { windowMs: 60000, max: 1000 },
    bodyLimit: { json: '1mb' },
    allowedOrigins: [],
    logLevel: 'warn',
    requestTimeoutMs: 30000,
    requestLog: { skipPaths: [], sampleRate: 1 },
    playerCacheTtlMs: 60000,
    pinJsonCacheTtlMs: 300000,
    subscriptionGracePeriodHours: 24,
    pinata: { apiKey: '', secret: '', gateway: '', gateways: [] },
    backfillFromLedger: null,
  },
}));

const store: {
  pending_admin_actions: Array<Record<string, unknown>>;
  admin_action_signatures: Array<Record<string, unknown>>;
} = {
  pending_admin_actions: [],
  admin_action_signatures: [],
};

function resetStore(): void {
  store.pending_admin_actions = [];
  store.admin_action_signatures = [];
}

// In-memory transaction: just runs the callback synchronously (SQLite semantics)
function mockTransaction<T>(fn: () => T): T {
  return fn();
}

jest.mock('../../src/db', () => {
  const actual = jest.requireActual('../../src/db');
  return {
    ...actual,
    queryEvents: jest.fn().mockReturnValue([]),
    getDriver: jest.fn(() => ({
      transaction: mockTransaction,
      run: jest.fn(),
      get: jest.fn(),
      all: jest.fn(),
      value: jest.fn(),
      exec: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })),
    insertPendingAdminAction: jest.fn((p: Record<string, unknown>) => {
      store.pending_admin_actions.push({
        ...p,
        status: 'pending',
        collected_signatures: p.collected_signatures ?? 0,
      });
    }),
    getPendingAdminActionById: jest.fn((id: string) => {
      return (store.pending_admin_actions as Array<Record<string, unknown>>).find((a) => a.id === id) ?? null;
    }),
    updatePendingAdminActionStatus: jest.fn((id: string, status: string) => {
      const a = store.pending_admin_actions.find((x) => x.id === id);
      if (a) a.status = status;
    }),
    insertAdminActionSignature: jest.fn((p: Record<string, unknown>) => {
      const exists = store.admin_action_signatures.find(
        (s) => s.action_id === p.action_id && s.signer === p.signer,
      );
      if (exists) return false;
      store.admin_action_signatures.push({ ...p });
      return true;
    }),
    incrementActionSignatures: jest.fn((id: string) => {
      const a = store.pending_admin_actions.find((x) => x.id === id);
      if (a) {
        a.collected_signatures = ((a.collected_signatures as number) ?? 0) + 1;
      }
    }),
    getAdminActionSignature: jest.fn((action_id: string, signer: string) => {
      const s = store.admin_action_signatures.find(
        (x) => x.action_id === action_id && x.signer === signer,
      );
      return s ? { signed_at: s.signed_at as number } : null;
    }),
    expireStalePendingAdminActions: jest.fn(() => {
      const now = Date.now();
      let count = 0;
      for (const a of store.pending_admin_actions) {
        if (a.status === 'pending' && (a.expires_at as number) <= now) {
          a.status = 'expired';
          count++;
        }
      }
      return count;
    }),
    getPendingAdminActionsByStatus: jest.fn((status: string) => {
      return (store.pending_admin_actions as Array<Record<string, unknown>>).filter(
        (a) => a.status === status,
      );
    }),
    getAdminActionSignatures: jest.fn((action_id: string) => {
      return (store.admin_action_signatures as Array<Record<string, unknown>>)
        .filter((s) => s.action_id === action_id)
        .map((s) => ({ signer: s.signer as string, signed_at: s.signed_at as number }));
    }),
  };
});

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock stellar calls so quorum-reached tests don't hit the network
jest.mock('../../src/services/stellar', () => ({
  pauseContractOnChain: jest.fn().mockResolvedValue({ transactionId: 'tx_pause_mock' }),
  unpauseContractOnChain: jest.fn().mockResolvedValue({ transactionId: 'tx_unpause_mock' }),
  withdrawFees: jest.fn().mockResolvedValue({ transactionId: 'tx_withdraw_mock', amount: 0, recipient: '', token: 'XLM' }),
  registerValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'tx_register_mock' }),
  revokeValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'tx_revoke_mock' }),
}));

// Mock indexer so validator DB writes don't blow up
jest.mock('../../src/services/indexer', () => ({
  insertValidator: jest.fn(),
  revokeValidatorRow: jest.fn(),
  getAllValidators: jest.fn().mockReturnValue([]),
  getValidatorByWallet: jest.fn().mockReturnValue(null),
}));

import {
  proposeAction,
  approveAction,
  listPendingActions,
  getActionDetails,
} from '../../src/services/adminMultiSig';
import { logAuditEvent } from '../../src/services/audit';
import * as stellarService from '../../src/services/stellar';

const mockLogAuditEvent = logAuditEvent as jest.Mock;
const mockPauseContractOnChain = stellarService.pauseContractOnChain as jest.Mock;

const ADMIN_1 = 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_2 = 'GADMIN2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_3 = 'GADMIN3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OUTSIDER = 'GOUTSIDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  // Re-apply default resolved value after clearAllMocks
  mockPauseContractOnChain.mockResolvedValue({ transactionId: 'tx_pause_mock' });
});

afterAll(() => {
  resetStore();
});

// ─── Propose action ──────────────────────────────────────────────────────────

describe('proposeAction()', () => {
  it('returns a proposed result with actionId when threshold > 1', async () => {
    const result = await proposeAction('pause_contract', {}, ADMIN_1);

    expect(result.status).toBe('proposed');
    expect(result.actionId).toBeDefined();
    expect(typeof result.actionId).toBe('string');
  });

  it('persists an action with the correct properties', async () => {
    const result = await proposeAction('withdraw_fees', { recipient: 'G...' }, ADMIN_1);

    const action = store.pending_admin_actions[0];
    expect(action).toBeDefined();
    expect(action.id).toBe(result.actionId);
    expect(action.action_type).toBe('withdraw_fees');
    expect(action.proposer).toBe(ADMIN_1);
    expect(action.required_signatures).toBe(3);
    expect(action.collected_signatures).toBe(1);
    expect(action.status).toBe('pending');
  });

  it('records the proposer as the first signature', async () => {
    await proposeAction('pause_contract', {}, ADMIN_1);

    expect(store.admin_action_signatures).toHaveLength(1);
    expect(store.admin_action_signatures[0].signer).toBe(ADMIN_1);
  });

  it('logs an audit event on proposal', async () => {
    await proposeAction('pause_contract', {}, ADMIN_1);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pause_contract_proposed',
        adminWallet: ADMIN_1,
      }),
    );
  });

  it('sets an expiry timestamp in the future', async () => {
    const before = Date.now();
    await proposeAction('pause_contract', {}, ADMIN_1);

    expect(store.pending_admin_actions[0].expires_at as number).toBeGreaterThanOrEqual(before);
  });
});

// ─── Approve action ──────────────────────────────────────────────────────────

describe('approveAction()', () => {
  let actionId: string;

  beforeEach(async () => {
    actionId = (await proposeAction('pause_contract', {}, ADMIN_1)).actionId;
    jest.clearAllMocks();
    mockPauseContractOnChain.mockResolvedValue({ transactionId: 'tx_pause_mock' });
  });

  it('records a co-signature and returns pending when below threshold', async () => {
    const result = await approveAction(actionId, ADMIN_2);

    expect(result.status).toBe('pending');
    expect(result.collected).toBe(2);
    expect(result.required).toBe(3);

    expect(store.admin_action_signatures).toHaveLength(2);
  });

  it('rejects a duplicate signature from the same wallet', async () => {
    const result = await approveAction(actionId, ADMIN_1);

    expect(result.status).toBe('duplicate');
    expect(result.collected).toBe(1);

    expect(store.admin_action_signatures).toHaveLength(1);
  });

  it('throws when the signer is not in adminWallets', async () => {
    await expect(approveAction(actionId, OUTSIDER)).rejects.toThrow('Insufficient permissions');
  });

  it('returns approved status when threshold is reached', async () => {
    await approveAction(actionId, ADMIN_2);
    const result = await approveAction(actionId, ADMIN_3);

    expect(result.status).toBe('approved');
    expect(result.collected).toBe(3);
    expect(result.required).toBe(3);
  });

  it('marks the action as executed when threshold is reached', async () => {
    await approveAction(actionId, ADMIN_2);
    await approveAction(actionId, ADMIN_3);

    const a = store.pending_admin_actions[0];
    expect(a.status).toBe('executed');
  });

  it('throws when trying to approve an already executed action', async () => {
    await approveAction(actionId, ADMIN_2);
    await approveAction(actionId, ADMIN_3);

    await expect(approveAction(actionId, ADMIN_1)).rejects.toThrow('already been executed');
  });

  it('throws for a non-existent action', async () => {
    await expect(approveAction('nonexistent', ADMIN_1)).rejects.toThrow('Pending action not found');
  });

  it('rejects expired actions', async () => {
    const a = store.pending_admin_actions[0];
    a.expires_at = Date.now() - 1000;

    await expect(approveAction(actionId, ADMIN_2)).rejects.toThrow('expired');
    expect(store.pending_admin_actions[0].status).toBe('expired');
  });

  it('logs an audit event on each approval', async () => {
    await approveAction(actionId, ADMIN_2);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pause_contract_approved',
        adminWallet: ADMIN_2,
      }),
    );
  });

  it('logs threshold_met when threshold is reached', async () => {
    await approveAction(actionId, ADMIN_2);
    jest.clearAllMocks();
    mockPauseContractOnChain.mockResolvedValue({ transactionId: 'tx_pause_mock' });

    await approveAction(actionId, ADMIN_3);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queryParams: expect.objectContaining({ outcome: 'threshold_met' }),
      }),
    );
  });

  it('reverts to pending and throws when on-chain execution fails', async () => {
    mockPauseContractOnChain.mockRejectedValue(new Error('network error'));

    await approveAction(actionId, ADMIN_2);
    await expect(approveAction(actionId, ADMIN_3)).rejects.toThrow('network error');

    // Action must be reverted to pending so it can be retried
    const a = store.pending_admin_actions[0];
    expect(a.status).toBe('pending');
  });
});

// ─── Execution dispatch per action type ──────────────────────────────────────

describe('Execution dispatch — each AdminActionType fires the correct stellar call', () => {
  const threshold2Config = {
    adminThreshold: 2,
    adminWallets: [ADMIN_1, ADMIN_2],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const stellar = jest.requireMock('../../src/services/stellar');
    stellar.pauseContractOnChain.mockResolvedValue({ transactionId: 'tx_pause_mock' });
    stellar.unpauseContractOnChain.mockResolvedValue({ transactionId: 'tx_unpause_mock' });
    stellar.withdrawFees.mockResolvedValue({ transactionId: 'tx_withdraw_mock', amount: 0, recipient: '', token: 'XLM' });
    stellar.registerValidatorOnChain.mockResolvedValue({ transactionId: 'tx_register_mock' });
    stellar.revokeValidatorOnChain.mockResolvedValue({ transactionId: 'tx_revoke_mock' });
    resetStore();
  });

  it('pause_contract calls pauseContractOnChain', async () => {
    const stellar = jest.requireMock('../../src/services/stellar');
    const mockConfig = jest.requireMock('../../src/config').default;
    const orig = { adminThreshold: mockConfig.adminThreshold, adminWallets: [...mockConfig.adminWallets] };
    Object.assign(mockConfig, threshold2Config);

    try {
      const { actionId } = proposeAction('pause_contract', {}, ADMIN_1);
      const result = await approveAction(actionId, ADMIN_2);
      expect(result.status).toBe('approved');
      expect(stellar.pauseContractOnChain).toHaveBeenCalledWith(ADMIN_1);
    } finally {
      Object.assign(mockConfig, orig);
    }
  });

  it('unpause_contract calls unpauseContractOnChain', async () => {
    const stellar = jest.requireMock('../../src/services/stellar');
    const mockConfig = jest.requireMock('../../src/config').default;
    const orig = { adminThreshold: mockConfig.adminThreshold, adminWallets: [...mockConfig.adminWallets] };
    Object.assign(mockConfig, threshold2Config);

    try {
      const { actionId } = proposeAction('unpause_contract', {}, ADMIN_1);
      const result = await approveAction(actionId, ADMIN_2);
      expect(result.status).toBe('approved');
      expect(stellar.unpauseContractOnChain).toHaveBeenCalledWith(ADMIN_1);
    } finally {
      Object.assign(mockConfig, orig);
    }
  });

  it('register_validator calls registerValidatorOnChain', async () => {
    const stellar = jest.requireMock('../../src/services/stellar');
    const mockConfig = jest.requireMock('../../src/config').default;
    const orig = { adminThreshold: mockConfig.adminThreshold, adminWallets: [...mockConfig.adminWallets] };
    Object.assign(mockConfig, threshold2Config);

    try {
      const validatorWallet = 'GVAL123XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const { actionId } = proposeAction('register_validator', { validatorWallet }, ADMIN_1);
      const result = await approveAction(actionId, ADMIN_2);
      expect(result.status).toBe('approved');
      expect(stellar.registerValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    } finally {
      Object.assign(mockConfig, orig);
    }
  });

  it('revoke_validator calls revokeValidatorOnChain', async () => {
    const stellar = jest.requireMock('../../src/services/stellar');
    const mockConfig = jest.requireMock('../../src/config').default;
    const orig = { adminThreshold: mockConfig.adminThreshold, adminWallets: [...mockConfig.adminWallets] };
    Object.assign(mockConfig, threshold2Config);

    try {
      const validatorWallet = 'GVAL123XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const { actionId } = proposeAction('revoke_validator', { validatorWallet }, ADMIN_1);
      const result = await approveAction(actionId, ADMIN_2);
      expect(result.status).toBe('approved');
      expect(stellar.revokeValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    } finally {
      Object.assign(mockConfig, orig);
    }
  });

  it('withdraw_fees calls withdrawFees with the recipient', async () => {
    const stellar = jest.requireMock('../../src/services/stellar');
    const mockConfig = jest.requireMock('../../src/config').default;
    const orig = { adminThreshold: mockConfig.adminThreshold, adminWallets: [...mockConfig.adminWallets] };
    Object.assign(mockConfig, threshold2Config);

    try {
      const recipient = 'GTREASURY123XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const { actionId } = proposeAction('withdraw_fees', { recipient }, ADMIN_1);
      const result = await approveAction(actionId, ADMIN_2);
      expect(result.status).toBe('approved');
      expect(stellar.withdrawFees).toHaveBeenCalledWith(recipient);
    } finally {
      Object.assign(mockConfig, orig);
    }
  });

  it('bulk_validator_import calls registerValidatorOnChain', async () => {
    const stellar = jest.requireMock('../../src/services/stellar');
    const mockConfig = jest.requireMock('../../src/config').default;
    const orig = { adminThreshold: mockConfig.adminThreshold, adminWallets: [...mockConfig.adminWallets] };
    Object.assign(mockConfig, threshold2Config);

    try {
      const wallet = 'GVAL123XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const { actionId } = proposeAction('bulk_validator_import', { wallet, label: 'Test', region: 'US' }, ADMIN_1);
      const result = await approveAction(actionId, ADMIN_2);
      expect(result.status).toBe('approved');
      expect(stellar.registerValidatorOnChain).toHaveBeenCalledWith(wallet);
    } finally {
      Object.assign(mockConfig, orig);
    }
  });
});

// ─── List pending actions ────────────────────────────────────────────────────

describe('listPendingActions()', () => {
  it('returns empty array when no pending actions exist', async () => {
    const result = await listPendingActions();
    expect(result).toEqual([]);
  });

  it('returns only pending actions', async () => {
    await proposeAction('pause_contract', {}, ADMIN_1);

    const pending = await listPendingActions();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
  });

  it('does not return expired actions', async () => {
    await proposeAction('pause_contract', {}, ADMIN_1);
    const a = store.pending_admin_actions[0];
    a.expires_at = Date.now() - 1000;

    const pending = await listPendingActions();
    expect(pending).toHaveLength(0);
    expect(store.pending_admin_actions[0].status).toBe('expired');
  });
});

// ─── Get action details ──────────────────────────────────────────────────────

describe('getActionDetails()', () => {
  it('returns null for non-existent action', async () => {
    expect(await getActionDetails('nonexistent')).toBeNull();
  });

  it('returns action with signatures', async () => {
    const id = (await proposeAction('pause_contract', {}, ADMIN_1)).actionId;
    await approveAction(id, ADMIN_2);

    const details = await getActionDetails(id);
    expect(details).not.toBeNull();
    expect(details!.action.id).toBe(id);
    expect(details!.signatures).toHaveLength(2);
    expect(details!.signatures.map((s) => s.signer)).toEqual(
      expect.arrayContaining([ADMIN_1, ADMIN_2]),
    );
  });
});

// ─── Happy path: 3-of-3 full flow ────────────────────────────────────────────

describe('Full flow: 3-of-3 threshold', () => {
  it('propose -> co-sign -> co-sign -> executed', async () => {
    const result1 = await proposeAction('withdraw_fees', { recipient: 'G...' }, ADMIN_1);
    expect(result1.status).toBe('proposed');
    const actionId = result1.actionId;

    const result2 = await approveAction(actionId, ADMIN_2);
    expect(result2.status).toBe('pending');
    expect(result2.collected).toBe(2);

    const result3 = await approveAction(actionId, ADMIN_3);
    expect(result3.status).toBe('approved');
    expect(result3.collected).toBe(3);

    const a = store.pending_admin_actions[0];
    expect(a.status).toBe('executed');
    expect(a.collected_signatures).toBe(3);
  });
});

// ─── Edge: only 2 of 3 signatures collected (below threshold) ────────────────

describe('Below-threshold: 2 of 3 signatures', () => {
  it('remains pending after 2 signatures', async () => {
    const actionId = (await proposeAction('pause_contract', {}, ADMIN_1)).actionId;

    await approveAction(actionId, ADMIN_2);
    const detail = await listPendingActions();
    expect(detail).toHaveLength(1);
    expect(detail[0].status).toBe('pending');

    const result = await approveAction(actionId, ADMIN_3);
    expect(result.status).toBe('approved');
  });
});

// ─── Concurrency: same signer submits twice simultaneously ───────────────────

describe('Concurrent same-signer approval atomicity', () => {
  it('counts a signer at most once even with simultaneous calls', async () => {
    const actionId = proposeAction('pause_contract', {}, ADMIN_1).actionId;

    // Fire two approvals from ADMIN_2 simultaneously
    const [r1, r2] = await Promise.all([
      approveAction(actionId, ADMIN_2),
      approveAction(actionId, ADMIN_2),
    ]);

    // One must be counted, the other must be a duplicate
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['duplicate', 'pending']);

    // Only two signatures total: ADMIN_1 (proposer) + ADMIN_2 (once)
    expect(store.admin_action_signatures).toHaveLength(2);
  });
});
