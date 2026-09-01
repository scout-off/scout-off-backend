import { Request, Response, NextFunction } from 'express';
import { isFeatureEnabled } from '../services/featureFlags';
import { ErrorCode } from '../utils/errorCodes';

/**
 * Middleware factory that blocks the request when a feature flag is disabled.
 * Changes take effect immediately via the in-process feature-flag cache.
 */
export function requireFeatureFlag(flagName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (await isFeatureEnabled(flagName, { account: req.account })) {
      next();
      return;
    }

    res.status(404).json({
      success: false,
      error: 'Feature not available',
      code: ErrorCode.FEATURE_DISABLED,
    });
  };
}
