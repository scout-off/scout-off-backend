/**
 * Shared pagination constants and utilities for REST and GraphQL endpoints.
 */

/**
 * Maximum page size for paginated list endpoints.
 * Requests exceeding this limit are clamped to this value.
 * This is enforced consistently across all REST and GraphQL list endpoints
 * to provide a predictable contract for API clients.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Default page size for paginated list endpoints when not specified.
 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Clamp a requested page size to the valid range [1, MAX_PAGE_SIZE].
 * @param requestedSize The page size requested by the client
 * @returns A page size within the valid range
 */
export function clampPageSize(requestedSize: unknown): number {
  const parsed = typeof requestedSize === 'number' ? requestedSize : parseInt(String(requestedSize), 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, parsed));
}
