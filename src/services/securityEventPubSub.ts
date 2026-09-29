/**
 * Security Event Pub/Sub Coordinator (#1326)
 *
 * Cross-instance wallet blocklist and token revocation propagation via Redis pub/sub.
 * When a wallet is blocked or token revoked on instance A, all instances (including B)
 * invalidate caches and terminate matching SSE sessions immediately (< 1s), rather than
 * waiting for the 30s sweep interval.
 *
 * Channels:
 *   - security:wallet_blocked { wallet: "..." }
 *   - security:wallet_unblocked { wallet: "..." }
 *   - security:token_revoked { token_hash: "..." }
 *
 * Lifecycle: Initialized in start() at src/index.ts, subscribed during app boot.
 * When Redis is unavailable (REDIS_URL unset), the service is a no-op and the
 * 30s sweep in events.ts provides the fallback detection bound.
 */

import Redis from 'ioredis';
import { getRedisClient, getRedisSubscriberClient } from './redis';
import { logger } from '../utils/logger';

let subscriber: Redis | null = null;

/** Initialize security event subscriptions on the Redis pub/sub channel. */
export async function initSecurityEventSubscriber(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    logger.info('[securityEventPubSub] Redis not configured; cross-instance security events disabled');
    return;
  }

  try {
    // Get or create a dedicated subscriber connection (pub/sub requires a dedicated connection)
    subscriber = getRedisSubscriberClient();
    if (!subscriber) {
      logger.warn('[securityEventPubSub] Failed to get subscriber client');
      return;
    }

    // Subscribe to security event channels
    await subscriber.subscribe(
      'security:wallet_blocked',
      'security:wallet_unblocked',
      'security:token_revoked',
      (err) => {
        if (err) {
          logger.error('[securityEventPubSub] subscription error:', err);
        }
      }
    );

    // Handle incoming messages
    subscriber.on('message', async (channel: string, message: string) => {
      try {
        const payload = JSON.parse(message);
        await handleSecurityEvent(channel, payload);
      } catch (err) {
        logger.warn(`[securityEventPubSub] failed to parse message on ${channel}:`, err);
      }
    });

    subscriber.on('error', (err) => {
      logger.error('[securityEventPubSub] subscriber error:', err);
    });

    logger.info('[securityEventPubSub] Security event subscriptions initialized');
  } catch (err) {
    logger.error('[securityEventPubSub] failed to initialize subscriptions:', err);
    subscriber = null;
  }
}

/** Close the subscriber connection. */
export async function closeSecurityEventSubscriber(): Promise<void> {
  if (subscriber) {
    try {
      await subscriber.unsubscribe();
      await subscriber.quit();
      subscriber = null;
      logger.info('[securityEventPubSub] subscriber closed');
    } catch (err) {
      logger.warn('[securityEventPubSub] error closing subscriber:', err);
    }
  }
}

/** Handle incoming security events and trigger local actions. */
async function handleSecurityEvent(channel: string, payload: Record<string, unknown>): Promise<void> {
  try {
    switch (channel) {
      case 'security:wallet_blocked': {
        // Lazily require to avoid circular dependencies
        const { onWalletBlockedRemote } = await import('./walletBlocklist');
        const wallet = payload.wallet as string;
        if (wallet) {
          onWalletBlockedRemote(wallet);
          logger.debug(`[securityEventPubSub] processed wallet_blocked for ${wallet}`);
        }
        break;
      }

      case 'security:wallet_unblocked': {
        const { onWalletUnblockedRemote } = await import('./walletBlocklist');
        const wallet = payload.wallet as string;
        if (wallet) {
          onWalletUnblockedRemote(wallet);
          logger.debug(`[securityEventPubSub] processed wallet_unblocked for ${wallet}`);
        }
        break;
      }

      case 'security:token_revoked': {
        const { onTokenRevokedRemote } = await import('./tokenBlocklist');
        const tokenHash = payload.token_hash as string;
        if (tokenHash) {
          onTokenRevokedRemote(tokenHash);
          logger.debug(`[securityEventPubSub] processed token_revoked`);
        }
        break;
      }

      default:
        logger.warn(`[securityEventPubSub] unknown channel: ${channel}`);
    }
  } catch (err) {
    logger.error(`[securityEventPubSub] error handling ${channel}:`, err);
  }
}
