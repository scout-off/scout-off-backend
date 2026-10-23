import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  broadcaster,
  SseSubscriber,
  SseFilterCriteria,
  BroadcastEvent,
} from '../services/eventBroadcaster';
import { ContractEventType } from '../types';
import { getPlayerByWallet } from '../db';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import {
  isWalletBlocklisted,
  refreshBlockedWallets,
  onWalletBlocked,
  onWalletBlockedRemote,
} from '../services/walletBlocklist';
import * as tokenBlocklistModule from '../services/tokenBlocklist';
import config from '../config';
import { EventEmitter } from 'events';
import { publishSecurityEvent, getRedisClient } from '../services/redis';

const router = Router();

/** Seconds a client should wait before retrying when the SSE connection limit is hit. */
const SSE_CAPACITY_RETRY_AFTER_SECONDS = 30;

// ─── Configuration ────────────────────────────────────────────────────────────

// All SSE settings come from config.sse (validated at startup). They are read
// through these getters at use time so tests can override config.sse per case.

/** Interval between keep-alive comment pings, in milliseconds. */
function getKeepaliveIntervalMs(): number {
  return config.sse.keepaliveIntervalMs;
}

/**
 * Interval for the shared authorization sweep, in milliseconds.
 *
 * The sweep re-checks the token-revocation blocklist and wallet blocklist in
 * a SINGLE query per process (never one per connection or per keep-alive
 * tick) so revocations/blocklists that were persisted by another backend
 * instance are detected within this bound. In-process revocations are
 * delivered synchronously via event listeners and take effect immediately.
 *
 * Documented detection bound (see docs/auth.md):
 *   - same-process revocation/blocklist: immediate (synchronous event)
 *   - cross-process: ≤ SSE_AUTH_SWEEP_INTERVAL_MS (default 30 000 ms)
 */
function getAuthSweepIntervalMs(): number {
  return config.sse.authSweepIntervalMs;
}

/** Maximum number of concurrent SSE connections (0 = unlimited). */
function getMaxSseConnections(): number {
  return config.sse.maxConnections;
}

/**
 * Compute the SSE reconnect retry interval in milliseconds.
 * Applies a small random jitter (up to 20% of base) per connection to prevent
 * synchronized reconnect storms across clients.
 */
export function getSseRetryMs(baseMs: number = config.sse.retryMs): number {
  const maxJitter = Math.max(1, Math.floor(baseMs * 0.2));
  const jitter = Math.floor(Math.random() * maxJitter);
  return baseMs + jitter;
}

/** Maximum concurrent streams per authenticated wallet (0 = unlimited). */
function getMaxSseConnectionsPerWallet(): number {
  return config.sse.maxConnectionsPerWallet;
}

/** Maximum SSE session lifetime in milliseconds (default 24 hours). */
const MAX_SESSION_MS = parseNumericEnv('SSE_MAX_SESSION_MS', process.env.SSE_MAX_SESSION_MS, 24 * 60 * 60 * 1000, { min: 1, integer: true });

/** Parse a numeric environment variable with defaults and validation. */
function parseNumericEnv(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  options: { min?: number; integer?: boolean } = {},
): number {
  if (raw === undefined) return defaultValue;

  const value = options.integer !== false ? parseInt(raw, 10) : parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be a valid number`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be at least ${options.min}`);
  }
  return value;
}

/** Reject a stream when either the process-wide or per-wallet cap is reached. */
function rejectAtConnectionLimit(wallet: string, res: Response): boolean {
  const maxSseConnections = getMaxSseConnections();
  if (maxSseConnections > 0 && broadcaster.subscriberCount >= maxSseConnections) {
    res.setHeader('Retry-After', String(SSE_CAPACITY_RETRY_AFTER_SECONDS));
    res.status(503).json({
      success: false,
      error: 'SSE connection limit reached. Please try again later.',
      code: ErrorCode.SSE_CAPACITY,
    });
    return true;
  }

  const maxPerWallet = getMaxSseConnectionsPerWallet();
  if (maxPerWallet > 0 && broadcaster.getSubscriberCountForWallet(wallet) >= maxPerWallet) {
    res.status(429).json({
      success: false,
      error: 'SSE connection limit for this account reached. Please try again later.',
    });
    return true;
  }

  return false;
}

// ─── Valid event type set (for query param validation) ────────────────────────

const VALID_EVENT_TYPES = new Set<ContractEventType>([
  'player_registered',
  'milestone_submitted',
  'milestone_approved',
  'scout_subscribed',
  'contact_unlocked',
  'trial_offer_logged',
  'fees_withdrawn',
]);

