import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type NodeEnv = 'development' | 'test' | 'staging' | 'production';

const VALID_ENVS: ReadonlySet<string> = new Set(['development', 'test', 'staging', 'production']);

const rawNodeEnv = process.env.NODE_ENV ?? 'development';
if (!VALID_ENVS.has(rawNodeEnv)) {
  throw new Error(`Invalid NODE_ENV: "${rawNodeEnv}". Must be one of: ${[...VALID_ENVS].join(', ')}`);
}
const nodeEnv = rawNodeEnv as NodeEnv;

// Validate ADMIN_WALLET based on environment:
// - production: throw immediately so the process never starts without it
// - staging: emit a console warning (process continues)
const adminWalletValue = process.env.ADMIN_WALLET ?? '';
if (!adminWalletValue) {
  if (nodeEnv === 'production') {
    throw new Error('ADMIN_WALLET is required in production but is not set. Set the ADMIN_WALLET environment variable to the platform admin Stellar address.');
  }
  if (nodeEnv === 'staging') {
    console.warn('[config] WARNING: ADMIN_WALLET is not set in staging. Admin-seeding will be disabled. Set ADMIN_WALLET to suppress this warning.');
  }
}

// Validate SEP10_SERVER_SECRET.
// This is the signing keypair secret for SEP-10 challenge transactions.  It
// must be the same across every backend instance so that a challenge built by
// instance A can be verified by instance B.  In production the process refuses
// to start without it.  In staging a warning is emitted.  In development/test
// the absence is silently tolerated — a fallback is generated at the service
// layer so tests can run without extra config.
const sep10ServerSecretValue = process.env.SEP10_SERVER_SECRET ?? '';
if (!sep10ServerSecretValue) {
  if (nodeEnv === 'production') {
    throw new Error(
      'SEP10_SERVER_SECRET is required in production but is not set. ' +
      'Generate a Stellar keypair secret with `stellar keys generate` and set this variable. ' +
      'All backend instances must share the same value for challenge verification to work ' +
      'across a horizontally-scaled deployment.',
    );
  }
  if (nodeEnv === 'staging') {
    console.warn(
      '[config] WARNING: SEP10_SERVER_SECRET is not set in staging. ' +
      'Each process will generate an ephemeral keypair, causing cross-instance ' +
      'SEP-10 verification failures under load balancing. ' +
      'Set SEP10_SERVER_SECRET to suppress this warning.',
    );
  }
}

// Validate PINATA_GATEWAY when set — it must be a valid HTTPS URL. An invalid
// gateway would otherwise only surface as a runtime failure when resolving
// IPFS content, with no clear indication of the misconfiguration.
const pinataGatewayValue = process.env.PINATA_GATEWAY ?? '';
if (pinataGatewayValue) {
  let pinataGatewayIsHttps = false;
  try {
    pinataGatewayIsHttps = new URL(pinataGatewayValue).protocol === 'https:';
  } catch {
    pinataGatewayIsHttps = false;
  }
  if (!pinataGatewayIsHttps) {
    throw new Error(`Invalid PINATA_GATEWAY: "${pinataGatewayValue}". Must be a valid HTTPS URL.`);
  }
}

const ENV_LOG_LEVEL: Record<NodeEnv, LogLevel> = {
  development: 'debug',
  test: 'warn',
  staging: 'info',
  production: 'warn',
};

const DEFAULT_CORS_ORIGINS: Record<NodeEnv, string[]> = {
  development: ['*'],
  test: ['*'],
  staging: ['https://staging.scoutoff.io'],
  production: ['https://app.scoutoff.io', 'https://scoutoff.io'],
};

