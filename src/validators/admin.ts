import { z } from 'zod';

// Stellar address validation regex
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

// ISO 8601 date string validation
const isoDateString = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Must be a valid ISO 8601 date string' })
  .transform((v) => new Date(v));

// Contract event types enum
const EVENT_TYPES = [
  'player_registered',
  'profile_updated',
  'milestone_approved',
  'milestone_rejected',
  'scout_subscribed',
  'contact_unlocked',
  'connection_created',
  'token_issued',
  'token_bought',
  'platform_fee_updated',
  'fees_withdrawn',
  'validator_registered',
  'validator_revoked',
  'contract_paused',
  'contract_unpaused',
  'platform_fee_updated',
] as const;

/**
 * Schema for admin date range filtering
 * Used by: GET /api/admin/events, GET /api/admin/fees
 */
export const adminDateRangeSchema = z
  .object({
    startDate: isoDateString.optional(),
    endDate: isoDateString.optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
  })
  .refine((d) => !(d.startDate && d.endDate && d.startDate > d.endDate), {
    message: 'startDate must not be after endDate',
  });

/**
 * Schema for pagination parameters
 * Used by: GET /api/admin/events, GET /api/admin/audit
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Schema for audit log query parameters
 * Used by: GET /api/admin/audit
 */
export const auditQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Schema for ledger range filtering
 * Used by: GET /api/admin/events (for fromLedger/toLedger)
 */
export const ledgerRangeSchema = z
  .object({
    fromLedger: z.coerce.number().int().min(0).optional(),
    toLedger: z.coerce.number().int().min(0).optional(),
  })
  .refine((d) => !(d.fromLedger && d.toLedger && d.fromLedger > d.toLedger), {
    message: 'fromLedger must not be greater than toLedger',
  });

/**
 * Schema for wallet address validation
 * Used by: GET /api/admin/validators/:wallet/stats
 */
export const walletAddressSchema = z.object({
  wallet: z.string().regex(STELLAR_ADDRESS_RE, 'Invalid Stellar address'),
});

/** Maximum width of a validator-stats time range, in days. */
export const VALIDATOR_STATS_MAX_RANGE_DAYS = 366;

/**
 * ISO 8601 date *string* (kept as a string, not coerced to `Date`, because
 * `validateQuery` runs the parsed object through `sanitizeObject`, which would
 * turn a `Date` into `{}`).
 */
const isoDateQueryParam = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Must be a valid ISO 8601 date string' });

/**
 * Schema for the optional `from`/`to` time-range on validator stats.
 * Used by: GET /api/admin/validators/:wallet/stats
 *
 * Rejects unknown query parameters, a `from` later than `to`, and a range
 * wider than {@link VALIDATOR_STATS_MAX_RANGE_DAYS} days.
 */
export const validatorStatsRangeSchema = z
  .object({
    from: isoDateQueryParam.optional(),
    to: isoDateQueryParam.optional(),
  })
  .strict()
  .refine((d) => !(d.from && d.to) || Date.parse(d.from) <= Date.parse(d.to), {
    message: 'from must not be after to',
  })
  .refine(
    (d) =>
      !(d.from && d.to) ||
      Date.parse(d.to) - Date.parse(d.from) <= VALIDATOR_STATS_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000,
    { message: `Time range must not exceed ${VALIDATOR_STATS_MAX_RANGE_DAYS} days` },
  );

/**
 * Schema for reindex request body
 * Used by: POST /api/admin/indexer/reindex
 */
export const reindexSchema = z
  .object({
    fromLedger: z.coerce.number().int().min(0),
  })
  .strict();

/**
 * Schema for validator registration/revocation request body
 * Used by: POST /api/admin/validators/register, POST /api/admin/validators/revoke
 */
export const validatorWalletSchema = z
  .object({
    validatorWallet: z.string().regex(STELLAR_ADDRESS_RE, 'Invalid Stellar address'),
  })
  .strict();

/**
 * Schema for fee withdrawal request body
 * Used by: POST /api/admin/fees
 */
export const withdrawFeesSchema = z
  .object({
    recipient: z.string().regex(STELLAR_ADDRESS_RE, 'Invalid Stellar address'),
  })
  .strict();

/**
 * Schema for token introspection request body
 * Used by: POST /api/admin/introspect
 */
export const introspectSchema = z.object({
  token: z.string().min(1, 'token is required'),
});

/**
 * Schema for platform fee update request body
 * Used by: POST /api/admin/platform-fee
 */
export const updatePlatformFeeSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(10000), // 0-100% in basis points
});
