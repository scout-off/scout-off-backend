import { Request, Response, NextFunction } from 'express';
import { getEvents } from '../services/indexer';
import { ContractEventType } from '../types';

/** GET /api/admin/events?type=<ContractEventType> */
export async function getAllEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const { type } = req.query;
    const events = type ? getEvents(type as ContractEventType) : getEvents();
    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/fees */
export async function getFeeSummary(_req: Request, res: Response, next: NextFunction) {
  try {
    const withdrawals = getEvents('fees_withdrawn');
    res.json({ success: true, data: withdrawals });
  } catch (err) {
    next(err);
  }
}
