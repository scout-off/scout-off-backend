import Redis from 'ioredis';
import config from '../config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;
let redisSubscriberClient: Redis | null = null;

/**
 * Get a shared singleton Redis client if REDIS_URL is configured.
 *
 * The client is configured for predictable failure behavior:
 *
 * - `connectTimeout` (2 s): initial TCP handshake must complete within 2 s.
 *   Without this the OS TCP stack may stall for 20-130 s before reporting
 *   ECONNREFUSED on some Linux kernels, causing requests to hang.
 *
 * - `commandTimeout` (2 s): any individual Redis command (GET, SET, EVAL, …)
 *   that receives no response within 2 s is forcibly rejected.  This bounds
 *   the worst-case latency added to any request when Redis is slow or
 *   unreachable after a successful handshake.
 *
 * - `maxRetriesPerRequest` (0): ioredis retries failed commands while it
 *   reconnects by default.  With the default `null` value (unlimited retries)
 *   a command issued during a mid-session disconnect can queue indefinitely.
 *   Setting this to 0 makes ioredis reject queued commands immediately when
 *   the connection is lost, so the caller receives the error without waiting
 *   for reconnection.
 *
 * - `lazyConnect` (true): defers the initial TCP connection until the first
 *   command is issued instead of attempting it when `new Redis()` is called.
 *   This prevents a slow/unavailable Redis at startup from blocking the
 *   application before any requests arrive.
 *
 * - `retryStrategy`: exponential back-off capped at 2 s, with a hard stop
 *   at 10 attempts (~22 s total delay). Without a hard stop ioredis will keep
 *   retrying forever, creating a connection storm if Redis remains unavailable
 *   for a long time.  After 10 failures the client stops retrying; callers
 *   will receive errors until a new client is created or the process restarts.
 */
export function getRedisClient(): Redis | null {
  if (!config.redisUrl) {
    return null;
  }
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl, {
      // Bound initial connection time to prevent startup hangs.
      connectTimeout: 2_000,
      // Bound individual command round-trip time.
      commandTimeout: 2_000,
      // Reject queued commands immediately on connection loss.
      maxRetriesPerRequest: 0,
      // Don't attempt TCP connection until the first command.
      lazyConnect: true,
      // Exponential back-off, capped at 2 s, hard stop after 10 attempts.
      retryStrategy(times: number): number | null {
        if (times > 10) {
          return null; // stop retrying — client enters 'end' state
        }
        return Math.min(times * 200, 2_000);
      },
    });
    // ioredis emits 'error' on connection failures; an EventEmitter 'error' with no listener
    // crashes the process, so this must be attached.
    redisClient.on('error', (err) => {
      logger.error('[redis] Redis client error:', err);
    });
  }
  return redisClient;
}

/**
 * Get a dedicated Redis connection for Pub/Sub subscriber mode.
 *
 * ioredis forbids issuing normal commands on a connection that has been put
 * into subscriber mode, so this returns a *duplicated* connection (sharing the
 * same underlying connection pool options but with its own socket) that is
 * exclusively used for `subscribe` / message handling. `null` when REDIS_URL
 * is not configured — the in-memory backend has no cross-instance channel.
 */
export function getRedisSubscriberClient(): Redis | null {
  const client = getRedisClient();
  if (!client) {
    return null;
  }
  if (!redisSubscriberClient) {
    redisSubscriberClient = client.duplicate();
    redisSubscriberClient.on('error', (err) => {
      logger.error('[redis] Redis subscriber client error:', err);
    });
  }
  return redisSubscriberClient;
}

/**
 * Close both Redis connections used by this module (the command client and the
 * pub/sub subscriber). Safe to call when Redis is not configured or already
 * closed; failures are logged and swallowed so shutdown is never blocked.
 */
export async function closeRedisClients(): Promise<void> {
  if (redisSubscriberClient) {
    const subscriber = redisSubscriberClient;
    redisSubscriberClient = null;
    try {
      await subscriber.quit();
    } catch (err) {
      logger.warn('[redis] error closing subscriber client:', err);
    }
  }
  if (redisClient) {
    const client = redisClient;
    redisClient = null;
    try {
      await client.quit();
    } catch (err) {
      logger.warn('[redis] error closing Redis client:', err);
    }
  }
}
