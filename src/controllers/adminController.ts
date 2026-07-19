import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { getEvents } from '../services/indexer';
import { AdminEvent, FeeHistoryItem, ApiResponse, EventRecord } from '../types';
import config from '../config';
import { logAuditEvent } from '../services/audit';
import { logger } from '../utils/logger';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** GET /api/admin/stats */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: {
        players: getEvents('player_registered').length,
        milestones: getEvents('milestone_approved').length,
        subscriptions: getEvents('scout_subscribed').length,
        events: getEvents().length,
      },
    });
  } catch (err) {
    next(err);
  }
}

const eventsQuerySchema = z.object({
  eventType: z.string().optional(),
  startDate: z.coerce.number().optional(),
  endDate: z.coerce.number().optional(),
});

/** GET /api/admin/events */
export async function getAllEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const events = getEvents() as unknown as EventRecord[];
    const body: ApiResponse<EventRecord[]> = { success: true, data: events };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/fees — returns fees_withdrawn event payloads */
export async function getFeeSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = ((req as any).account as string) ?? 'unknown';
    logAuditEvent({
      action: 'fee_history_query',
      adminWallet,
      queryParams: req.query as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    const withdrawals = getEvents('fees_withdrawn').map(
      (e) => e.payload as Record<string, unknown>
    );
    const body: ApiResponse<Record<string, unknown>[]> = { success: true, data: withdrawals };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/validators/register */
export async function registerValidator(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = (req as any).account as string;
    const { validatorWallet } = req.body as { validatorWallet?: string };

    if (!validatorWallet || !STELLAR_ADDRESS_RE.test(validatorWallet)) {
      console.warn(
        `[admin] register_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`
      );
      res
        .status(400)
        .json({ success: false, error: 'validatorWallet must be a valid Stellar address' });
      return;
    }

    console.info(
      `[admin] action=register_validator admin=${adminWallet} target=${validatorWallet}`
    );
    // TODO: invoke register_validator on Soroban contract
    res
      .status(202)
      .json({ success: true, message: `Validator ${validatorWallet} registration submitted` });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/validators/revoke */
export async function revokeValidator(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = (req as any).account as string;
    const { validatorWallet } = req.body as { validatorWallet?: string };

    if (!validatorWallet || !STELLAR_ADDRESS_RE.test(validatorWallet)) {
      console.warn(
        `[admin] revoke_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`
      );
      res
        .status(400)
        .json({ success: false, error: 'validatorWallet must be a valid Stellar address' });
      return;
    }

    console.info(`[admin] action=revoke_validator admin=${adminWallet} target=${validatorWallet}`);
    // TODO: invoke revoke_validator on Soroban contract
    res
      .status(202)
      .json({ success: true, message: `Validator ${validatorWallet} revocation submitted` });
  } catch (err) {
    next(err);
  }
}

const introspectSchema = z.object({
  token: z.string().min(1, 'token is required'),
});

/** POST /api/admin/introspect */
export async function introspectToken(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = introspectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(parsed.data.token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      res.status(400).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    // Return only non-secret metadata fields
    res.json({
      success: true,
      data: {
        sub: payload.sub,
        role: payload.role,
        iat: payload.iat,
        exp: payload.exp,
      },
    });
  } catch (err) {
    next(err);
  }
}
