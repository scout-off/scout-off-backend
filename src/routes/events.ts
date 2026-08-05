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

const router = Router();

// ─── Configuration ────────────────────────────────────────────────────────────

/** Interval between keep-alive comment pings, in milliseconds. */
const KEEPALIVE_INTERVAL_MS = parseInt(
  process.env.SSE_KEEPALIVE_INTERVAL_MS ?? '15000',
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
 * Keep-alive: a `: ping` comment is sent every SSE_KEEPALIVE_INTERVAL_MS ms
 * (default 15 s) to prevent idle-connection timeouts.
 *
 * @auth Bearer token required (any role)
 * @response 200 text/event-stream — long-lived SSE connection
 * @response 401 { success: false, error: string } — missing or invalid token
 * @response 503 { success: false, error: string } — connection limit reached
 */
router.get('/stream', requireAuth, (req: Request, res: Response) => {
  const wallet = req.account!;

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
  // Express's requestTimeout sets a 'timeout' on the socket; we clear it here.
  req.socket.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
  res.flushHeaders();

  // Send an initial connected event so the client knows the stream is open.
  res.write(`event: connected\ndata: ${JSON.stringify({ wallet })}\n\n`);

  // ── Subscriber ─────────────────────────────────────────────────────────────
  const subscriber: SseSubscriber = {
    wallet,
    filter,
    send(event: BroadcastEvent): void {
      // write() returns false when the kernel buffer is full; we ignore the
      // back-pressure signal here because SSE is fire-and-forget.
      res.write(formatSseFrame(event));
    },
  };

  broadcaster.subscribe(subscriber);
  logger.info(`[sse] client connected wallet=${wallet} total=${broadcaster.subscriberCount}`);

  // ── Keep-alive ─────────────────────────────────────────────────────────────
  const keepAliveTimer = setInterval(() => {
    // Check if the response is still writable before writing.
    if (res.writableEnded) {
      clearInterval(keepAliveTimer);
      return;
    }
    res.write(KEEPALIVE_FRAME);
  }, KEEPALIVE_INTERVAL_MS);

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  const cleanup = (): void => {
    clearInterval(keepAliveTimer);
    broadcaster.unsubscribe(subscriber);
    logger.info(`[sse] client disconnected wallet=${wallet} total=${broadcaster.subscriberCount}`);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

export default router;
