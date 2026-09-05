import { Request, Response } from 'express';
import { ErrorCode } from '../utils/errorCodes';

/**
 * Returns a 405 Method Not Allowed response with:
 *  - An `Allow` header listing the comma-separated valid HTTP methods for the path.
 *  - A JSON body: `{ success: false, error: string, code: 'METHOD_NOT_ALLOWED', allowedMethods: string[] }`
 *
 * Usage: router.route('/path').get(handler).all(methodNotAllowed(['GET', 'HEAD']))
 */
export function methodNotAllowed(allowedMethods: string[]) {
  return (_req: Request, res: Response) => {
    res.set('Allow', allowedMethods.join(', '));
    res.status(405).json({
      success: false,
      error: 'Method Not Allowed',
      code: ErrorCode.METHOD_NOT_ALLOWED,
      allowedMethods,
    });
  };
}
