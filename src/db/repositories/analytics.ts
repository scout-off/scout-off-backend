/**
 * Repository: time-series and region breakdown statistics.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: mixed — 1 `getDb()` (synchronous, SQLite-only) and 4 `getDriver()` (async) call site(s); the synchronous helpers remain part of the #640 migration.
 */
import { getDriver, getDb, timedQuery, timedQueryAsync } from '../query';
import config from '../../config';

// ─── Time-series stats helpers ───────────────────────────────────────────────────

export interface TimeSeriesPoint {
  date: string;
  count: number;
}

export interface RegionBreakdownPoint {
  date: string;
  region: string;
  count: number;
}

/**
 * SQL expression that buckets an epoch-milliseconds column into a
 * 'YYYY-MM-DD' date string, for GROUP BY date. SQLite's strftime() and
 * Postgres's to_char(to_timestamp(...)) are both dialect-specific — neither
 * expression works on the other driver — so this branches on config.dbDriver
 * rather than trying to find one expression that works everywhere.
 */
function dateBucketExpr(column: string): string {
  return config.dbDriver === 'postgres'
    ? `to_char(to_timestamp(${column} / 1000.0), 'YYYY-MM-DD')`
    : `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;
}

/**
 * Get daily counts of new players registered within a time window.
 */
export async function getNewPlayersTimeSeries(startDateMs: number, endDateMs: number): Promise<TimeSeriesPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('created_at')} as date, COUNT(*) as count
    FROM players
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/**
 * Get daily counts of milestones approved within a time window.
 */
export function getMilestonesApprovedTimeSeries(startDateMs: number, endDateMs: number): TimeSeriesPoint[] {
  const sql = `
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM events
    WHERE type = 'milestone_approved' AND created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = timedQuery(sql, () =>
    getDb().prepare(sql).all(startDateMs, endDateMs) as Array<{ date: string; count: number }>
  );
  return rows.map((r) => ({ date: r.date, count: r.count }));
}

/**
 * Get daily counts of contact unlocks within a time window.
 */
export async function getContactUnlocksTimeSeries(startDateMs: number, endDateMs: number): Promise<TimeSeriesPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('unlocked_at')} as date, COUNT(*) as count
    FROM contact_unlocks
    WHERE unlocked_at >= ? AND unlocked_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/**
 * Get daily counts of subscriptions started within a time window.
 */
export async function getSubscriptionsStartedTimeSeries(startDateMs: number, endDateMs: number): Promise<TimeSeriesPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('created_at')} as date, COUNT(*) as count
    FROM subscriptions
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/**
 * Get daily counts of new players grouped by region within a time window.
 */
export async function getNewPlayersByRegionTimeSeries(startDateMs: number, endDateMs: number): Promise<RegionBreakdownPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('created_at')} as date, region, COUNT(*) as count
    FROM players
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date, region
    ORDER BY date ASC, region ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; region: string | null; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, region: r.region ?? 'unknown', count: Number(r.count) }));
}
