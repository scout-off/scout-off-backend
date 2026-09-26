import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { countEventsFiltered, getEventsPage, getEventsPageKeyset, encodeEventsCursor, decodeEventsCursor } from '../db';
import type { ContractEventType } from '../types';
import { ErrorCode } from '../utils/errorCodes';
import { sendValidationError } from './adminControllerUtils';

const isoDateString = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Must be a valid ISO 8601 date string' })
  .transform((v) => new Date(v));

/** Exported so routes can apply validateQuery(adminDateRangeSchema) */
export const adminDateRangeSchema = z.object({
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  eventType: z.string().optional(),
}).refine(
  (d) => !(d.startDate && d.endDate && d.startDate > d.endDate),
  { message: 'startDate must not be after endDate' }
);

/**
 * Zod schema for all query parameters accepted by GET /api/admin/events.
 *
 * Supports two pagination styles for backwards compatibility:
 *   - Legacy:  ?limit=N&offset=M   (max limit 100, offset >= 0)
 *   - Modern:  ?page=N&pageSize=N  (max pageSize 200, page >= 1)
 *
 * Date-range filtering via ?startDate / ?endDate (ISO 8601) or the shorter
 * aliases ?from / ?to are both accepted and normalised to startDate/endDate.
 */
const eventsQuerySchema = z
  .object({
    // ── date-range ─────────────────────────────────────────────────────────
    startDate: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'startDate must be a valid ISO 8601 date' })
      .optional(),
    endDate: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'endDate must be a valid ISO 8601 date' })
      .optional(),
    from: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'from must be a valid ISO 8601 date' })
      .optional(),
    to: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'to must be a valid ISO 8601 date' })
      .optional(),
    // ── event type ─────────────────────────────────────────────────────────
    eventType: z.string().optional(),
    // ── legacy pagination (limit / offset) ─────────────────────────────────
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    // ── modern pagination (page / pageSize) ────────────────────────────────
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    // ── ledger range ────────────────────────────────────────────────────────
    fromLedger: z.coerce.number().int().min(0).optional(),
    toLedger: z.coerce.number().int().min(0).optional(),
    // ── keyset cursor (#1140) ────────────────────────────────────────────────
    /**
     * Opaque cursor returned as `nextCursor` by the previous page response.
     * When supplied, OFFSET-based pagination is ignored and results start
     * immediately after the cursor position (stable under concurrent inserts).
     * Encode via `encodeEventsCursor`; do not construct manually.
     */
    cursor: z.string().optional(),
  })
  .refine(
    (d) => {
      const start = d.startDate ?? d.from;
      const end = d.endDate ?? d.to;
      if (start && end) return new Date(start) <= new Date(end);
      return true;
    },
    { message: 'startDate must not be after endDate' },
  )
  .refine(
    (d) => {
      if (d.fromLedger !== undefined && d.toLedger !== undefined) {
        return d.fromLedger <= d.toLedger;
      }
      return true;
    },
    { message: 'fromLedger must not be greater than toLedger' },
  );

/** GET /api/admin/events */
export async function getAllEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = eventsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const { startDate, endDate, from, to, eventType, limit, offset, page, pageSize, cursor } = parsed.data;

  // Resolve date range — ?from/?to are aliases for ?startDate/?endDate
  const resolvedStart = startDate ?? from;
  const resolvedEnd = endDate ?? to;
  const startDateObj = resolvedStart ? new Date(resolvedStart) : undefined;
  const endDateObj = resolvedEnd ? new Date(resolvedEnd) : undefined;

  const eventTypeFilter = eventType as ContractEventType | undefined;

  const filter = { type: eventTypeFilter, startDate: startDateObj, endDate: endDateObj };

  // ── Keyset cursor pagination (#1140) ─────────────────────────────────────
  // When a `cursor` query param is present, use stable (ledger, id) keyset
  // pagination that is unaffected by concurrent indexer inserts.  The cursor
  // is an opaque base64url token encoding { ledger, id }.  Supplying a cursor
  // also makes the response include a `nextCursor` field ready for the next
  // page.  OFFSET-based params are still accepted but documented as deprecated.
  if (cursor !== undefined) {
    const afterCursor = decodeEventsCursor(cursor || undefined);
    if (cursor !== '' && afterCursor === null) {
      res.status(400).json({ success: false, error: 'Invalid cursor value', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const resolvedLimit = limit ?? pageSize ?? 20;
    const { rows: pageRows, nextCursor } = getEventsPageKeyset(filter, resolvedLimit, afterCursor);

    const data = pageRows.map((r) => ({
      source: '',
      type: r.type,
      payload: r.payload,
      contractAddress: '',
      created_at: r.createdAt,
    }));

    const responseBody: Record<string, unknown> = {
      success: true,
      data,
      pageSize: resolvedLimit,
    };
    if (nextCursor !== null) {
      responseBody.nextCursor = encodeEventsCursor(nextCursor);
    }
    res.json(responseBody);
    return;
  }

  // ── Legacy OFFSET-based pagination (deprecated) ───────────────────────────
  // Resolve pagination — legacy limit/offset takes precedence when supplied;
  // falls back to page/pageSize, then defaults (limit=20, offset=0).
  const resolvedLimit = limit ?? pageSize ?? 20;
  const resolvedOffset = offset ?? ((page ?? 1) - 1) * resolvedLimit;

  // Fetch the page from the DB (date filtering happens at SQL level)
  const rows = getEventsPage(filter, resolvedLimit, resolvedOffset);
  const total = countEventsFiltered(filter);
  const totalPages = Math.ceil(total / resolvedLimit);

  const data = rows.map((r) => ({
    source: '',
    type: r.type,
    payload: r.payload,
    contractAddress: '',
    created_at: r.createdAt,
  }));

  res.json({
    success: true,
    data,
    total,
    // Return both pagination styles so existing callers keep working
    limit: resolvedLimit,
    offset: resolvedOffset,
    page: Math.floor(resolvedOffset / resolvedLimit) + 1,
    pageSize: resolvedLimit,
    totalPages,
  });
}
