import { initTracing, shutdownTracing } from "./tracing";
initTracing();

import app from "./app";
import config from "./config";
import { logger } from "./utils/logger";
import { initDb, closeDb } from "./db";
import { stellarHealth } from "./services/stellar";
import { checkHealth, retryPendingPins, reconcilePendingPins } from "./services/ipfs";
import { indexEvents } from "./services/indexer";
import { fetchLastIndexedLedger, persistLastIndexedLedger } from "./db";
import { initBlocklist } from "./services/tokenBlocklist";
import { startDecayTimer } from "./services/ipReputation";
import {
  initCacheInvalidationSubscriber,
  closeCacheInvalidationSubscriber,
} from "./services/cache";
import { closeRedisClients } from "./services/redis";
import { runTierDivergenceCheck } from "./services/tierDivergenceJob";
import { getTierDivergenceTotal } from "./services/tierDivergenceJob";
import { setTierDivergenceGetter } from "./middleware/metrics";

// Database initialization is now async - must be awaited
async function start() {
  // Register the tier-divergence counter getter so the metrics endpoint can
  // expose scout_off_tier_divergence_total without a circular import (#1132).
  setTierDivergenceGetter(getTierDivergenceTotal);

  try {
    await initDb();
  } catch (err) {
    logger.error("Failed to initialize database:", err);
    process.exit(1);
  }

  // Initialise the token revocation blocklist (prune expired rows, schedule
  // background pruning, and kick off a non-blocking Redis warm-up sync).
  initBlocklist();

  // Start the IP-reputation decay timer (not started as an import side effect).
  startDecayTimer();

  // Listen for cross-instance player-list cache invalidations on the Redis
  // pub/sub channel `invalidate:players` (no-op when REDIS_URL is unset).
  await initCacheInvalidationSubscriber();

  // If INDEXER_BACKFILL_FROM_LEDGER is set and is less than the stored last_ledger,
  // reset last_ledger so the next poll replays from that point.
  if (config.backfillFromLedger !== null) {
    const stored = fetchLastIndexedLedger();
    if (config.backfillFromLedger < stored) {
      persistLastIndexedLedger(config.backfillFromLedger);
      logger.info(
        `Backfill: reset last_ledger from ${stored} to ${config.backfillFromLedger}`,
      );
    }
  }

  await startServer();
}

async function startServer() {
  // Validate Pinata credentials at startup
  try {
    await checkHealth();
    logger.info("Pinata credential validation successful");
  } catch (err) {
    logger.error("Pinata credential validation failed at startup:", err);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    logger.info(
      `ScoutOff backend running on port ${config.port} [${config.network}]`,
    );

    // Log startup health of critical dependencies
    (async () => {
      const statuses: Record<string, string> = { ipfs: "ok" };

      if (config.stellarHealthCheckEnabled) {
        try {
          const sOk = await stellarHealth();
          statuses.stellar = sOk ? "ok" : "unavailable";
        } catch {
          statuses.stellar = "unavailable";
        }
      } else {
        statuses.stellar = "disabled";
      }

      logger.info(`Startup health: ${JSON.stringify(statuses)}`);
    })();
  });

  // Poll for new contract events every 5 seconds
  const poll = async () => {
    try {
      await indexEvents();
    } catch (err) {
      logger.error("Indexer error:", (err as Error).message);
    }
  };

  poll();
  const pollInterval = setInterval(poll, 5_000);

  // Poll for IPFS retries every 30 seconds
  const retryPins = async () => {
    try {
      await retryPendingPins();
    } catch (err) {
      logger.error("IPFS retry worker error:", (err as Error).message);
    }
  };

  const retryInterval = setInterval(retryPins, 30_000);

  // Scheduled reconciliation of pending pins against Pinata & IPFS gateways
  const reconcilePins = async () => {
    try {
      await reconcilePendingPins();
    } catch (err) {
      logger.error("IPFS reconcile worker error:", (err as Error).message);
    }
  };

  reconcilePins();
  const reconcileInterval = setInterval(reconcilePins, config.ipfsReconcileIntervalMs);

  // Scheduled tier divergence check (#1132): compare derived (off-chain) tier
  // against stored progress_level; emits scout_off_tier_divergence_total metric
  // and structured log per mismatch. Interval configurable via TIER_DIVERGENCE_INTERVAL_MS.
  const runDivergenceCheck = async () => {
    try {
      await runTierDivergenceCheck();
    } catch (err) {
      logger.error("Tier divergence check error:", (err as Error).message);
    }
  };

  runDivergenceCheck();
  const divergenceInterval = setInterval(runDivergenceCheck, config.tierDivergence.intervalMs);

  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let isShuttingDown = false;

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
      logger.error(
        `Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    clearInterval(pollInterval);
    clearInterval(retryInterval);
    clearInterval(reconcileInterval);
    clearInterval(divergenceInterval);

    server.close(async (err) => {
      if (err) {
        logger.error("Error while closing HTTP server:", err);
      } else {
        logger.info("HTTP server closed, no longer accepting connections");
      }

      try {
        await closeDb();
        logger.info("Database connection closed");
      } catch (dbErr) {
        logger.error("Error closing database:", dbErr);
      }

      try {
        await closeCacheInvalidationSubscriber();
        await closeRedisClients();
        logger.info("Redis connections closed");
      } catch (redisErr) {
        logger.error("Error closing Redis connections:", redisErr);
      }

      try {
        await shutdownTracing();
        logger.info("Tracing SDK shut down");
      } catch (tracingErr) {
        logger.error("Error shutting down tracing:", tracingErr);
      }

      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error("Unhandled startup error:", err);
  process.exit(1);
});
