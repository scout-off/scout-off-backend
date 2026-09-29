/**
 * API Key Database Helpers (#1327)
 *
 * Database query helpers for per-key rate limits and monthly quota enforcement.
 */

import { getDriver } from './index';

export interface ApiKeyRateLimitConfig {
  rate_limit_per_minute: number | null;
  monthly_quota: number | null;
}

/**
 * Fetch per-key rate limit and quota config from the api_keys table.
 */
export async function getApiKeyRateLimits(keyId: number): Promise<ApiKeyRateLimitConfig | null> {
  const driver = getDriver();
  const row = await driver.get<ApiKeyRateLimitConfig>(
    `SELECT rate_limit_per_minute, monthly_quota 
     FROM api_keys 
     WHERE id = ? AND revoked_at IS NULL`,
    [keyId]
  );
  return row || null;
}

/**
 * Update rate limit configuration for an API key.
 */
export async function updateApiKeyRateLimit(
  keyId: number,
  rateLimitPerMinute: number | null
): Promise<void> {
  const driver = getDriver();
  await driver.run(
    'UPDATE api_keys SET rate_limit_per_minute = ? WHERE id = ?',
    [rateLimitPerMinute, keyId]
  );
}

/**
 * Update monthly quota configuration for an API key.
 */
export async function updateApiKeyMonthlyQuota(
  keyId: number,
  monthlyQuota: number | null
): Promise<void> {
  const driver = getDriver();
  await driver.run(
    'UPDATE api_keys SET monthly_quota = ? WHERE id = ?',
    [monthlyQuota, keyId]
  );
}

/**
 * Get usage for an API key in a specific period (YYYY-MM format).
 */
export async function getApiKeyUsage(keyId: number, period: string): Promise<number> {
  const driver = getDriver();
  const row = await driver.get<{ request_count: number }>(
    'SELECT request_count FROM api_key_usage WHERE key_id = ? AND period = ?',
    [keyId, period]
  );
  return row?.request_count || 0;
}

/**
 * Record or update API key usage for a specific period.
 */
export async function recordApiKeyUsage(keyId: number, period: string, count: number): Promise<void> {
  const driver = getDriver();
  const now = Math.floor(Date.now() / 1000);
  await driver.run(
    `INSERT INTO api_key_usage (key_id, period, request_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key_id, period) DO UPDATE SET request_count = ?, updated_at = ?`,
    [keyId, period, count, now, now, count, now]
  );
}

/**
 * Get all usage records for an API key.
 */
export async function getApiKeyUsageHistory(keyId: number): Promise<Array<{ period: string; request_count: number }>> {
  const driver = getDriver();
  const rows = await driver.all<{ period: string; request_count: number }>(
    'SELECT period, request_count FROM api_key_usage WHERE key_id = ? ORDER BY period DESC',
    [keyId]
  );
  return rows || [];
}
