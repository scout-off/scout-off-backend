import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  queryEvents,
  getNewPlayersTimeSeries,
  getMilestonesApprovedTimeSeries,
  getContactUnlocksTimeSeries,
  getSubscriptionsStartedTimeSeries,
  getNewPlayersByRegionTimeSeries,
} from '../db';
import { cacheGet, cacheSet } from '../services/cache';
import { ErrorCode } from '../utils/errorCodes';

const statsQuerySchema = z.object({
  window: z.enum(['7d', '30d', '90d']).optional(),
  breakdown: z.enum(['region']).optional(),
});

/** GET /api/admin/stats */
export async function getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = statsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }

  const { window, breakdown } = parsed.data;

  // If no window or breakdown requested, return basic stats (backward compatible)
  if (!window && !breakdown) {
    res.json({
      success: true,
      data: {
        players: queryEvents('player_registered').length,
        milestones: queryEvents('milestone_approved').length,
        subscriptions: queryEvents('scout_subscribed').length,
        events: queryEvents().length,
      },
    });
    return;
  }

  // Default to 30d if window is not specified but breakdown is
  const windowValue = window ?? '30d';

  // Calculate time window
  const windowDays = windowValue === '7d' ? 7 : windowValue === '30d' ? 30 : 90;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - windowDays);

  const startDateMs = startDate.getTime();
  const endDateMs = endDate.getTime();

  // Generate cache key
  const cacheKey = `admin:stats:${windowValue}:${breakdown ?? 'none'}`;
  const cached = await cacheGet<{ data: Record<string, unknown> }>(cacheKey);
  if (cached) {
    res.json({ success: true, data: cached.data });
    return;
  }

  // Fetch time-series data
  const newPlayers = getNewPlayersTimeSeries(startDateMs, endDateMs);
  const milestonesApproved = getMilestonesApprovedTimeSeries(startDateMs, endDateMs);
  const contactUnlocks = getContactUnlocksTimeSeries(startDateMs, endDateMs);
  const subscriptionsStarted = getSubscriptionsStartedTimeSeries(startDateMs, endDateMs);

  const data: Record<string, unknown> = {
    window: windowValue,
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    newPlayers,
    milestonesApproved,
    contactUnlocks,
    subscriptionsStarted,
  };

  // Add region breakdown if requested
  if (breakdown === 'region') {
    const newPlayersByRegion = getNewPlayersByRegionTimeSeries(startDateMs, endDateMs);
    data.newPlayersByRegion = newPlayersByRegion;
  }

  // Cache for 5 minutes (300000ms)
  await cacheSet(cacheKey, { data }, 5 * 60 * 1000);

  res.json({ success: true, data });
}
