import dotenv from 'dotenv';
import envConstants from './config/env-constants.json';

// In production and staging, configuration must come only from the
// orchestrator (ConfigMap/Secrets). A stray .env baked into an image or
// mounted volume would otherwise silently fill in unset values, possibly with
// development secrets. Set DOTENV_ENABLED=true to opt back in explicitly.
const dotenvEnv = process.env.NODE_ENV ?? 'development';
if ((dotenvEnv !== 'production' && dotenvEnv !== 'staging') || process.env.DOTENV_ENABLED === 'true') {
  const result = dotenv.config();
  if (!result.error) console.info('[config] loaded .env file');
} else {
  console.info(`[config] skipping .env file (NODE_ENV=${dotenvEnv}; set DOTENV_ENABLED=true to load it)`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

interface NumericEnvOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Parse a numeric environment variable, throwing a clear startup error if
 * the value is not a valid number or falls outside the declared range.
 *
 * When the variable is unset (undefined), `defaultValue` is returned
 * without validation — defaults are always assumed to be in-range.
 *
 * @param name         Environment variable name (for error messages)
 * @param raw          The raw string value from process.env[name]
 * @param defaultValue Fallback when raw is undefined
 * @param options      Optional min/max range and integer flag
 */
function parseNumericEnv(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  options: NumericEnvOptions = {},
): number {
  if (raw === undefined) return defaultValue;

  const { min, max, integer = true } = options;
  const value = integer ? parseInt(raw, 10) : parseFloat(raw);

  if (Number.isNaN(value)) {
    const typeLabel = integer ? 'integer' : 'number';
    throw new Error(
      `Invalid ${name}: "${raw}" is not a valid ${typeLabel}. ` +
      `Set ${name} to a valid numeric value or remove it to use the default (${defaultValue}).`,
    );
  }

  if (min !== undefined && value < min) {
    throw new Error(
      `Invalid ${name}: ${value} is below the minimum allowed value of ${min}.`,
    );
  }

  if (max !== undefined && value > max) {
    throw new Error(
      `Invalid ${name}: ${value} exceeds the maximum allowed value of ${max}.`,
    );
  }

  return value;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type NodeEnv = 'development' | 'test' | 'staging' | 'production';

/**
 * Valid NODE_ENV values, shared with `scripts/validate-env.js` via
 * `src/config/env-constants.json` so the runtime pre-flight check and this
 * module can never disagree (#1541).
 */
export const VALID_ENVS: ReadonlySet<string> = new Set(envConstants.nodeEnvs);

const rawNodeEnv = process.env.NODE_ENV ?? 'development';
if (!VALID_ENVS.has(rawNodeEnv)) {
  throw new Error(`Invalid NODE_ENV: "${rawNodeEnv}". Must be one of: ${[...VALID_ENVS].join(', ')}`);
}
const nodeEnv = rawNodeEnv as NodeEnv;

function isLikelyPlaceholderSecret(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (!normalized) return true;

  const obviousPlaceholders = [
    'changeme',
    'change-me',
    'change_me',
    'example',
    'example-secret',
    'example_secret',
    'jwt-secret',
    'jwt_secret',
    'replace-me',
    'replace_me',
    'secret',
    'mysecret',
    'my-secret',
    'test-secret',
    'development-secret',
  ];

  if ((obviousPlaceholders as string[]).includes(normalized)) return true;

  // Decorated placeholder forms: optional prefix/suffix around a known stem,
  // with only trivial decoration (separators, digits). Long real secrets that
  // merely contain e.g. "secret" as a substring must NOT match.
  const decoratedPlaceholder =
    /^(change[-_]?me|replace[-_]?me|example([-_]secret)?|(my|test|development)?[-_]?secret|jwt[-_]?secret)[\-_0-9]*$/;
  return decoratedPlaceholder.test(normalized);
}

function validateSecretStrength(name: string, value: string): void {
  const trimmed = value.trim();
  const byteLength = new TextEncoder().encode(trimmed).length;

  if (isLikelyPlaceholderSecret(trimmed)) {
    if (nodeEnv === 'production' || nodeEnv === 'staging') {
      throw new Error(
        `${name} looks like a placeholder or default secret; set a unique value with at least 32 bytes.`,
      );
    }
    if (nodeEnv === 'development') {
      console.warn(
        `[config] WARNING: ${name} looks like a placeholder or default secret; set a unique value with at least 32 bytes.`,
      );
    }
    return;
  }

  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    if (byteLength < 32) {
      throw new Error(
        `${name} must be at least 32 bytes long in ${nodeEnv} (for example, 64 hex chars or 43+ base64 chars).`,
      );
    }
    return;
  }

  if (nodeEnv === 'development' && byteLength < 32) {
    console.warn(
      `[config] WARNING: ${name} is shorter than 32 bytes in development; this is allowed for local testing but not recommended for production.`,
    );
  }
}

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
      'across a horizontally-scaled deployment; otherwise each process generates its own ' +
      'ephemeral keypair, causing cross-instance SEP-10 verification failures under load balancing.',
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

// Validate API_KEY_LOOKUP_SECRET.
// This is the server-side pepper used to derive the indexed, deterministic
// lookup value stored in api_keys.lookup_hash (#1033).  It must be identical
// on every backend instance, otherwise a key issued by instance A cannot be
// located by instance B.  It is a *lookup* secret only — possession of a raw
// API key is still proven against the salted key_hash — but it must never be
// rotated casually: doing so orphans the stored lookup values (see
// docs/auth.md).  Production refuses to start without it; staging warns;
// development/test falls back to a fixed, insecure value at the derivation
// layer so the test suite runs without extra config.
const apiKeyLookupSecretValue = process.env.API_KEY_LOOKUP_SECRET ?? '';
if (!apiKeyLookupSecretValue) {
  if (nodeEnv === 'production') {
    throw new Error(
      'API_KEY_LOOKUP_SECRET is required in production but is not set. ' +
      'Generate one with `openssl rand -hex 32` and set this variable. ' +
      'All backend instances must share the same value, otherwise X-API-Key ' +
      'authentication will fail behind a load balancer. ' +
      'See docs/auth.md for rotation guidance.',
    );
  }
  if (nodeEnv === 'staging') {
    console.warn(
      '[config] WARNING: API_KEY_LOOKUP_SECRET is not set in staging. ' +
      'A fixed, insecure development-only pepper will be used to derive ' +
      'api_keys.lookup_hash. Set API_KEY_LOOKUP_SECRET to suppress this warning.',
    );
  }
}

// Validate NOTES_ENCRYPTION_KEY (#1328). Scout private notes are encrypted at
// rest with this symmetric key; production refuses to start without it.
const notesEncryptionKeyValue = process.env.NOTES_ENCRYPTION_KEY ?? '';
if (!notesEncryptionKeyValue) {
  if (nodeEnv === 'production') {
    throw new Error(
      'NOTES_ENCRYPTION_KEY is required in production but is not set. ' +
      'Generate one with `openssl rand -hex 32` and set this variable. ' +
      'See docs/secrets-rotation.md for rotation guidance.',
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

// Validate NETWORK and derive networkPassphrase with defaults per network type.
// Acceptable network values: 'testnet', 'mainnet', 'futurenet', 'standalone'.
// Default passphrases follow Stellar's convention for each network type.
export const VALID_NETWORKS: ReadonlySet<string> = new Set(envConstants.networks);

const rawNetwork = process.env.NETWORK ?? 'testnet';
if (!VALID_NETWORKS.has(rawNetwork)) {
  throw new Error(
    `Invalid NETWORK: "${rawNetwork}". Must be one of: ${[...VALID_NETWORKS].join(', ')}. ` +
    `Set NETWORK to a valid value or remove it to use the default (testnet).`,
  );
}
const network = rawNetwork as 'testnet' | 'mainnet' | 'futurenet' | 'standalone';

// Default passphrases per network type
const DEFAULT_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  standalone: 'Standalone Network ; February 2017',
};

const rawNetworkPassphrase = process.env.NETWORK_PASSPHRASE;
const networkPassphrase = rawNetworkPassphrase ?? DEFAULT_PASSPHRASES[network];

// Log the effective network and passphrase on startup for visibility
console.log(
  `[config] Network: ${network}`,
  rawNetworkPassphrase ? '' : '(default)',
  `Passphrase: "${networkPassphrase}"`,
  rawNetworkPassphrase ? '' : '(default)',
);

// Validate NETWORK_PASSPHRASE is present (though we have defaults, explicit override should be set)
if (!rawNetworkPassphrase && network === 'standalone') {
  // For standalone, always require explicit passphrase to avoid misconfiguration
  throw new Error(
    'NETWORK_PASSPHRASE must be set when NETWORK=standalone. ' +
    'For the local Soroban sandbox, set: NETWORK_PASSPHRASE="Standalone Network ; February 2017"',
  );
}

// Guard: production with NETWORK != mainnet emits a warning
// This helps catch accidental testnet/futurenet usage in production
if (nodeEnv === 'production' && network !== 'mainnet') {
  console.warn(
    `[config] WARNING: Production deployment using ${network}. ` +
    `This is not recommended for production. Set NETWORK=mainnet to suppress this warning.`,
  );
}

const config = {
  nodeEnv,
  port: parseNumericEnv('PORT', process.env.PORT, 4000, { min: 0, max: 65535, integer: true }),
  network,
  networkPassphrase,
  horizonUrl:
    process.env.HORIZON_URL ??
    (network === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'),
  sorobanRpcUrl:
    process.env.SOROBAN_RPC_URL ??
    (network === 'mainnet' ? 'https://sorobanrpc.stellar.org' : 'https://soroban-testnet.stellar.org'),
  /**
   * Legacy single-contract ID — kept for backward compatibility with any code
   * that has not yet been migrated to the per-contract IDs below.
   * Points to the register contract by default when CONTRACT_ID is set.
   * New code should use the specific per-contract IDs instead.
   */
  contractId: process.env.CONTRACT_ID ?? '',

  // ── Per-contract IDs (multi-contract architecture) ──────────────────────────
  // Each Soroban crate is deployed as its own contract with its own address.
  // The backend must route each call to the correct contract.
  //
  // Fallback chain for each: specific env var → CONTRACT_ID (legacy monolith) → ''
  // This means single-contract deployments that set only CONTRACT_ID continue to
  // work; multi-contract deployments set each ID independently.

  /** Address of the deployed `register` Soroban contract. */
  registerContractId: process.env.REGISTER_CONTRACT_ID ?? process.env.CONTRACT_ID ?? '',

  /** Address of the deployed `progress` Soroban contract. */
  progressContractId: process.env.PROGRESS_CONTRACT_ID ?? process.env.CONTRACT_ID ?? '',

  /** Address of the deployed `subscription` Soroban contract. */
  subscriptionContractId: process.env.SUBSCRIPTION_CONTRACT_ID ?? process.env.CONTRACT_ID ?? '',

  /** Address of the deployed `connection` Soroban contract. */
  connectionContractId: process.env.CONNECTION_CONTRACT_ID ?? process.env.CONTRACT_ID ?? '',
  jwtSecret: (() => {
    const value = required('JWT_SECRET');
    validateSecretStrength('JWT_SECRET', value);
    return value;
  })(),
  /**
   * SEP-10 server signing keypair secret (Stellar strkey starting with 'S').
   * Must be identical on every backend instance.  See docs/auth.md for
   * configuration details and key-rotation guidance.
   */
  sep10ServerSecret: sep10ServerSecretValue,
  /**
   * Server-side pepper (32-byte hex, e.g. `openssl rand -hex 32`) used to
   * derive `api_keys.lookup_hash`, the indexed deterministic value that lets
   * X-API-Key authentication find a candidate row without scanning the table
   * (#1033).  Must be identical on every backend instance.  See
   * src/utils/apiKeyLookup.ts and docs/auth.md.
   */
  apiKeyLookupSecret: apiKeyLookupSecretValue,
  platformSecret: process.env.PLATFORM_SECRET ?? '',
  pinata: {
    apiKey: process.env.PINATA_API_KEY ?? '',
    secret: process.env.PINATA_SECRET ?? '',
    gateway: process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud',
    gateways: process.env.IPFS_GATEWAYS
      ? process.env.IPFS_GATEWAYS.split(',').map(g => g.trim()).filter(Boolean)
      : [
        'https://gateway.pinata.cloud',
        'https://cloudflare-ipfs.com',
        'https://ipfs.io',
      ],
  },
  platformFeeBps: parseNumericEnv('PLATFORM_FEE_BPS', process.env.PLATFORM_FEE_BPS, 500, { min: 0, max: 10000, integer: true }),
  jwtSecretPrevious: (() => {
    const value = process.env.JWT_SECRET_PREVIOUS ?? '';
    if (value) validateSecretStrength('JWT_SECRET_PREVIOUS', value);
    return value;
  })(),
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
    const valid = envConstants.dbDrivers as readonly string[];
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
  /**
   * Max concurrent connections in the PostgreSQL connection pool. Each
   * connection can run one query at a time, so this is effectively the
   * PostgresDriver's concurrency ceiling — requests beyond this queue for a
   * free connection rather than failing. Ignored when DB_DRIVER=sqlite.
   */
  databasePoolSize: parseNumericEnv('DATABASE_POOL_SIZE', process.env.DATABASE_POOL_SIZE, 10, { min: 1, max: 100, integer: true }),
  sqliteBusyTimeoutMs: parseNumericEnv('SQLITE_BUSY_TIMEOUT_MS', process.env.SQLITE_BUSY_TIMEOUT_MS, 5000, { min: 1, integer: true }),
  databaseStatementTimeoutMs: parseNumericEnv('DB_STATEMENT_TIMEOUT_MS', process.env.DB_STATEMENT_TIMEOUT_MS, 25000, { min: 1, integer: true }),
  databaseQueryTimeoutMs: parseNumericEnv('DB_QUERY_TIMEOUT_MS', process.env.DB_QUERY_TIMEOUT_MS, 30000, { min: 1, integer: true }),
  databaseIdleTransactionTimeoutMs: parseNumericEnv('DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS', process.env.DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS, 60000, { min: 1, integer: true }),
  stellarHealthCheckEnabled: process.env.STELLAR_HEALTH_CHECK !== 'false',
  adminWallet: process.env.ADMIN_WALLET ?? '',
  adminWallets: (process.env.ADMIN_WALLETS ?? process.env.ADMIN_WALLET ?? '').split(',').map(w => w.trim()).filter(w => w.length > 0),
  adminThreshold: parseNumericEnv('ADMIN_THRESHOLD', process.env.ADMIN_THRESHOLD, 1, { min: 1, integer: true }),
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
    /**
     * Per-attempt timeout (ms) for outbound webhook delivery requests (#691).
     * An unresponsive subscriber is aborted after this window and the attempt
     * is treated as a failure, proceeding to retry/backoff or dead-lettering
     * per the existing postWebhookWithRetry logic, rather than hanging
     * indefinitely.
     */
    timeoutMs: parseNumericEnv('WEBHOOK_TIMEOUT_MS', process.env.WEBHOOK_TIMEOUT_MS, 10000, { min: 1, integer: true }),
  },
  /**
   * Dead-letter queue alerting (#1131).
   * Size threshold: absolute pending+in_progress row count.
   * Rate threshold: inserts within rateWindowMs.
   * Optional PLATFORM_ADMIN_NOTIFY_URL receives a JSON POST on crossing.
   */
  webhookDeadLetterAlert: {
    sizeThreshold: parseNumericEnv(
      'WEBHOOK_DLQ_SIZE_THRESHOLD',
      process.env.WEBHOOK_DLQ_SIZE_THRESHOLD,
      100,
      { min: 1, integer: true },
    ),
    rateThreshold: parseNumericEnv(
      'WEBHOOK_DLQ_RATE_THRESHOLD',
      process.env.WEBHOOK_DLQ_RATE_THRESHOLD,
      50,
      { min: 1, integer: true },
    ),
    rateWindowMs: parseNumericEnv(
      'WEBHOOK_DLQ_RATE_WINDOW_MS',
      process.env.WEBHOOK_DLQ_RATE_WINDOW_MS,
      5 * 60 * 1000,
      { min: 1000, integer: true },
    ),
    adminNotifyUrl: process.env.PLATFORM_ADMIN_NOTIFY_URL ?? '',
  },
  // Symmetric key (32-byte hex, e.g. `openssl rand -hex 32`) used to encrypt
  // webhook_subscriptions.secret at rest (#686). Required in production —
  // see src/utils/webhookSecretCipher.ts and docs/secrets-rotation.md.
  webhookSecretEncryptionKey: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? '',
  webhookSecretEncryptionKeyPrevious: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS ?? '',
  // Symmetric key (32-byte hex) for scout_player_notes* content at rest (#1328).
  notesEncryptionKey: process.env.NOTES_ENCRYPTION_KEY ?? '',
  notesEncryptionKeyPrevious: process.env.NOTES_ENCRYPTION_KEY_PREVIOUS ?? '',
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowMs: parseNumericEnv('RATE_LIMIT_WINDOW_MS', process.env.RATE_LIMIT_WINDOW_MS, 60000, { min: 1, integer: true }),
    max: parseNumericEnv('RATE_LIMIT_MAX', process.env.RATE_LIMIT_MAX, process.env.NODE_ENV === 'test' ? 1000 : 60, { min: 1, integer: true }),
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
    windowMs: parseNumericEnv('AUTH_RATE_LIMIT_WINDOW_MS', process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60000, { min: 1, integer: true }),
    ipMax: parseNumericEnv('AUTH_RATE_LIMIT_IP_MAX', process.env.AUTH_RATE_LIMIT_IP_MAX, 60, { min: 1, integer: true }),
    max: parseNumericEnv('AUTH_RATE_LIMIT_MAX', process.env.AUTH_RATE_LIMIT_MAX, process.env.NODE_ENV === 'test' ? 1000 : 5, { min: 1, integer: true }),
  },
  playerImportRateLimit: {
    windowMs: parseNumericEnv('PLAYER_IMPORT_RATE_LIMIT_WINDOW_MS', process.env.PLAYER_IMPORT_RATE_LIMIT_WINDOW_MS, 60000, { min: 1, integer: true }),
    max: parseNumericEnv('PLAYER_IMPORT_RATE_LIMIT_MAX', process.env.PLAYER_IMPORT_RATE_LIMIT_MAX, process.env.NODE_ENV === 'test' ? 1000 : 5, { min: 1, integer: true }),
  },
  // Stricter than the default walletRateLimit() pool (#1037): this endpoint's
  // entire purpose is to make the backend issue an outbound HTTP request to a
  // caller-supplied URL, so its per-wallet cost is much higher than a normal
  // write. Tuned to the same 5/min ceiling as admin bulk-import.
  webhookTestRateLimit: {
    windowMs: parseNumericEnv('WEBHOOK_TEST_RATE_LIMIT_WINDOW_MS', process.env.WEBHOOK_TEST_RATE_LIMIT_WINDOW_MS, 60000, { min: 1, integer: true }),
    max: parseNumericEnv('WEBHOOK_TEST_RATE_LIMIT_MAX', process.env.WEBHOOK_TEST_RATE_LIMIT_MAX, process.env.NODE_ENV === 'test' ? 1000 : 5, { min: 1, integer: true }),
  },
  // Per-player milestone submission rate limit (#1137): guards against a
  // validator (or compromised key) flooding a single player's milestone history.
  // Default: 10 submissions per player per hour.
  milestonePlayerRateLimit: {
    windowMs: parseNumericEnv('MILESTONE_PLAYER_RATE_WINDOW_MS', process.env.MILESTONE_PLAYER_RATE_WINDOW_MS, 3_600_000, { min: 1, integer: true }),
    max: parseNumericEnv('MILESTONE_PLAYER_RATE_MAX', process.env.MILESTONE_PLAYER_RATE_MAX, process.env.NODE_ENV === 'test' ? 1000 : 10, { min: 1, integer: true }),
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
    ? parseNumericEnv('INDEXER_BACKFILL_FROM_LEDGER', process.env.INDEXER_BACKFILL_FROM_LEDGER, 0, { min: 0, integer: true })
    : null,
  /** Subscription grace period in hours after expiry during which access is still granted. */
  subscriptionGracePeriodHours: parseNumericEnv('SUBSCRIPTION_GRACE_PERIOD_HOURS', process.env.SUBSCRIPTION_GRACE_PERIOD_HOURS, 24, { min: 0, integer: true }),
  /** Global request timeout in milliseconds before the server responds with 503. */
  requestTimeoutMs: parseNumericEnv('REQUEST_TIMEOUT_MS', process.env.REQUEST_TIMEOUT_MS, 30000, { min: 1, integer: true }),
  /**
   * HTTP server socket timeouts (#1593). keepAliveTimeoutMs must be shorter
   * than the load balancer's idle timeout to avoid 502s on reused sockets,
   * and headersTimeoutMs must be greater than keepAliveTimeoutMs (enforced
   * below). requestTimeoutMs here applies to receiving the request, not to
   * long-lived SSE response streams.
   */
  http: {
    keepAliveTimeoutMs: parseNumericEnv('HTTP_KEEP_ALIVE_TIMEOUT_MS', process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 65000, { min: 1, integer: true }),
    headersTimeoutMs: parseNumericEnv('HTTP_HEADERS_TIMEOUT_MS', process.env.HTTP_HEADERS_TIMEOUT_MS, 66000, { min: 1, integer: true }),
    requestTimeoutMs: parseNumericEnv('HTTP_REQUEST_TIMEOUT_MS', process.env.HTTP_REQUEST_TIMEOUT_MS, 120000, { min: 1, integer: true }),
  },
  /** Lease expiry for pending idempotency claims (ms). A crashed request releases its claim after this window. */
  idempotencyLeaseMs: parseNumericEnv('IDEMPOTENCY_LEASE_MS', process.env.IDEMPOTENCY_LEASE_MS, 35000, { min: 1000, integer: true }),
  /**
   * Bounded Soroban transaction-confirmation poll window (ms). When a
   * submitted pay_to_contact/subscribe transaction has not reached a final
   * status (SUCCESS/FAILED) within this window, the payment is reported as
   * failed rather than treated as confirmed (Issue #761).
   */
  txConfirmationTimeoutMs: parseNumericEnv('TX_CONFIRMATION_TIMEOUT_MS', process.env.TX_CONFIRMATION_TIMEOUT_MS, 60000, { min: 1000, integer: true }),
  /** Per-request HTTP timeout for Pinata/IPFS axios calls (ms). */
  ipfsHttpTimeoutMs: parseNumericEnv('IPFS_HTTP_TIMEOUT_MS', process.env.IPFS_HTTP_TIMEOUT_MS, 15000, { min: 1, integer: true }),
  /** Per-request HTTP timeout for Soroban RPC / Stellar SDK calls (ms). */
  stellarRpcTimeoutMs: parseNumericEnv('STELLAR_RPC_TIMEOUT_MS', process.env.STELLAR_RPC_TIMEOUT_MS, 15000, { min: 1, integer: true }),
  requestLog: {
    skipPaths: (process.env.LOG_SKIP_PATHS ?? '/health,/health/liveness,/health/readiness,/ready,/metrics')
      .split(',').map(p => p.trim()).filter(Boolean),
    sampleRate: parseNumericEnv('LOG_SAMPLE_RATE', process.env.LOG_SAMPLE_RATE, 1, { min: 0, max: 1, integer: false }),
  },
  /** TTL for player list cache entries in milliseconds. */
  playerCacheTtlMs: parseNumericEnv('PLAYER_CACHE_TTL_MS', process.env.PLAYER_CACHE_TTL_MS, 60000, { min: 0, integer: true }),

  /**
   * Cache key namespace prefix. Prepended to every key written to the cache
   * store so that two deployments (e.g. staging + production) sharing the
   * same Redis instance cannot collide (#672).
   *
   * Defaults to the current NODE_ENV so keys are always environment-scoped
   * without any explicit operator configuration. Override with CACHE_NAMESPACE
   * to distinguish blue/green pairs or other same-environment deployments that
   * share infrastructure.
   *
   * Example: with CACHE_NAMESPACE=production, the key `players:list:…` is
   * stored under `production:players:list:…` in Redis.
   */
  cacheNamespace: process.env.CACHE_NAMESPACE ?? (rawNodeEnv || 'development'),

  /**
   * Default API key expiry in days. Keys issued without an explicit
   * expiresInDays value expire after this many days from issuance (#674).
   * Set to 0 to disable the default expiry (not recommended for production).
   */
  apiKeyDefaultTtlDays: parseNumericEnv('API_KEY_DEFAULT_TTL_DAYS', process.env.API_KEY_DEFAULT_TTL_DAYS, 90, { min: 0, integer: true }),

  /** Access token TTL in seconds (default: 15 minutes). Configurable via JWT_ACCESS_TTL_SECONDS. */
  jwtAccessTtlSeconds: parseNumericEnv('JWT_ACCESS_TTL_SECONDS', process.env.JWT_ACCESS_TTL_SECONDS, 900, { min: 1, integer: true }),

  /** Refresh token TTL in seconds (default: 7 days). */
  jwtRefreshTtlSeconds: 7 * 24 * 60 * 60,

  /**
   * How long a trial offer remains open for accept/reject, in milliseconds.
   * After this window the offer is considered expired and cannot be responded to.
   * Default: 30 days. Set TRIAL_OFFER_TTL_MS=0 to disable expiry (not recommended).
   */
  trialOfferTtlMs: parseNumericEnv('TRIAL_OFFER_TTL_MS', process.env.TRIAL_OFFER_TTL_MS, 30 * 24 * 60 * 60 * 1000, { min: 0, integer: true }),

  playerImport: {
    /** Maximum number of rows accepted per bulk player import request. */
    maxBatchSize: parseNumericEnv('PLAYER_IMPORT_MAX_BATCH', process.env.PLAYER_IMPORT_MAX_BATCH, 500, { min: 1, integer: true }),
  },

  // When set, the search cache (src/services/cache.ts) uses Redis so cache
  // state is shared across multiple backend instances. When unset (default),
  // it falls back to an in-memory Map — no setup required for local dev/CI.
  redisUrl: process.env.REDIS_URL || '',

  /** In-memory search cache max entries; LRU eviction applies after TTL expiry (default: 1000). */
  searchCacheMaxEntries: parseNumericEnv('SEARCH_CACHE_MAX_ENTRIES', process.env.SEARCH_CACHE_MAX_ENTRIES, 1000, { min: 1, integer: true }),

  /** TTL for pinJson deduplication cache entries in milliseconds (default: 5 min). */
  pinJsonCacheTtlMs: parseNumericEnv('PIN_JSON_CACHE_TTL_MS', process.env.PIN_JSON_CACHE_TTL_MS, 300000, { min: 0, integer: true }),

  /** Age threshold for pending pins before reconciliation in milliseconds (default: 5 min). */
  ipfsReconcileAgeMs: parseNumericEnv('IPFS_RECONCILE_AGE_MS', process.env.IPFS_RECONCILE_AGE_MS, 300000, { min: 0, integer: true }),

  /** Scheduled interval for IPFS pending pin reconciliation in milliseconds (default: 60s). */
  ipfsReconcileIntervalMs: parseNumericEnv('IPFS_RECONCILE_INTERVAL_MS', process.env.IPFS_RECONCILE_INTERVAL_MS, 60000, { min: 1000, integer: true }),

  /** Interval for IPFS pending-pin retry attempts in milliseconds (default: 30s, min: 5s). */
  ipfsPinRetryIntervalMs: parseNumericEnv('IPFS_PIN_RETRY_INTERVAL_MS', process.env.IPFS_PIN_RETRY_INTERVAL_MS, 30000, { min: 5000, integer: true }),

  /** Max attempts before expiring a stuck pending pin during reconciliation (default: 5). */
  ipfsReconcileMaxAttempts: parseNumericEnv('IPFS_RECONCILE_MAX_ATTEMPTS', process.env.IPFS_RECONCILE_MAX_ATTEMPTS, 5, { min: 1, integer: true }),

  /** Maximum evidence file size in bytes (default: 50 MB). */
  evidenceMaxBytes: parseNumericEnv('EVIDENCE_MAX_BYTES', process.env.EVIDENCE_MAX_BYTES, 50 * 1024 * 1024, { min: 1, integer: true }),
  evidenceValidatorBytesPerHour: parseNumericEnv('EVIDENCE_VALIDATOR_BYTES_PER_HOUR', process.env.EVIDENCE_VALIDATOR_BYTES_PER_HOUR, 500 * 1024 * 1024, { min: 1, integer: true }),

  /** TTL for multi-admin action proposals in milliseconds (default: 1 hour). */
  adminActionTtlMs: parseNumericEnv('ADMIN_ACTION_TTL_MS', process.env.ADMIN_ACTION_TTL_MS, 3600000, { min: 1, integer: true }),

  /** Minimum response size in bytes to trigger compression (default: 1024 bytes). */
  compressionThresholdBytes: parseNumericEnv('COMPRESSION_THRESHOLD', process.env.COMPRESSION_THRESHOLD ?? process.env.COMPRESSION_THRESHOLD_BYTES, 1024, { min: 1, integer: true }),

  /**
   * Log redaction configuration for sensitive data in production logs.
   * In development, redaction is always disabled (pass-through).
   */
  logRedaction: {
    /** Enable redaction in non-development environments (default: true for staging/production) */
    enabled: nodeEnv !== 'development' && process.env.LOG_REDACTION_ENABLED !== 'false',
    /** Number of characters to preserve at the start of masked wallet addresses (default: 1) */
    walletPrefixLength: parseNumericEnv('LOG_REDACTION_WALLET_PREFIX', process.env.LOG_REDACTION_WALLET_PREFIX, 1, { min: 1, max: 10, integer: true }),
    /** Number of characters to preserve at the end of masked wallet addresses (default: 4) */
    walletSuffixLength: parseNumericEnv('LOG_REDACTION_WALLET_SUFFIX', process.env.LOG_REDACTION_WALLET_SUFFIX, 4, { min: 1, max: 10, integer: true }),
    /** Hash correlation IDs instead of logging them raw (default: false) */
    hashCorrelationIds: process.env.LOG_REDACTION_HASH_CORRELATION_IDS === 'true',
  },

  /**
   * Tier divergence reconciliation job config (#1132).
   * Compares derived (off-chain) tier against stored progress_level and
   * emits scout_off_tier_divergence_total + structured log per mismatch.
   *
   * TIER_DIVERGENCE_INTERVAL_MS  — how often to run (default: 5 min)
   * TIER_DIVERGENCE_SAMPLE_SIZE  — max players to check per run (default: 100)
   */
  tierDivergence: {
    intervalMs: parseNumericEnv('TIER_DIVERGENCE_INTERVAL_MS', process.env.TIER_DIVERGENCE_INTERVAL_MS, 300_000, { min: 1000, integer: true }),
    sampleSize: parseNumericEnv('TIER_DIVERGENCE_SAMPLE_SIZE', process.env.TIER_DIVERGENCE_SAMPLE_SIZE, 100, { min: 1, integer: true }),
  },

  // ── Readiness / health check timeouts ──────────────────────────────────
  // Per-component timeout for readiness probes (#1317)
  readiness: {
    timeouts: {
      dbMs: parseNumericEnv('READINESS_DB_TIMEOUT_MS', process.env.READINESS_DB_TIMEOUT_MS, 2000, { min: 100, max: 30000, integer: true }),
      ipfsMs: parseNumericEnv('READINESS_IPFS_TIMEOUT_MS', process.env.READINESS_IPFS_TIMEOUT_MS, 5000, { min: 100, max: 30000, integer: true }),
      stellarMs: parseNumericEnv('READINESS_STELLAR_TIMEOUT_MS', process.env.READINESS_STELLAR_TIMEOUT_MS, 5000, { min: 100, max: 30000, integer: true }),
    },
    maxLag: parseNumericEnv('READINESS_MAX_LAG', process.env.READINESS_MAX_LAG, 100, { min: 0, integer: true }),
    gracePeriodMs: parseNumericEnv('READINESS_GRACE_PERIOD_MS', process.env.READINESS_GRACE_PERIOD_MS, 5 * 60 * 1000, { min: 0, integer: true }),
  },

  // ── SSE settings ──────────────────────────────────────────────────────

  // ── Shutdown configuration ────────────────────────────────────────────
  shutdown: {
    timeoutMs: parseNumericEnv('SHUTDOWN_TIMEOUT_MS', process.env.SHUTDOWN_TIMEOUT_MS, 10_000, { min: 1_000, max: 600_000, integer: true }),
    prestopDelayMs: parseNumericEnv('SHUTDOWN_PRESTOP_DELAY_MS', process.env.SHUTDOWN_PRESTOP_DELAY_MS, 0, { min: 0, max: 120_000, integer: true }),
  },

  // ── Server-Sent Events (SSE) ──────────────────────────────────────────
  // Read through the getters in src/routes/events.ts; tests override these
  // fields directly (e.g. `config.sse.maxConnections = 1`).
  sse: {
    /** Interval between keep-alive pings sent to SSE clients (ms). */
    keepaliveIntervalMs: parseNumericEnv('SSE_KEEPALIVE_INTERVAL_MS', process.env.SSE_KEEPALIVE_INTERVAL_MS, 15000, { min: 1000, max: 120000, integer: true }),
    /** Interval for shared SSE auth sweep (re-check revocations, blocklists) (ms). */
    authSweepIntervalMs: parseNumericEnv('SSE_AUTH_SWEEP_INTERVAL_MS', process.env.SSE_AUTH_SWEEP_INTERVAL_MS, 30000, { min: 1000, max: 600000, integer: true }),
    /** Max concurrent SSE connections (0 = unlimited). */
    maxConnections: parseNumericEnv('SSE_MAX_CONNECTIONS', process.env.SSE_MAX_CONNECTIONS, 0, { min: 0, integer: true }),
    /** Max concurrent SSE connections per authenticated wallet (0 = unlimited). */
    maxConnectionsPerWallet: parseNumericEnv('SSE_MAX_CONNECTIONS_PER_WALLET', process.env.SSE_MAX_CONNECTIONS_PER_WALLET, 5, { min: 0, integer: true }),
    /** Base retry interval for SSE reconnect hints (ms); jitter is added per connection. */
    retryMs: parseNumericEnv('SSE_RETRY_MS', process.env.SSE_RETRY_MS, 5000, { min: 1, max: 300000, integer: true }),
  },

  // ── In-memory cache limits and TTLs ───────────────────────────────────
  // Read at use time so tests can override fields directly.
  cache: {
    /** Max entries in src/services/inMemoryCacheStore.ts before eviction. */
    maxEntries: parseNumericEnv('CACHE_MAX_ENTRIES', process.env.CACHE_MAX_ENTRIES, 1000, { min: 1, integer: true }),
    /** Max entries in the in-memory store in src/services/cacheStore.ts (LRU eviction). */
    maxSize: parseNumericEnv('CACHE_MAX_SIZE', process.env.CACHE_MAX_SIZE, 1000, { min: 1, integer: true }),
    /** Max entries in the process-local bounded player cache (src/services/cache.ts). */
    playerMaxSize: parseNumericEnv('PLAYER_CACHE_MAX_SIZE', process.env.PLAYER_CACHE_MAX_SIZE, 1000, { min: 1, integer: true }),
    /** TTL for synchronous feature-flag lookups (ms). 0 disables caching. */
    featureFlagTtlMs: parseNumericEnv('FEATURE_FLAG_CACHE_TTL_MS', process.env.FEATURE_FLAG_CACHE_TTL_MS, 5000, { min: 0, integer: true }),
    /** TTL for cached wallet-blocklist entries (ms). 0 disables caching. */
    walletBlocklistTtlMs: parseNumericEnv('WALLET_BLOCKLIST_CACHE_TTL_MS', process.env.WALLET_BLOCKLIST_CACHE_TTL_MS, 30000, { min: 0, integer: true }),
  },

  // ── GraphQL DataLoader concurrency ────────────────────────────────────
  /** Max in-flight RPC calls for the milestone GraphQL DataLoader. */
  milestoneLoaderConcurrency: parseNumericEnv('MILESTONE_LOADER_CONCURRENCY', process.env.MILESTONE_LOADER_CONCURRENCY, 8, { min: 1, integer: true }),

  // ── Reindexing / catch-up mode ────────────────────────────────────────
  // Batch sizes are capped at 10 000 ledgers, the maximum reindex range
  // (MAX_REINDEX_RANGE in src/services/reindexService.ts).
  reindex: {
    /** Ledgers processed per batch in steady-state mode. */
    batchSize: parseNumericEnv('REINDEX_BATCH_SIZE', process.env.REINDEX_BATCH_SIZE, 100, { min: 1, max: 10000, integer: true }),
    /** Delay between reindex batches in steady-state mode (ms). */
    batchDelayMs: parseNumericEnv('REINDEX_BATCH_DELAY_MS', process.env.REINDEX_BATCH_DELAY_MS, 50, { min: 0, max: 60000, integer: true }),
    /** Ledgers processed per batch in catch-up mode (further capped at 1 000 by the service). */
    catchupBatchSize: parseNumericEnv('REINDEX_CATCHUP_BATCH_SIZE', process.env.REINDEX_CATCHUP_BATCH_SIZE, 500, { min: 1, max: 10000, integer: true }),
    /** Remaining-ledger threshold above which catch-up mode activates. */
    catchupThreshold: parseNumericEnv('REINDEX_CATCHUP_THRESHOLD', process.env.REINDEX_CATCHUP_THRESHOLD, 500, { min: 1, integer: true }),
    /** Backoff when RPC returns rate-limit errors during reindex (ms). */
    rateLimitBackoffMs: parseNumericEnv('REINDEX_RATE_LIMIT_BACKOFF_MS', process.env.REINDEX_RATE_LIMIT_BACKOFF_MS, 2000, { min: 1, max: 300000, integer: true }),
  },

  // ── Indexer settings ──────────────────────────────────────────────────
  indexer: {
    /** Finality margin: ledgers to hold back from tip to avoid reorgs. */
    finalityMargin: parseNumericEnv('INDEXER_FINALITY_MARGIN', process.env.INDEXER_FINALITY_MARGIN, 10, { min: 0, max: 1000, integer: true }),
    /** Ledger lag threshold before warning logs are emitted. */
    lagWarnThreshold: parseNumericEnv('INDEXER_LAG_WARN_THRESHOLD', process.env.INDEXER_LAG_WARN_THRESHOLD, 100, { min: 1, integer: true }),
  },

  // ── Proxy settings ────────────────────────────────────────────────────
  /** Number of trusted reverse-proxy hops in front of this server (for IP resolution). */
  trustedProxyCount: parseNumericEnv('TRUSTED_PROXY_COUNT', process.env.TRUSTED_PROXY_COUNT, 1, { min: 1, integer: true }),

  // ── Database query monitoring ─────────────────────────────────────────
  /** Log queries slower than this threshold (ms). */
  slowQueryThresholdMs: parseNumericEnv('SLOW_QUERY_THRESHOLD_MS', process.env.SLOW_QUERY_THRESHOLD_MS, 50, { min: 0, integer: true }),

  // ── Circuit breakers ──────────────────────────────────────────────────
  // Default circuit breaker thresholds for generic outbound calls (Stellar RPC, etc.).
  circuitBreaker: {
    failureThreshold: parseNumericEnv('CIRCUIT_BREAKER_FAILURE_THRESHOLD', process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5, { min: 1, integer: true }),
    resetTimeoutMs: parseNumericEnv('CIRCUIT_BREAKER_RESET_TIMEOUT_MS', process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 30000, { min: 1, integer: true }),
  },
  // IPFS pinning circuit breaker (often tighter than generic).
  ipfsBreaker: {
    failureThreshold: parseNumericEnv('IPFS_BREAKER_FAILURE_THRESHOLD', process.env.IPFS_BREAKER_FAILURE_THRESHOLD, 5, { min: 1, integer: true }),
    resetTimeoutMs: parseNumericEnv('IPFS_BREAKER_RESET_TIMEOUT_MS', process.env.IPFS_BREAKER_RESET_TIMEOUT_MS, 30000, { min: 1, integer: true }),
  },

  // ── Database migration validation (#1318) ─────────────────────────────
  /** Migration checksum policy: "strict" fails startup on mismatch (prod), "warn" logs and continues (dev). */
  migrationChecksumMode: (() => {
    const mode = (process.env.MIGRATION_CHECKSUM_MODE ?? '').toLowerCase();
    const valid = ['strict', 'warn'] as const;
    const validStr = valid as readonly string[];
    if (mode && !validStr.includes(mode)) {
      throw new Error(`Invalid MIGRATION_CHECKSUM_MODE="${mode}". Must be one of: ${valid.join(', ')}`);
    }
    // Default: strict in production, warn in dev/staging/test
    if (mode) return mode as typeof valid[number];
    return nodeEnv === 'production' ? 'strict' : 'warn';
  })(),

  // ── Rate limiter failure policy (#1320) ────────────────────────────────
  /**
   * When the rate limiter's store (Redis) fails, what to do:
   * - 'open': allow requests (fail-open, availability over security)
   * - 'closed': reject with 503 (fail-closed, security over availability)
   * - 'local': fall back to per-instance in-memory counters (hybrid)
   * Default: 'open' for general routes, 'closed' for auth endpoints.
   */
  rateLimitErrorPolicy: (() => {
    const policy = (process.env.RATE_LIMIT_ERROR_POLICY ?? '').toLowerCase();
    const valid = ['open', 'closed', 'local'] as const;
    const validStr = valid as readonly string[];
    if (policy && !validStr.includes(policy)) {
      throw new Error(`Invalid RATE_LIMIT_ERROR_POLICY="${policy}". Must be one of: ${valid.join(', ')}`);
    }
    return policy as typeof valid[number] | '';
  })(),

  authRateLimitErrorPolicy: (() => {
    const policy = (process.env.AUTH_RATE_LIMIT_ERROR_POLICY ?? '').toLowerCase();
    const valid = ['open', 'closed', 'local'] as const;
    const validStr = valid as readonly string[];
    if (policy && !validStr.includes(policy)) {
      throw new Error(`Invalid AUTH_RATE_LIMIT_ERROR_POLICY="${policy}". Must be one of: ${valid.join(', ')}`);
    }
    // Auth endpoints default to more restrictive: closed in production, local elsewhere
    if (policy) return policy as typeof valid[number];
    return nodeEnv === 'production' ? 'closed' : 'local';
  })(),

  /** Only accept registered persisted GraphQL operations (GRAPHQL_PERSISTED_ONLY=true). */
  graphqlPersistedOnly: process.env.GRAPHQL_PERSISTED_ONLY === 'true',

  /** Shut down on an unhandled promise rejection (EXIT_ON_UNHANDLED_REJECTION=true). */
  exitOnUnhandledRejection: process.env.EXIT_ON_UNHANDLED_REJECTION === 'true',

  /**
   * Web authentication domain for SEP-10 web_auth_domain operation.
   * When set, the SEP-10 challenge will include a server-sourced manageData
   * operation with name 'web_auth_domain' and value set to this domain.
   * This is optional per SEP-10 and is used for web-based authentication flows.
   * See docs/auth.md for details.
   */
  webAuthDomain: process.env.WEB_AUTH_DOMAIN ?? '',

  /**
   * Per-dependency readiness criticality configuration (#1317).
   * Only failures in critical dependencies cause the /ready endpoint to return 503.
   * Non-critical failures show as degraded in the response body and metrics
   * while keeping HTTP 200.
   *
   * READINESS_CRITICAL — Comma-separated list of critical dependencies.
   * Valid dependency names: db, ipfs, stellar, indexer
   * Default: 'db,stellar' (core dependencies that make reads fail)
   *
   * When a dependency fails:
   * - Critical: /ready returns 503 (pod removed from Service)
   * - Non-critical: /ready returns 200 with degraded status (pod stays in Service)
   *
   * Example:
   *   READINESS_CRITICAL=db,stellar         # Only db and stellar are critical
   *   READINESS_CRITICAL=db,stellar,indexer # Include indexer as critical
   *   READINESS_CRITICAL=db                 # Only db is critical
   */
  readinessCriticalDependencies: (() => {
    const raw = process.env.READINESS_CRITICAL ?? 'db,stellar';
    const deps = raw.split(',').map((d) => d.trim().toLowerCase()).filter((d) => d);
    const valid = new Set(['db', 'ipfs', 'stellar', 'indexer']);
    
    for (const dep of deps) {
      if (!valid.has(dep)) {
        throw new Error(
          `Invalid READINESS_CRITICAL value: "${dep}" is not a valid dependency. ` +
          `Valid dependencies are: ${Array.from(valid).join(', ')}.`,
        );
      }
    }
    
    return new Set(deps);
  })(),

};

// ── Post-config validation ────────────────────────────────────────────────────

// Validate shutdown configuration: prestopDelayMs must be less than timeoutMs
if (config.shutdown.prestopDelayMs >= config.shutdown.timeoutMs) {
  throw new Error(
    `Invalid shutdown config: SHUTDOWN_PRESTOP_DELAY_MS (${config.shutdown.prestopDelayMs}) ` +
    `must be less than SHUTDOWN_TIMEOUT_MS (${config.shutdown.timeoutMs}). ` +
    `The pre-stop delay must leave time for the actual shutdown sequence.`,
  );
}

export default config;

// Validate the HTTP server timeout relationship (#1593): Node requires
// headersTimeout > keepAliveTimeout, otherwise keep-alive sockets can be
// closed while headers are still in flight.
if (config.http.headersTimeoutMs <= config.http.keepAliveTimeoutMs) {
  throw new Error(
    `HTTP_HEADERS_TIMEOUT_MS (${config.http.headersTimeoutMs}) must be greater than ` +
    `HTTP_KEEP_ALIVE_TIMEOUT_MS (${config.http.keepAliveTimeoutMs})`,
  );
}

export function isProduction(): boolean { return config.nodeEnv === 'production'; }
export function isStaging(): boolean { return config.nodeEnv === 'staging'; }
export function isDevelopment(): boolean { return config.nodeEnv === 'development'; }

/** Route prefix constants for API versioning */
export const API_PREFIX = process.env.API_PREFIX ?? '/api';
export const API_V1_PREFIX = process.env.API_V1_PREFIX ?? '/api/v1';
export const API_V2_PREFIX = process.env.API_V2_PREFIX ?? '/api/v2';
