import { initTracing, shutdownTracing } from "./tracing";
initTracing();

import app, { setDraining } from "./app";
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
import {
  initSecurityEventSubscriber,
  closeSecurityEventSubscriber,
} from "./services/securityEventPubSub";
import { closeRedisClients } from "./services/redis";
import { runTierDivergenceCheck } from "./services/tierDivergenceJob";
import { getTierDivergenceTotal } from "./services/tierDivergenceJob";
import { setTierDivergenceGetter } from "./middleware/metrics";
import { drainAllSessions, setAcceptingSseSessions } from "./routes/events";
import http from "http";
import { startRetentionJob, stopRetentionJob } from './services/retention';

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

  // Listen for cross-instance security events (wallet blocks, token revocations)
  // on Redis pub/sub channels (no-op when REDIS_URL is unset).
  await initSecurityEventSubscriber();

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

  startRetentionJob();
  await startServer();
}

async function startServer() {
  const server = app.listen(config.port, () => {
    logger.info(
      `ScoutOff backend running on port ${config.port} [${config.network}]`,
    );

    // Log startup health of critical dependencies
    (async () => {
      const statuses: Record<string, string> = {};

      try {
        await checkHealth();
        statuses.ipfs = "ok";
        logger.info("Pinata credential validation successful");
      } catch (err) {
        statuses.ipfs = "unavailable";
        logger.error("Pinata credential validation failed at startup:", err);
      }

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

  // ── Job tracking ──────────────────────────────────────────────────────────
  // Wraps each background job so shutdown can observe whether one is running
  // and wait for it to complete before closing the DB.
  let inFlightJobs = 0;

  function withJobTracking(fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      inFlightJobs++;
      try {
        await fn();
      } finally {
        inFlightJobs--;
      }
    };
  }

  // Poll for new contract events every 5 seconds
  const poll = withJobTracking(async () => {
    try {
      await indexEvents();
    } catch (err) {
      logger.error("Indexer error:", (err as Error).message);
    }
  });

  poll();
  const pollInterval = setInterval(poll, 5_000);

  // Poll for IPFS retries every 30 seconds
  const retryPins = withJobTracking(async () => {
    try {
      await retryPendingPins();
    } catch (err) {
      logger.error("IPFS retry worker error:", (err as Error).message);
    }
  });

  const retryInterval = setInterval(retryPins, 30_000);

  // Scheduled reconciliation of pending pins against Pinata & IPFS gateways
  const reconcilePins = withJobTracking(async () => {
    try {
      await reconcilePendingPins();
    } catch (err) {
      logger.error("IPFS reconcile worker error:", (err as Error).message);
    }
  });

  reconcilePins();
  const reconcileInterval = setInterval(reconcilePins, config.ipfsReconcileIntervalMs);

  // Scheduled tier divergence check (#1132): compare derived (off-chain) tier
  // against stored progress_level; emits scout_off_tier_divergence_total metric
  // and structured log per mismatch. Interval configurable via TIER_DIVERGENCE_INTERVAL_MS.
  const runDivergenceCheck = withJobTracking(async () => {
    try {
      await runTierDivergenceCheck();
    } catch (err) {
      logger.error("Tier divergence check error:", (err as Error).message);
    }
  });

  runDivergenceCheck();
  const divergenceInterval = setInterval(runDivergenceCheck, config.tierDivergence.intervalMs);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Ordered drain sequence (#1315):
  //   1. Flip draining flag  → readiness returns 503 immediately
  //   2. Optional pre-stop delay (SHUTDOWN_PRESTOP_DELAY_MS)
  //   3. Stop schedulers     → no new jobs start
  //   4. Await in-flight jobs (bounded to 60 % of total timeout)
  //   5. Drain SSE sessions  → send session_ended(server_shutdown) and end each stream
  //   6. server.close()      → stop accepting new HTTP connections
  //   7. Close Redis, DB, tracing
  //   8. exit 0

  const SHUTDOWN_TIMEOUT_MS = parseInt(
    process.env.SHUTDOWN_TIMEOUT_MS ?? '10000',
    10,
  );
  const SHUTDOWN_PRESTOP_DELAY_MS = parseInt(
    process.env.SHUTDOWN_PRESTOP_DELAY_MS ?? '0',
    10,
  );
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    // Step 1: flip draining flag — readiness probes return 503 immediately.
    setDraining();
    setAcceptingSseSessions(false);

    // Step 2: optional pre-stop delay for load-balancer observation of 503.
    if (SHUTDOWN_PRESTOP_DELAY_MS > 0) {
      logger.info(`[shutdown] pre-stop delay ${SHUTDOWN_PRESTOP_DELAY_MS}ms`);
      await new Promise((r) => setTimeout(r, SHUTDOWN_PRESTOP_DELAY_MS));
    }

    const forceExitTimer = setTimeout(() => {
      logger.error(
        `Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    // Step 3: stop schedulers so no new jobs start.
    clearInterval(pollInterval);
    clearInterval(retryInterval);
    clearInterval(reconcileInterval);
    clearInterval(divergenceInterval);
    await stopRetentionJob();

    // Step 4: await in-flight job executions (bounded to 60 % of total timeout).
    if (inFlightJobs > 0) {
      logger.info(`[shutdown] waiting for ${inFlightJobs} in-flight job(s)...`);
      const jobDrainDeadline = Date.now() + Math.floor(SHUTDOWN_TIMEOUT_MS * 0.6);
      while (inFlightJobs > 0 && Date.now() < jobDrainDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (inFlightJobs > 0) {
        logger.warn(`[shutdown] ${inFlightJobs} job(s) still running, proceeding`);
      }
    }

    // Step 5: drain SSE sessions — send session_ended(server_shutdown).
    drainAllSessions();

    // Step 6: close HTTP server and destroy idle keep-alive connections.
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error("Error while closing HTTP server:", err);
        } else {
          logger.info("HTTP server closed");
        }
        resolve();
      });
      // closeIdleConnections() is available in Node ≥ 18.2.
      if (
        typeof (server as http.Server & { closeIdleConnections?: () => void })
          .closeIdleConnections === 'function'
      ) {
        (server as http.Server & { closeIdleConnections: () => void }).closeIdleConnections();
      }
    });

    // Step 7: close Redis, DB, tracing.
    try {
      await closeCacheInvalidationSubscriber();
      await closeSecurityEventSubscriber();
      await closeRedisClients();
      logger.info("Redis connections closed");
    } catch (redisErr) {
      logger.error("Error closing Redis connections:", redisErr);
    }

    try {
      await closeDb();
      logger.info("Database connection closed");
    } catch (dbErr) {
      logger.error("Error closing database:", dbErr);
    }

    try {
      await shutdownTracing();
      logger.info("Tracing SDK shut down");
    } catch (tracingErr) {
      logger.error("Error shutting down tracing:", tracingErr);
    }

    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
  process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  // Process-level safety nets (#1391). Registered once, after `shutdown` is
  // defined, so uncaught exceptions can trigger the same graceful shutdown.
  let unhandledRejectionsTotal = 0;

  process.on("unhandledRejection", (reason: unknown) => {
    unhandledRejectionsTotal += 1;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(
      `Unhandled promise rejection (scout_off_unhandled_rejections_total=${unhandledRejectionsTotal}):`,
      err.stack ?? err.message,
    );
    // Do not exit by default; set EXIT_ON_UNHANDLED_REJECTION=true to opt in.
    if (config.exitOnUnhandledRejection) {
      shutdown("unhandledRejection");
    }
  });

  process.on("uncaughtException", (err: Error) => {
    logger.error("Uncaught exception, shutting down:", err.stack ?? err.message);
    shutdown("uncaughtException");
    process.exitCode = 1;
  });
}

start().catch((err) => {
  logger.error("Unhandled startup error:", err);
  process.exit(1);
});
