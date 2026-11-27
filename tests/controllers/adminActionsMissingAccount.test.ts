import type { Request, Response, NextFunction } from 'express';
import {
  updatePlatformFeeController,
  bulkValidatorImport,
  approvePendingAction,
} from '../../src/controllers/adminActionsController';
import { requireAccount, MissingAuthenticatedAccountError } from '../../src/utils/requireAccount';
import { executeAdminAction, approveAction } from '../../src/services/adminMultiSig';

jest.mock('../../src/services/adminMultiSig', () => ({
  executeAdminAction: jest.fn(),
  approveAction: jest.fn(),
  listPendingActions: jest.fn(),
  getActionDetails: jest.fn(),
}));

const action = executeAdminAction as jest.Mock;
const approve = approveAction as jest.Mock;
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}
beforeEach(() => {
  action.mockReset();
  approve.mockReset();
});

describe('privileged admin identity (#1789)', () => {
  it.each([undefined, '', '  ', 'unknown', ' UNKNOWN '])(
    'rejects missing/placeholder wallet %p',
    (account) => {
      expect(() => requireAccount({ account } as Request)).toThrow(
        MissingAuthenticatedAccountError,
      );
    },
  );

  it('returns the authenticated wallet without changing its identity', () => {
    const wallet = 'G' + 'B'.repeat(55);
    expect(requireAccount({ account: wallet } as Request)).toBe(wallet);
  });

  it.each([
    ['fee update', updatePlatformFeeController],
    ['validator import', bulkValidatorImport],
    ['approval', approvePendingAction],
  ])(
    '%s fails closed before a DB or multi-sig write when account missing',
    async (_name, handler) => {
      const next = jest.fn();
      const res = makeRes();
      const req = {
        params: { id: 'a' },
        body: { actionId: 'a', newFeeBps: 5, wallets: [] },
      } as unknown as Request;
      await handler(req, res as unknown as Response, next as NextFunction);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
      expect(action).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    },
  );
});

it('rejects the placeholder actor before writing an audit row', async () => {
  const { insertAuditLog } = await import('../../src/db/repositories/audit');
  await expect(
    insertAuditLog({
      action: 'fee_updated',
      adminWallet: 'unknown',
      createdAt: new Date().toISOString(),
    }),
  ).rejects.toThrow(/unknown is forbidden/);
});
