import { initTracing, shutdownTracing } from "./tracing";
initTracing();

import app, { setDraining } from "./app";
import config from "./config";
import { logger } from "./utils/logger";
import { initDb, closeDb, fetchLastIndexedLedger, persistLastIndexedLedger } from "./db";
import { stellarHealth } from "./services/stellar";
import { checkHealth, retryPendingPins, reconcilePendingPins } from "./services/ipfs";
import { indexEvents } from "./services/indexer";
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
import { runTierDivergenceCheck, getTierDivergenceTotal } from "./services/tierDivergenceJob";
import { runScheduledAuditChainVerification } from "./services/auditChainVerifier";
import { setTierDivergenceGetter } from "./middleware/metrics";
import { incUnhandledRejections } from "./middleware/metrics";
import { drainAllSessions, setAcceptingSseSessions } from "./routes/events";
import { applyHttpTimeouts } from "./httpServer";
import { runShutdown } from "./shutdown";

/** Reads a non-negative integer env var, falling back when unset/invalid. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

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

  await startServer();
}

async function startServer() {
  const server = app.listen(config.port, () => {
    logger.info(
      `ScoutOff backend running on port ${config.port} [${config.network}]`,
    );
    applyHttpTimeouts(server, config.http);
    logger.info(
      `HTTP timeouts: keepAlive=${config.http.keepAliveTimeoutMs}ms ` +
      `headers=${config.http.headersTimeoutMs}ms request=${config.http.requestTimeoutMs}ms`,
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
  let isShuttingDown = false;

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

  // Poll for IPFS retries
  const retryPins = withJobTracking(async () => {
    try {
      await retryPendingPins();
    } catch (err) {
      logger.error("IPFS retry worker error:", (err as Error).message);
    }
  });

  // Run once at startup for consistency with the reconcile and divergence
  // jobs, then schedule the interval. The interval is configurable via
  // IPFS_PIN_RETRY_INTERVAL_MS (default: 30000, min: 5000).
  retryPins();
  const retryInterval = setInterval(retryPins, config.ipfsPinRetryIntervalMs);

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

  // Scheduled audit-log hash-chain verification (#1539): verifies new audit
  // rows incrementally every AUDIT_VERIFY_INTERVAL_MS and walks the whole
  // chain every AUDIT_FULL_VERIFY_INTERVAL_MS. Progress is checkpointed in
  // indexer_state, so a restart resumes instead of re-walking the table.
  const runAuditVerify = withJobTracking(async () => {
    try {
      await runScheduledAuditChainVerification({
        shouldStop: () => isShuttingDown,
      });
    } catch (err) {
      logger.error("Audit chain verification error:", (err as Error).message);
    }
  });

  runAuditVerify();
  const auditVerifyInterval = setInterval(
    runAuditVerify,
    config.auditVerify.intervalMs,
  );

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Deadline-driven drain sequence (#1315, #1538). The implementation lives in
  // src/shutdown.ts so it can be tested without booting the whole process:
  //   1. Flip draining flag  → readiness returns 503 and responses carry
  //                            `Connection: close`
  //   2. Optional pre-stop delay (SHUTDOWN_PRESTOP_DELAY_MS)
  //   3. Stop schedulers     → no new jobs start
  //   4. Await in-flight jobs (bounded by SHUTDOWN_JOB_DRAIN_MS)
  //   5. Drain SSE sessions  → send session_ended(server_shutdown)
  //   6. server.close()      → stop accepting new connections
  //   7. Await in-flight requests (bounded by SHUTDOWN_REQUEST_DRAIN_MS)
  //   8. server.closeAllConnections() for anything still connected
  //   9. Close Redis, DB, tracing within SHUTDOWN_CLEANUP_RESERVE_MS
  //  10. exit with the provided exit code, or 1 if a cleanup step failed

  const SHUTDOWN_TIMEOUT_MS = config.shutdown.timeoutMs;
  const SHUTDOWN_PRESTOP_DELAY_MS = config.shutdown.prestopDelayMs;
  const SHUTDOWN_REQUEST_DRAIN_MS = intFromEnv(
    'SHUTDOWN_REQUEST_DRAIN_MS',
    Math.floor(SHUTDOWN_TIMEOUT_MS * 0.5),
  );
  const SHUTDOWN_CLEANUP_RESERVE_MS = intFromEnv(
    'SHUTDOWN_CLEANUP_RESERVE_MS',
    2_000,
  );

  const shutdown = async (signal: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    // Last-resort watchdog. runShutdown() is deadline-driven and always runs
    // the cleanup, so this should never fire; it only protects against a hang
    // in a native dependency.
    const watchdog = setTimeout(() => {
      logger.error(
        `Graceful shutdown watchdog fired after ${SHUTDOWN_TIMEOUT_MS + 1_000}ms, forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS + 1_000);
    watchdog.unref();

    const result = await runShutdown({
      server,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      preStopDelayMs: SHUTDOWN_PRESTOP_DELAY_MS,
      requestDrainMs: SHUTDOWN_REQUEST_DRAIN_MS,
      cleanupReserveMs: SHUTDOWN_CLEANUP_RESERVE_MS,
      onDrainStart: () => {
        setDraining();
        setAcceptingSseSessions(false);
      },
      stopSchedulers: () => {
        clearInterval(pollInterval);
        clearInterval(retryInterval);
        clearInterval(reconcileInterval);
        clearInterval(divergenceInterval);
        clearInterval(auditVerifyInterval);
      },
      getInFlightJobs: () => inFlightJobs,
      drainSse: drainAllSessions,
      closeRedis: async () => {
        await closeCacheInvalidationSubscriber();
        await closeSecurityEventSubscriber();
        await closeRedisClients();
        logger.info("Redis connections closed");
      },
      closeDb: async () => {
        await closeDb();
        logger.info("Database connection closed");
      },
      shutdownTracing: async () => {
        await shutdownTracing();
        logger.info("Tracing SDK shut down");
      },
      logger,
    });

    clearTimeout(watchdog);
    if (result.cleanupFailures.length > 0) {
      logger.error(
        `Graceful shutdown finished with cleanup failure(s): ${result.cleanupFailures.join(', ')} after ${result.durationMs}ms`,
      );
    } else {
      logger.info(
        `Graceful shutdown complete in ${result.durationMs}ms`,
      );
    }
    process.exit(Math.max(exitCode, result.exitCode));
  };

  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
  process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  // Process-level safety nets (#1391). Registered once, after `shutdown` is
  // defined, so uncaught exceptions can trigger the same graceful shutdown.
  let unhandledRejectionsTotal = 0;

  process.on("unhandledRejection", (reason: unknown) => {
    unhandledRejectionsTotal += 1;
    incUnhandledRejections();
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(
      `Unhandled promise rejection (scout_off_unhandled_rejections_total=${unhandledRejectionsTotal}):`,
      err.stack ?? err.message,
    );
    // Do not exit by default; set EXIT_ON_UNHANDLED_REJECTION=true to opt in.
    if (config.exitOnUnhandledRejection) {
      shutdown("unhandledRejection", 1);
    }
  });

  process.on("uncaughtException", (err: Error) => {
    logger.error("Uncaught exception, shutting down:", err.stack ?? err.message);
    shutdown("uncaughtException", 1);
  });
}

start().catch((err) => {
  logger.error("Unhandled startup error:", err);
  process.exit(1);
});
