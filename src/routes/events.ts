import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  broadcaster,
  SseSubscriber,
  SseFilterCriteria,
  BroadcastEvent,
} from '../services/eventBroadcaster';
import { ContractEventType } from '../types';
import { logger } from '../utils/logger';
import {
  isWalletBlocklisted,
  refreshBlockedWallets,
  onWalletBlocked,
} from '../services/walletBlocklist';
import * as tokenBlocklistModule from '../services/tokenBlocklist';

const router = Router();

// ─── Configuration ────────────────────────────────────────────────────────────

/** Interval between keep-alive comment pings, in milliseconds. */
const KEEPALIVE_INTERVAL_MS = parseInt(
  process.env.SSE_KEEPALIVE_INTERVAL_MS ?? '15000',
  10,
);

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
const AUTH_SWEEP_INTERVAL_MS = parseInt(
  process.env.SSE_AUTH_SWEEP_INTERVAL_MS ?? '30000',
  10,
);

/** Maximum number of concurrent SSE connections (0 = unlimited). Read live
 *  (not cached at module load) so tests can flip it per-case. */
function getMaxSseConnections(): number {
  return parseInt(process.env.SSE_MAX_CONNECTIONS ?? '0', 10);
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
 * terminate the stream (jti, wallet) plus the subscriber itself.
 * The entry is added by the route handler and removed in cleanup().
 */
interface ActiveSession {
  wallet: string;
  jti: string | undefined;
  subscriber: SseSubscriber;
  /** Terminate the connection; safe to call more than once. */
  terminate: (reason: 'token_revoked' | 'wallet_blocklisted') => void;
}

/** Sessions currently open in this process. */
const activeSessions = new Set<ActiveSession>();

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

  for (const session of activeSessions) {
    if (session.jti && revokedJtis.has(session.jti)) {
      session.terminate('token_revoked');
    } else if (blockedWallets.has(session.wallet)) {
      session.terminate('wallet_blocklisted');
    }
  }
}

// Started lazily on first connection; unref()ed so it never keeps the process
// alive; skips all work when no SSE sessions are open.
let authSweepTimer: NodeJS.Timeout | null = null;

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
 *   - eventType  One event type name to subscribe to (e.g. "milestone_approved").
 *                When omitted the client receives all event types that pass the
 *                wallet-relevance filter.  Unknown values are ignored.
 *   - playerId   Only deliver events whose payload contains this player identifier.
 *                When omitted no additional player-level filtering is applied.
 *
 * Filtering: only events relevant to the authenticated wallet are sent (wallet
 * isolation is always enforced regardless of query params).  The optional
 * query params add further narrowing on top.
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
 *   - Detection bound: immediate for revocations/blocklists processed in
 *     this process; ≤ SSE_AUTH_SWEEP_INTERVAL_MS (default 30 s) for changes
 *     persisted by another instance (one sweep query per process, never a
 *     DB query per keep-alive tick).
 *   - Blocklisted wallets cannot open a new connection (403).
 *
 * Keep-alive: a `: ping` comment is sent every SSE_KEEPALIVE_INTERVAL_MS ms
 * (default 15 s) to prevent idle-connection timeouts.
 *
 * @auth Bearer token required (any role)
 * @response 200 text/event-stream — long-lived SSE connection
 * @response 401 { success: false, error: string } — missing or invalid token
 * @response 403 { success: false, error: string } — wallet is blocklisted
 * @response 503 { success: false, error: string } — connection limit reached
 */
router.get('/stream', requireAuth, async (req: Request, res: Response) => {
  const wallet = req.account!;

  // ── Blocklist gate: blocklisted wallets may not open a stream ────────────
  if (await isWalletBlocklisted(wallet)) {
    logger.warn(`[sse] connection rejected, wallet blocklisted=${wallet}`);
    res.status(403).json({
      success: false,
      error: 'Account is blocklisted; SSE access revoked',
    });
    return;
  }

  // ── Connection limit guard ─────────────────────────────────────────────────
  const maxSseConnections = getMaxSseConnections();
  if (maxSseConnections > 0 && broadcaster.subscriberCount >= maxSseConnections) {
    res.status(503).json({
      success: false,
      error: 'SSE connection limit reached. Please try again later.',
    });
    return;
  }

  // ── Parse optional filter query params ────────────────────────────────────
  const rawEventType = req.query.eventType as string | undefined;
  const rawPlayerId = req.query.playerId as string | undefined;

  const eventTypes = new Set<ContractEventType>();
  if (rawEventType && VALID_EVENT_TYPES.has(rawEventType as ContractEventType)) {
    eventTypes.add(rawEventType as ContractEventType);
  }

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

  // Send an initial connected event so the client knows the stream is open.
  res.write(`event: connected\ndata: ${JSON.stringify({ wallet })}\n\n`);

  // ── Session lifecycle (termination + cleanup) ──────────────────────────────
  let terminated = false;
  const cleanupFns: Array<() => void> = [];
  let keepAliveTimer: NodeJS.Timeout | null = null;

  const subscriber: SseSubscriber = {
    wallet,
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
    broadcaster.unsubscribe(subscriber);
    activeSessions.delete(session);
    for (const fn of cleanupFns) {
      try { fn(); } catch { /* listener cleanup is best-effort */ }
    }
    cleanupFns.length = 0;
    logger.info(`[sse] client disconnected wallet=${wallet} total=${broadcaster.subscriberCount}`);
  };

  const terminate = (reason: 'token_revoked' | 'wallet_blocklisted'): void => {
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

  const session: ActiveSession = {
    wallet,
    jti: req.jti,
    subscriber,
    terminate,
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

  // ── Keep-alive ─────────────────────────────────────────────────────────────
  keepAliveTimer = setInterval(() => {
    // Check if the response is still writable before writing.
    if (res.writableEnded) {
      cleanup();
      return;
    }
    res.write(KEEPALIVE_FRAME);
  }, KEEPALIVE_INTERVAL_MS);

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  const onClose = cleanup;
  req.on('close', onClose);
  req.on('aborted', onClose);
  cleanupFns.push(() => {
    req.removeListener('close', onClose);
    req.removeListener('aborted', onClose);
  });

  // Start the shared sweep timer once the first connection opens.
  if (!authSweepTimer) {
    authSweepTimer = setInterval(runAuthorizationSweep, AUTH_SWEEP_INTERVAL_MS);
    authSweepTimer.unref();
  }
});

export default router;