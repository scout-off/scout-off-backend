import { Request, Response } from 'express';
import { z } from 'zod';
import { setIpScore, getReputation } from '../services/ipReputation';
import { isValidIpAddress } from '../utils/validators';

export const setIpReputationSchema = z.object({
  ip: z.string().min(1),
  score: z.number().int().min(0).max(100),
}).strict();

/**
 * POST /api/admin/ip-allowlist
 *
 * Manually set an IP's reputation score.
 * - score=0 → whitelist the IP (immune to decay and scoring)
 * - score=100 → blacklist the IP (immediate 429 for all requests)
 *
 * @body { ip: string, score: 0 | 100 }
 * @response 200 { success: true, data: { ip, score } }
 * @response 400 { success: false, error: string } - ip missing, malformed, or score out of range
 */
export function setIpReputationController(req: Request, res: Response): void {
  const parsed = setIpReputationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Validation error',
    });
    return;
  }

  const { ip, score } = parsed.data;

  if (!isValidIpAddress(ip.trim())) {
    res.status(400).json({ success: false, error: 'ip must be a valid IPv4 or IPv6 address' });
    return;
  }

  setIpScore(ip.trim(), score, true);

  res.json({ success: true, data: { ip: ip.trim(), score } });
}

/**
 * GET /api/admin/ip-reputation/:ip
 *
 * Returns the current reputation record for an IP.
 *
 * @response 200 { success: true, data: IpReputation | null }
 * @response 400 { success: false, error: string } - Invalid ip format
 */
export function getIpReputationController(req: Request, res: Response): void {
  const { ip } = req.params as { ip: string };

  if (!isValidIpAddress(ip)) {
    res.status(400).json({ success: false, error: 'ip must be a valid IPv4 or IPv6 address' });
    return;
  }

  const rep = getReputation(ip);
  res.json({ success: true, data: rep ?? null });
}
