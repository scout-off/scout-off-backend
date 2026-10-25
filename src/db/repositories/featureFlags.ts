/**
 * Repository: feature flags.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

// ─── Feature flags (#494) ─────────────────────────────────────────────────────

export interface FeatureFlagRow {
  name: string;
  enabled: number;
  updated_at: number;
  updated_by: string;
}

export async function getAllFeatureFlags(): Promise<FeatureFlagRow[]> {
  const sql = `SELECT * FROM feature_flags ORDER BY name`;
  return timedQueryAsync(sql, async () => normalizeFeatureFlags(await getDriver().all<FeatureFlagRow>(sql)));
}

export async function getFeatureFlag(name: string): Promise<FeatureFlagRow | null> {
  const sql = `SELECT * FROM feature_flags WHERE name = ?`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<FeatureFlagRow>(sql, [name]);
    return row ? normalizeFeatureFlag(row) : null;
  });
}

export async function upsertFeatureFlag(p: {
  name: string;
  enabled: number;
  updated_at: number;
  updated_by: string;
}): Promise<void> {
  const sql = `
    INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.name, p.enabled, p.updated_at, p.updated_by]));
}

/**
 * feature_flags.enabled is INTEGER (0/1) on both drivers (see
 * db/010_feature_flags_postgres.sql for why it isn't BOOLEAN on Postgres),
 * but defensively normalise here too in case a row was ever written by
 * something outside upsertFeatureFlag, so callers (and existing tests) that
 * compare `enabled === 1` keep working identically on both drivers.
 */
function normalizeFeatureFlag(row: FeatureFlagRow): FeatureFlagRow {
  const raw = row.enabled as unknown;
  return { ...row, enabled: raw === true || raw === 1 ? 1 : 0 };
}

function normalizeFeatureFlags(rows: FeatureFlagRow[]): FeatureFlagRow[] {
  return rows.map(normalizeFeatureFlag);
}
