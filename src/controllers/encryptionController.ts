import { Request, Response, NextFunction } from 'express';
import { getEncryptionStatus } from '../services/fieldReencryptionJob';

/** GET /api/admin/encryption/status — ciphertext counts per key id (#1513). */
export async function getEncryptionStatusEndpoint(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try { res.json({ success: true, data: await getEncryptionStatus() }); }
  catch (err) { next(err); }
}