/**
 * Parse and validate the `eventType` query parameter.
 *
 * Accepts a single type or a comma-separated list (e.g.
 * `?eventType=milestone_approved,scout_subscribed`). Values are split on
 * `,`, trimmed, and deduped. Returns the set of requested types, or an
 * error listing the valid types when any value is unknown.
 */
function parseEventTypes(raw: string | undefined):
  | { ok: true; types: Set<ContractEventType> }
  | { ok: false; invalid: string[] } {
  const types = new Set<ContractEventType>();
  if (raw === undefined) return { ok: true, types };

  const invalid: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value === '') continue;
    if (VALID_EVENT_TYPES.has(value as ContractEventType)) {
      types.add(value as ContractEventType);
    } else if (!invalid.includes(value)) {
      invalid.push(value);
    }
  }

  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, types };
}

// ─── SSE frame helpers ───────────────────────────────────────────────────────

/**
 * Serialise a BroadcastEvent to an SSE frame.
 *
 * SSE format:
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 */
function formatSseFrame(event: BroadcastEvent): string {
  const data = JSON.stringify({ type: event.type, payload: event.payload });
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

/** SSE keep-alive comment frame — ignored by the EventSource API but prevents
 *  proxy/load-balancer timeouts on idle connections. */
const KEEPALIVE_FRAME = ': ping\n\n';

// ─── Bounded authorization sweep (one interval per process) ──────────────────

/**
 * Active, connected sessions. Each entry carries the auth state needed to
 * terminate the stream (jti, wallet, apiKeyId) plus the subscriber itself.
 * The entry is added by the route handler and removed in cleanup().
 */
interface ActiveSession {
  wallet: string;
  jti: string | undefined;
  apiKeyId: number | undefined;
  apiKeyExpiresAt: number | undefined;
  subscriber: SseSubscriber;
  /** Unix timestamp when the session started (for max session lifetime). */
  startTime?: number;
  /** Terminate the connection; safe to call more than once. */
  terminate: (reason: 'token_revoked' | 'wallet_blocklisted' | 'token_expired' | 'server_shutdown' | 'api_key_revoked' | 'api_key_expired' | 'max_session_exceeded') => void;
}

/** Sessions currently open in this process. */
const activeSessions = new Set<ActiveSession>();

/** In-process emitter for API key revocation events. */
const apiKeyRevocationEmitter = new EventEmitter();

/** Sweep body shared by the interval and tests. */
export async function runAuthorizationSweep(): Promise<void> {
  if (activeSessions.size === 0) return;

  // Single query regardless of connection count — never per keep-alive tick.
  let revokedJtis: ReadonlySet<string>;
  try {
    revokedJtis = new Set(await tokenBlocklistModule.getActiveRevokedJtis());
  } catch {
    revokedJtis = new Set();
  }

  let blockedWallets: ReadonlySet<string>;
  try {
    blockedWallets = new Set(await refreshBlockedWallets());
  } catch {
    blockedWallets = new Set();
  }

  // Check active API keys
  const now = Math.floor(Date.now() / 1000);
  const activeApiKeyIds = await getActiveApiKeyIdsForSweep();

  for (const session of activeSessions) {
    // Token-based auth checks
    if (session.jti && revokedJtis.has(session.jti)) {
      session.terminate('token_revoked');
      continue;
    }
    if (blockedWallets.has(session.wallet)) {
      session.terminate('wallet_blocklisted');
      continue;
    }

    // API key-based auth checks
    if (session.apiKeyId) {
      // Check if key has been revoked
      if (!activeApiKeyIds.has(session.apiKeyId)) {
        session.terminate('api_key_revoked');
        continue;
      }

      // Check if key has expired
      if (session.apiKeyExpiresAt && session.apiKeyExpiresAt <= now) {
        session.terminate('api_key_expired');
        continue;
      }
    }

    // Check max session lifetime
    if (session.startTime && session.startTime + MAX_SESSION_MS <= now) {
      session.terminate('max_session_exceeded');
      continue;
    }
  }
}

// Cache for active API key IDs (refreshed each sweep)
let activeApiKeyIdsCache: Set<number> | null = null;
let activeApiKeyIdsCacheTime = 0;
const ACTIVE_API_KEY_ID_CACHE_TTL_MS = 5000; // 5 seconds

async function getActiveApiKeyIdsForSweep(): Promise<Set<number>> {
  const now = Date.now();
  if (activeApiKeyIdsCache && now - activeApiKeyIdsCacheTime < ACTIVE_API_KEY_ID_CACHE_TTL_MS) {
    return activeApiKeyIdsCache;
  }

  try {
    const { getActiveApiKeyIds } = await import('../db');
    activeApiKeyIdsCache = new Set(await getActiveApiKeyIds());
    activeApiKeyIdsCacheTime = now;
    return activeApiKeyIdsCache;
  } catch {
    activeApiKeyIdsCache = null;
    return new Set();
  }
}

// Started lazily on first connection; unref()ed so it never keeps the process
// alive; skips all work when no SSE sessions are open.
let authSweepTimer: NodeJS.Timeout | null = null;

/**
 * Drain all active SSE sessions for a graceful shutdown.
 * Sends a `session_ended` frame with `reason: server_shutdown` to every
 * connected client, ends each response, and clears the activeSessions set.
 * Safe to call multiple times (no-op when already empty).
 */
export function drainAllSessions(): void {
  if (activeSessions.size === 0) return;
  logger.info(`[sse] draining ${activeSessions.size} session(s) for shutdown`);
  for (const session of [...activeSessions]) {
    try {
      session.terminate('server_shutdown' as Parameters<typeof session.terminate>[0]);
    } catch (err) {
      logger.warn(`[sse] error terminating session wallet=${session.wallet}:`, err);
    }
  }
  activeSessions.clear();
}

/**
 * Return `true` when the server is accepting new SSE connections.
 * Set to `false` during graceful shutdown so new connections are rejected
 * with 503 before server.close() drains keep-alive idle connections.
 */
let _acceptingSseSessions = true;
export function setAcceptingSseSessions(v: boolean): void { _acceptingSseSessions = v; }
export function isAcceptingSseSessions(): boolean { return _acceptingSseSessions; }

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * GET /api/events/stream
 *
 * Server-Sent Events endpoint. Opens a long-lived HTTP connection and pushes
 * relevant contract events to the authenticated client as they are indexed.
 *
 * Authentication: Bearer JWT (same as all other protected routes).
 *
 * Query parameters (all optional, combinable):
 *   - eventType  One or more event type names to subscribe to, comma-separated
 *                (e.g. "milestone_approved" or
 *                "milestone_approved,scout_subscribed"). When omitted the
 *                client receives all event types that pass the
 *                wallet-relevance filter. Unknown values are rejected with 400.
 *   - playerId   Only deliver events whose payload contains this player identifier.
 *                When omitted no additional player-level filtering is applied.
 *
 * Filtering: only events relevant to the authenticated wallet are sent (wallet
 * isolation is always enforced regardless of query params). Player events are
 * matched through the authenticated wallet's player record, since their payload
 * carries a player ID rather than a wallet address. Optional query params add
 * further narrowing on top.
 *
 * SSE event types sent:
 *   - milestone_approved  (player: their own milestone approvals)
 *   - scout_subscribed    (scout: their own subscription changes)
 *   - contact_unlocked    (scout: their own contact unlocks)
 *   - trial_offer_logged  (scout/player: trial offers involving them)
 *   - player_registered   (player: their own registration)
 *   - milestone_submitted (player/validator)
 *   - fees_withdrawn      (admin)
 *
 * Live authorization enforcement (#1019):
 *   - If the authenticated JWT is revoked (via POST /auth/logout or admin
 *     token revocation) while the stream is open, the connection emits a
 *     terminal `session_ended` event (reason "token_revoked") and closes;
 *     no further protected events are delivered.
 *   - If the wallet is blocklisted while the stream is open, the same
 *     termination happens with reason "wallet_blocklisted".
 *   - When the access JWT expires, the stream closes with reason "token_expired".
 *   - Detection bound: immediate for revocations/blocklists processed in
 *     this process; ≤ SSE_AUTH_SWEEP_INTERVAL_MS (default 30 s) for changes
 *     persisted by another instance (one sweep query per process, never a
 *     DB query per keep-alive tick).
 *   - Blocklisted wallets cannot open a new connection (403).
 *   - Concurrent streams are limited per wallet by
 *     SSE_MAX_CONNECTIONS_PER_WALLET (default 5; 0 = unlimited).
 *
 * Reconnection: initial `retry:` hint is sent on connect (configured via
 * SSE_RETRY_MS, default 5000 ms + up to 20% random jitter) to prevent reconnect storms.
 *
 * Keep-alive: a `: ping` comment is sent every SSE_KEEPALIVE_INTERVAL_MS ms
 * (default 15 s) to prevent idle-connection timeouts.
 *
 * @auth Bearer token required (any role)
 * @response 200 text/event-stream — long-lived SSE connection
 * @response 400 { success: false, error: string, code: string, validEventTypes: string[] } — unknown eventType
 * @response 401 { success: false, error: string } — missing or invalid token
 * @response 403 { success: false, error: string, code: 'WALLET_BLOCKLISTED' } — wallet is blocklisted
 * @response 429 { success: false, error: string } — per-wallet connection limit reached
 * @response 503 { success: false, error: string, code: 'SSE_CAPACITY' } — global connection limit reached (sets Retry-After)
 */
router.get('/stream', requireAuth, async (req: Request, res: Response) => {
  const wallet = req.account!;

  // ── Draining guard: reject new SSE connections during shutdown ────────────
  if (!isAcceptingSseSessions()) {
    res.status(503).json({
      success: false,
      error: 'Server is shutting down; no new SSE connections are accepted',
    });
    return;
  }

  // ── Blocklist gate: blocklisted wallets may not open a stream ────────────
  if (await isWalletBlocklisted(wallet)) {
    logger.warn(`[sse] connection rejected, wallet blocklisted=${wallet}`);
    res.status(403).json({
      success: false,
      error: 'Account is blocklisted; SSE access revoked',
      code: ErrorCode.WALLET_BLOCKLISTED,
    });
    return;
  }

  // ── Connection limit guard ─────────────────────────────────────────────────
  if (rejectAtConnectionLimit(wallet, res)) return;

  // Resolve the player's cuid2 once per connection; contract events carry the
  // player ID, while authentication identifies the owner by wallet.
  const player = await getPlayerByWallet(wallet);

  // Re-check after the async lookup to prevent simultaneous requests from
  // passing the cap before either one has registered as a subscriber.
  if (rejectAtConnectionLimit(wallet, res)) return;

  // ── Parse optional filter query params ────────────────────────────────────
  const rawEventType = req.query.eventType as string | undefined;
  const rawPlayerId = req.query.playerId as string | undefined;

  const parsedEventTypes = parseEventTypes(rawEventType);
  if (!parsedEventTypes.ok) {
    res.status(400).json({
      success: false,
      error: `Unknown eventType value(s): ${parsedEventTypes.invalid.join(', ')}`,
      code: 'VALIDATION_ERROR',
      validEventTypes: Array.from(VALID_EVENT_TYPES),
    });
    return;
  }
  const eventTypes = parsedEventTypes.types;

  const filter: SseFilterCriteria | undefined =
    eventTypes.size > 0 || rawPlayerId !== undefined
      ? {
          eventTypes,
          playerId: rawPlayerId,
        }
      : undefined;

  // ── SSE response headers ───────────────────────────────────────────────────
  // Disable the request-level timeout middleware for this long-lived connection.
  req.socket.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
  res.flushHeaders();

  // Send an initial retry hint (with random jitter) and connected event.
  const retryMs = getSseRetryMs();
  res.write(`retry: ${retryMs}\n\nevent: connected\ndata: ${JSON.stringify({ wallet })}\n\n`);

  // ── Session lifecycle (termination + cleanup) ──────────────────────────────
  let terminated = false;
  const cleanupFns: Array<() => void> = [];
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let tokenExpiryTimer: NodeJS.Timeout | null = null;
  let maxSessionTimer: NodeJS.Timeout | null = null;

  const subscriber: SseSubscriber = {
    wallet,
    playerId: player?.player_id,
    filter,
    send(event: BroadcastEvent): void {
      // write() returns false when the kernel buffer is full; we ignore the
      // back-pressure signal here because SSE is fire-and-forget.
      try {
        res.write(formatSseFrame(event));
      } catch {
        // Stream already closed — nothing else to do.
      }
    },
  };

  const cleanup = (): void => {
    if (terminated) return;
    terminated = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (tokenExpiryTimer) clearTimeout(tokenExpiryTimer);
    if (maxSessionTimer) clearTimeout(maxSessionTimer);
    broadcaster.unsubscribe(subscriber);
    activeSessions.delete(session);
    for (const fn of cleanupFns) {
      try { fn(); } catch { /* listener cleanup is best-effort */ }
    }
    cleanupFns.length = 0;
    logger.info(`[sse] client disconnected wallet=${wallet} total=${broadcaster.subscriberCount}`);
  };

  const terminate = (reason: 'token_revoked' | 'wallet_blocklisted' | 'token_expired' | 'server_shutdown' | 'api_key_revoked' | 'api_key_expired' | 'max_session_exceeded'): void => {
    if (terminated || res.writableEnded) return;
    logger.warn(`[sse] terminating session wallet=${wallet} reason=${reason}`);
    try {
      res.write(`event: session_ended\ndata: ${JSON.stringify({ reason })}\n\n`);
      res.end();
    } catch (err) {
      logger.warn(`[sse] error writing session_ended for ${wallet}:`, err);
    }
    cleanup();
  };

  const now = Math.floor(Date.now() / 1000);
  const session: ActiveSession = {
    wallet,
    jti: req.jti,
    apiKeyId: req.apiKeyId,
    apiKeyExpiresAt: req.apiKeyExpiresAt,
    subscriber,
    terminate,
    startTime: now,
  };

  activeSessions.add(session);
  broadcaster.subscribe(subscriber);
  logger.info(`[sse] client connected wallet=${wallet} total=${broadcaster.subscriberCount}`);

  // ── Live revocation/blocklist listeners (in-process, immediate) ───────────
  if (req.jti && tokenBlocklistModule.onTokenRevoked) {
    // Guarded: tests that mock the tokenBlocklist module may not provide
    // onTokenRevoked — in that case in-process revocation listeners are
    // simply unavailable and the bounded sweep still applies.
    const unsubscribeRevoked = tokenBlocklistModule.onTokenRevoked((jti: string) => {
      if (jti === session.jti) session.terminate('token_revoked');
    });
    cleanupFns.push(unsubscribeRevoked);
  }
  const unsubscribeBlocked = onWalletBlocked((blockedWallet: string) => {
    if (blockedWallet === session.wallet) session.terminate('wallet_blocklisted');
  });
  cleanupFns.push(unsubscribeBlocked);

  // ── API key revocation listener (in-process, immediate) ────────────────────
  if (session.apiKeyId) {
    const unsubscribeApiKeyRevoked = (apiKeyId: number) => {
      if (apiKeyId === session.apiKeyId) {
        session.terminate('api_key_revoked');
      }
    };
    apiKeyRevocationEmitter.on('revoked', unsubscribeApiKeyRevoked);
    cleanupFns.push(() => {
      apiKeyRevocationEmitter.removeListener('revoked', unsubscribeApiKeyRevoked);
    });
  }

  // ── Keep-alive ─────────────────────────────────────────────────────────────
  keepAliveTimer = setInterval(() => {
    // Check if the response is still writable before writing.
    if (res.writableEnded) {
      cleanup();
      return;
    }
    res.write(KEEPALIVE_FRAME);
  }, getKeepaliveIntervalMs());

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  const onClose = cleanup;
  req.on('close', onClose);
  req.on('aborted', onClose);
  cleanupFns.push(() => {
    req.removeListener('close', onClose);
    req.removeListener('aborted', onClose);
  });

  // End the stream at the JWT's own expiry rather than allowing the initial
  // authentication decision to authorize an unbounded connection.
  if (req.tokenExpiresAt !== undefined) {
    const tokenExpiresAtMs = req.tokenExpiresAt * 1000;
    const enforceExpiry = (): void => {
      const remainingMs = tokenExpiresAtMs - Date.now();
      if (remainingMs <= 0) {
        session.terminate('token_expired');
        return;
      }
      tokenExpiryTimer = setTimeout(enforceExpiry, Math.min(remainingMs, 2_147_483_647));
    };
    enforceExpiry();
  }

  // API key expiry timer (if the key has an explicit expiry)
  if (session.apiKeyExpiresAt) {
    const apiKeyExpiresAtMs = session.apiKeyExpiresAt * 1000;
    const enforceApiKeyExpiry = (): void => {
      const remainingMs = apiKeyExpiresAtMs - Date.now();
      if (remainingMs <= 0) {
        session.terminate('api_key_expired');
        return;
      }
      tokenExpiryTimer = setTimeout(enforceApiKeyExpiry, Math.min(remainingMs, 2_147_483_647));
    };
    enforceApiKeyExpiry();
  }

  // Max session lifetime cap — hard cap applied to every session regardless of auth type
  const enforceMaxSession = (): void => {
    const sessionAgeMs = (Math.floor(Date.now() / 1000) - session.startTime!) * 1000;
    if (sessionAgeMs >= MAX_SESSION_MS) {
      session.terminate('max_session_exceeded');
      return;
    }
    const remainingMs = MAX_SESSION_MS - sessionAgeMs;
    maxSessionTimer = setTimeout(enforceMaxSession, Math.min(remainingMs, 2_147_483_647));
  };
  enforceMaxSession();

  // Start the shared sweep timer once the first connection opens.
  if (!authSweepTimer) {
    authSweepTimer = setInterval(() => {
      void runAuthorizationSweep().catch((err: unknown) => {
        logger.error(
          '[sse] authorization sweep failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, getAuthSweepIntervalMs());
    authSweepTimer.unref();
  }
});

export default router;