import { Request, Response } from 'express';

/**
 * Returns a 405 Method Not Allowed response with:
 *  - An `Allow` header listing the comma-separated valid HTTP methods for the path.
 *  - A JSON body: `{ error: 'Method Not Allowed', allowedMethods: string[] }`
 *
 * Usage: router.route('/path').get(handler).all(methodNotAllowed(['GET', 'HEAD']))
 */
export function methodNotAllowed(allowedMethods: string[]) {
  return (_req: Request, res: Response) => {
    res.set('Allow', allowedMethods.join(', '));
    res.status(405).json({ error: 'Method Not Allowed', allowedMethods });
  };
}