const rawCorsOrigins = process.env.CORS_ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS;
const corsAllowedOrigins =
  rawCorsOrigins !== undefined && rawCorsOrigins.trim() !== ''
    ? rawCorsOrigins.split(',').map((o) => o.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS[nodeEnv];

const config = {
  nodeEnv,
  port: parseInt(process.env.PORT ?? '4000', 10),
  network: (process.env.NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  horizonUrl:
    process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl:
    process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  contractId: required('CONTRACT_ID'),
  jwtSecret: required('JWT_SECRET'),
  /**
   * SEP-10 server signing keypair secret (Stellar strkey starting with 'S').
   * Must be identical on every backend instance.  See docs/auth.md for
   * configuration details and key-rotation guidance.
   */
  sep10ServerSecret: sep10ServerSecretValue,
  platformSecret: process.env.PLATFORM_SECRET ?? '',
  pinata: {
    apiKey: process.env.PINATA_API_KEY ?? '',
    secret: process.env.PINATA_SECRET ?? '',
    gateway: process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud',
    gateways: (process.env.IPFS_GATEWAYS || '').split(',').map(g => g.trim()).filter(Boolean) || [
      'https://gateway.pinata.cloud',
      'https://cloudflare-ipfs.com',
      'https://ipfs.io',
    ],
  },
  platformFeeBps: parseInt(process.env.PLATFORM_FEE_BPS ?? '500', 10),
  jwtSecretPrevious: process.env.JWT_SECRET_PREVIOUS ?? '',
  /**
   * Absolute end of the previous-secret grace window (epoch milliseconds).
   * Parsed from `JWT_SECRET_PREVIOUS_UNTIL` (Unix seconds or ISO-8601).
   * `null` means "no explicit expiry" — previous secret stays accepted until
   * operators clear `JWT_SECRET_PREVIOUS`.
   */
  jwtSecretPreviousUntil: (() => {
    const raw = process.env.JWT_SECRET_PREVIOUS_UNTIL?.trim();
    if (!raw) return null as number | null;
    // Pure digits → Unix seconds (or ms if already 13 digits)
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
      throw new Error(
        'JWT_SECRET_PREVIOUS_UNTIL must be a Unix timestamp (seconds) or ISO-8601 datetime',
      );
    }
    return parsed;
  })(),
  platformSecretKey: (() => {
    const isTest = (process.env.NODE_ENV ?? 'development') === 'test';
    const val = process.env.PLATFORM_SECRET_KEY ?? '';
    if (!val && !isTest) {
      throw new Error('PLATFORM_SECRET_KEY is required in non-test environments');
    }
    return val;
  })(),
  dbDriver: (() => {
    const raw = process.env.DB_DRIVER ?? 'sqlite';
    const valid = ['sqlite', 'postgres'] as const;
    if (!(valid as readonly string[]).includes(raw)) {
      throw new Error(
        `DB_DRIVER="${raw}" is invalid. Must be one of: ${valid.join(', ')}. ` +
        `Check for typos — an unrecognised value does NOT fall back to SQLite; the server will not start.`
      );
    }
    return raw as 'sqlite' | 'postgres';
  })(),
  dbPath: process.env.DB_PATH ?? 'scout-off.db',
  databaseUrl: process.env.DATABASE_URL ?? '',
  /**
   * Enable SSL/TLS for the PostgreSQL connection.
   *
   * Set DATABASE_SSL=true to enable SSL with certificate verification (the
   * default secure mode).  Set DATABASE_SSL=no-verify to enable SSL but skip
   * certificate verification (useful for self-signed certs in dev/staging; do
   * NOT use in production).  Leave unset or set to false to disable SSL
   * (suitable only for local / private-network Postgres without TLS).
   *
   * Most managed providers (RDS, Heroku, Supabase, Railway, Neon) require
   * SSL — set DATABASE_SSL=true for them.  See docs/postgres-migration.md for
   * per-provider examples.
   */
  databaseSsl: (() => {
    const raw = (process.env.DATABASE_SSL ?? '').toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true as const;
    if (raw === 'no-verify') return 'no-verify' as const;
    return false as const;
  })(),
  stellarHealthCheckEnabled: process.env.STELLAR_HEALTH_CHECK !== 'false',
  adminWallet: process.env.ADMIN_WALLET ?? '',
  adminWallets: (process.env.ADMIN_WALLETS ?? process.env.ADMIN_WALLET ?? '').split(',').map(w => w.trim()).filter(w => w.length > 0),
  adminThreshold: parseInt(process.env.ADMIN_THRESHOLD ?? '1', 10),
  securityHeaders: {
    hsts: process.env.SECURITY_HSTS ?? 'max-age=31536000; includeSubDomains',
    xContentTypeOptions: process.env.SECURITY_X_CONTENT_TYPE_OPTIONS ?? 'nosniff',
    xFrameOptions: process.env.SECURITY_X_FRAME_OPTIONS ?? 'DENY',
    referrerPolicy: process.env.SECURITY_REFERRER_POLICY ?? 'no-referrer',
    /** Content-Security-Policy value. Override via SECURITY_CSP env var. */
    csp: process.env.SECURITY_CSP ?? "default-src 'none'; frame-ancestors 'none'",
    /** Permissions-Policy value. Override via SECURITY_PERMISSIONS_POLICY env var. */
    permissionsPolicy: process.env.SECURITY_PERMISSIONS_POLICY ?? 'camera=(), microphone=(), geolocation=()',
  },
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED === 'true',
    url: process.env.WEBHOOK_URL ?? '',
    // HMAC secret for the legacy single-subscriber webhook (WEBHOOK_URL). Used to seed a
    // row in `webhook_subscriptions` on startup for backward compatibility. Real
    // multi-subscriber deployments should manage subscriptions in the DB instead.
    secret: process.env.WEBHOOK_SECRET ?? '',
  },
  // Symmetric key (32-byte hex, e.g. `openssl rand -hex 32`) used to encrypt
  // webhook_subscriptions.secret at rest (#686). Required in production —
  // see src/utils/webhookSecretCipher.ts and docs/secrets-rotation.md.
  webhookSecretEncryptionKey: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? '',
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? (process.env.NODE_ENV === 'test' ? '1000' : '60'), 10),
  },
  ipReputation: {
    // Disabled by default in tests: supertest sends every request from the
    // same loopback IP, so the many negative-path (401/403) assertions a
    // single test file exercises would otherwise accumulate enough
    // AUTH_FAILURE/ERROR_4XX points within one process to trip the
    // 'blocked' tier and 429 unrelated, later requests in the same file.
    enabled: process.env.IP_REPUTATION_ENABLED !== undefined
      ? process.env.IP_REPUTATION_ENABLED !== 'false'
      : process.env.NODE_ENV !== 'test',
  },
  authRateLimit: {
    windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? (process.env.NODE_ENV === 'test' ? '1000' : '5'), 10),
  },
  playerImportRateLimit: {
    windowMs: parseInt(process.env.PLAYER_IMPORT_RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.PLAYER_IMPORT_RATE_LIMIT_MAX ?? (process.env.NODE_ENV === 'test' ? '1000' : '5'), 10),
  },
  bodyLimit: {
    // Maximum JSON payload size (default: 1MB)
    json: process.env.JSON_PAYLOAD_LIMIT ?? '1mb',
    // Upload endpoints (player registration, milestone evidence) accept larger payloads (default: 10MB)
    upload: process.env.UPLOAD_PAYLOAD_LIMIT ?? '10mb',
    // Auth endpoints are restricted to small payloads to prevent DoS (default: 1KB)
    auth: '1kb',
  },
  corsAllowedOrigins,
  allowedOrigins: corsAllowedOrigins,
  logLevel: (process.env.LOG_LEVEL ?? ENV_LOG_LEVEL[nodeEnv]) as LogLevel,
  showErrorDetails: nodeEnv === 'development' || nodeEnv === 'test',
  useMockServices: nodeEnv === 'development' || nodeEnv === 'test',
  backfillFromLedger: process.env.INDEXER_BACKFILL_FROM_LEDGER
    ? parseInt(process.env.INDEXER_BACKFILL_FROM_LEDGER, 10)
    : null,
  /** Subscription grace period in hours after expiry during which access is still granted. */
  subscriptionGracePeriodHours: parseInt(
    process.env.SUBSCRIPTION_GRACE_PERIOD_HOURS ?? '24',
    10,
  ),
  /** Global request timeout in milliseconds before the server responds with 503. */
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS ?? '30000', 10),
  requestLog: {
    skipPaths: (process.env.LOG_SKIP_PATHS ?? '/health,/health/liveness,/health/readiness,/ready,/metrics')
      .split(',').map(p => p.trim()).filter(Boolean),
    sampleRate: parseFloat(process.env.LOG_SAMPLE_RATE ?? '1'),
  },
  /** TTL for player list cache entries in milliseconds. */
  playerCacheTtlMs: parseInt(process.env.PLAYER_CACHE_TTL_MS ?? '60000', 10),

  /** Access token TTL in seconds (default: 15 minutes). Configurable via JWT_ACCESS_TTL_SECONDS. */
  jwtAccessTtlSeconds: parseInt(process.env.JWT_ACCESS_TTL_SECONDS ?? '900', 10),

  /** Refresh token TTL in seconds (default: 7 days). */
  jwtRefreshTtlSeconds: 7 * 24 * 60 * 60,

  playerImport: {
    /** Maximum number of rows accepted per bulk player import request. */
    maxBatchSize: parseInt(process.env.PLAYER_IMPORT_MAX_BATCH ?? '500', 10),
  },

  // When set, the search cache (src/services/cache.ts) uses Redis so cache
  // state is shared across multiple backend instances. When unset (default),
  // it falls back to an in-memory Map — no setup required for local dev/CI.
  redisUrl: process.env.REDIS_URL || '',

  /** TTL for pinJson deduplication cache entries in milliseconds (default: 5 min). */
  pinJsonCacheTtlMs: parseInt(process.env.PIN_JSON_CACHE_TTL_MS ?? '300000', 10),

  /** Maximum evidence file size in bytes (default: 50 MB). */
  evidenceMaxBytes: parseInt(process.env.EVIDENCE_MAX_BYTES ?? String(50 * 1024 * 1024), 10),

  /** TTL for multi-admin action proposals in milliseconds (default: 1 hour). */
  adminActionTtlMs: parseInt(process.env.ADMIN_ACTION_TTL_MS ?? '3600000', 10),

  /** Minimum response size in bytes to trigger compression (default: 1024 bytes). */
  compressionThresholdBytes: parseInt(process.env.COMPRESSION_THRESHOLD ?? process.env.COMPRESSION_THRESHOLD_BYTES ?? '1024', 10),

};

export default config;

export function isProduction(): boolean { return config.nodeEnv === 'production'; }
export function isStaging(): boolean { return config.nodeEnv === 'staging'; }
export function isDevelopment(): boolean { return config.nodeEnv === 'development'; }

/** Route prefix constants for API versioning */
export const API_PREFIX = process.env.API_PREFIX ?? '/api';
export const API_V1_PREFIX = process.env.API_V1_PREFIX ?? '/api/v1';
export const API_V2_PREFIX = process.env.API_V2_PREFIX ?? '/api/v2';
