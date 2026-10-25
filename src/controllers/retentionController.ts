import { Request, Response, NextFunction } from 'express';
import { runRetention } from '../services/retention';

export async function getRetentionDryRun(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ success: true, dryRun: true, data: await runRetention(true) }); }
  catch (err) { next(err); }
}
