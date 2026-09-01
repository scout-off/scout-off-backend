import { Request, Response, NextFunction } from 'express';
import { requireFeatureFlag } from '../../src/middleware/requireFeatureFlag';
import { isFeatureEnabled } from '../../src/services/featureFlags';
import { ErrorCode } from '../../src/utils/errorCodes';

jest.mock('../../src/services/featureFlags', () => ({
  isFeatureEnabled: jest.fn(),
}));

const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;

function makeReqRes(account?: string) {
  const req = { account } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('requireFeatureFlag middleware', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('calls next() when the flag is enabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    const { req, res, next } = makeReqRes('GACCOUNT');
    await requireFeatureFlag('some_flag')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('some_flag', { account: 'GACCOUNT' });
  });

  it('blocks with 404 and FEATURE_DISABLED when the flag is disabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const { req, res, next } = makeReqRes();
    await requireFeatureFlag('some_flag')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Feature not available',
      code: ErrorCode.FEATURE_DISABLED,
    });
  });

  it('does not fail open when the flag service throws', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('flag service unavailable'));
    const { req, res, next } = makeReqRes();
    await expect(requireFeatureFlag('some_flag')(req, res, next)).rejects.toThrow(
      'flag service unavailable',
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
