import type { Response } from 'express';

/** Wrap a successful payload in the standard API envelope. */
export function ok<T>(data: T, meta?: Record<string, unknown>) {
  return { success: true as const, data, ...meta };
}

/** Wrap a paginated list in the standard API envelope. */
export function paginated<T>(data: T[], total: number, page: number, pageSize: number) {
  return { success: true as const, data, total, page, pageSize };
}

/** Build a failure envelope. */
export function fail(error: string) {
  return { success: false as const, error };
}

/** Convert a Unix-second ledger timestamp to an ISO 8601 UTC string. */
export function toIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Return a shallow copy of payload with the specified numeric fields
 * converted to ISO 8601 UTC strings.
 */
export function normalizeTimestamps(
  payload: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const out = { ...payload };
  for (const f of fields) {
    if (typeof out[f] === 'number') {
      out[f] = toIso(out[f] as number);
    }
  }
  return out;
}

/**
 * Send a JSON success response with the standard API envelope.
 *
 * Sets `Content-Type: application/json`, applies the given HTTP status code
 * (defaults to 200), and writes `{ success: true, data, ...meta }` as the
 * response body.
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  status = 200,
  meta?: Record<string, unknown>
): void {
  res.set('Content-Type', 'application/json');
  res.status(status).json({ success: true, data, ...meta });
}

/**
 * Send a JSON error response with the standard API envelope.
 *
 * Sets `Content-Type: application/json`, applies the given HTTP status code
 * (defaults to 500), and writes `{ success: false, error: message }` — plus
 * an optional `errors` array for field-level validation details — as the
 * response body.
 */
export function sendError(
  res: Response,
  message: string,
  status = 500,
  errors?: string[]
): void {
  res.set('Content-Type', 'application/json');
  res.status(status).json({
    success: false,
    error: message,
    ...(errors !== undefined ? { errors } : {}),
  });
}
