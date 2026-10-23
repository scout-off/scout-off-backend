import http from 'http';
import type { NextFunction, Request, Response } from 'express';

/**
 * Testable graceful-shutdown implementation (#1538).
 *
 * The previous shutdown lived inside `startServer()` in `src/index.ts` and
 * awaited `server.close()`, which only resolves once *every* connection is
 * gone. A single slow request (`GET /admin/events/export` has a 120s timeout)
 * or a keep-alive client mid-request therefore consumed the whole
 * `SHUTDOWN_TIMEOUT_MS` budget, the force-exit timer fired, and Redis, the
 * database and the tracing SDK were never closed.
 *
 * The sequence implemented here is deadline-driven instead:
 *
 *   1. flip the draining flag (readiness → 503)                 [onDrainStart]
 *   2. optional pre-stop delay
 *   3. stop schedulers
 *   4. wait for in-flight background jobs (bounded)
 *   5. drain SSE sessions
 *   6. `server.close()` — stop accepting new connections
 *   7. wait for in-flight requests up to `requestDrainMs`
 *   8. `server.closeAllConnections()` — force-close stragglers
 *   9. close Redis, the database and tracing (reserved slice, always runs)
 *
 * Every wait is clamped to the same hard deadline, minus a fixed cleanup
 * reserve, so steps 6–8 can never starve step 9.
 */

export interface ShutdownLogger {
  info: (message: string, error?: unknown) => void;
  warn: (message: string, error?: unknown) => void;
  error: (message: string, error?: unknown) => void;
}

export interface ShutdownDeps {
  /** HTTP server returned by `app.listen()`. */
  server: http.Server;
  /** Overall shutdown budget in milliseconds. */
  timeoutMs: number;
  /** Sleep before draining so load balancers observe the 503. */
  preStopDelayMs?: number;
  /** Max time to wait for in-flight HTTP requests before force-closing. */
  requestDrainMs?: number;
  /** Max time to wait for in-flight background jobs. */
  jobDrainMs?: number;
  /** Slice of the budget reserved for Redis/DB/tracing cleanup. */
  cleanupReserveMs?: number;
  /** Flip the draining flag so readiness probes fail fast. */
  onDrainStart?: () => void;
  /** Clear every background scheduler interval/timeout. */
  stopSchedulers: () => void;
  /** Number of background jobs currently executing. */
  getInFlightJobs?: () => number;
  /** Number of HTTP requests currently in flight. */
  getInFlightRequests?: () => number;
  /** Send `session_ended` to every connected SSE client. */
  drainSse?: () => void;
  /** Close Redis clients and pub/sub subscribers. */
  closeRedis?: () => Promise<void>;
  /** Close the database driver. */
  closeDb?: () => Promise<void>;
  /** Flush and shut down the OpenTelemetry SDK. */
  shutdownTracing?: () => Promise<void>;
  logger?: ShutdownLogger;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ShutdownResult {
  /** 0 when the drain and cleanup completed, 1 only when cleanup failed. */
  exitCode: 0 | 1;
  /** Wall-clock time spent shutting down. */
  durationMs: number;
  /** Whether any connections had to be force-closed. */
  forceClosedConnections: boolean;
  /** Names of cleanup steps that threw or exceeded their budget. */
  cleanupFailures: string[];
}

const DEFAULT_CLEANUP_RESERVE_MS = 2_000;
const DEFAULT_PRE_STOP_DELAY_MS = 0;
const POLL_INTERVAL_MS = 25;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the event loop alive just to finish a drain wait.
    timer.unref?.();
  });

/** Upper bound on how long `server.close()` may take after force-closing. */
const SERVER_CLOSE_GRACE_MS = 250;

// ── In-flight request tracking ───────────────────────────────────────────────

let inFlightRequests = 0;

/** Number of HTTP requests currently being served by this process. */
export function getInFlightRequestCount(): number {
  return inFlightRequests;
}

/** Resets the counter — only for tests that do not use a real server. */
export function resetInFlightRequestCountForTests(): void {
  inFlightRequests = 0;
}

/**
 * Counts a request as in flight until the response finishes or the client
 * disconnects. Mounted early in `src/app.ts` so every route (streams, exports,
 * keep-alive requests) is covered.
 */
export function trackInFlightRequest(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  inFlightRequests += 1;
  let settled = false;
  const release = (): void => {
    if (settled) return;
    settled = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

/**
 * While draining, ask clients not to reuse the socket for another request.
 * Without this, keep-alive clients keep re-opening requests against a server
 * that is trying to stop accepting them.
 */
export function drainAwareConnectionMiddleware(
  isDraining: () => boolean,
): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, res, next) => {
    if (isDraining()) {
      res.setHeader('Connection', 'close');
    }
    next();
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

async function waitFor(
  predicate: () => boolean,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  while (!predicate() && now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/** Resolves when `promise` settles or `ms` elapses, whichever is first. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | undefined> {
  return Promise.race([
    promise,
    sleep(Math.max(0, ms)).then(() => undefined),
  ]);
}

type CleanupOutcome =
  | { status: 'ok' }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

/**
 * Runs a cleanup step, bounding it by the remaining budget. A rejected
 * promise is caught here so a late rejection can never become an unhandled
 * rejection after the race resolves.
 */
async function runCleanupStep(
  run: () => Promise<void>,
  remainingMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<CleanupOutcome> {
  const work: Promise<CleanupOutcome> = run().then(
    () => ({ status: 'ok' as const }),
    (error: unknown) => ({ status: 'error' as const, error }),
  );
  const timeout: Promise<CleanupOutcome> = sleep(
    Math.max(1, remainingMs),
  ).then(() => ({ status: 'timeout' as const }));
  return Promise.race([work, timeout]);
}

interface CleanupStep {
  name: string;
  run: () => Promise<void>;
}

// ── Main sequence ────────────────────────────────────────────────────────────

/**
 * Runs the full graceful-shutdown sequence. Never throws: cleanup failures are
 * collected in `cleanupFailures` and reflected in `exitCode`.
 */
export async function runShutdown(
  deps: ShutdownDeps,
): Promise<ShutdownResult> {
  const {
    server,
    timeoutMs,
    stopSchedulers,
    onDrainStart,
    drainSse,
    closeRedis,
    closeDb,
    shutdownTracing,
    logger,
    now = Date.now,
    sleep = defaultSleep,
  } = deps;

  const getInFlightJobs = deps.getInFlightJobs ?? (() => 0);
  const getInFlightRequests =
    deps.getInFlightRequests ?? getInFlightRequestCount;

  const start = now();
  const log: ShutdownLogger = logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  // Clamp the configurable slices so a misconfiguration can never consume the
  // whole budget before cleanup is reached.
  const budget = Math.max(0, timeoutMs);
  const cleanupReserveMs = clamp(
    deps.cleanupReserveMs ?? DEFAULT_CLEANUP_RESERVE_MS,
    0,
    Math.floor(budget / 2),
  );
  const cleanupDeadline = start + budget - cleanupReserveMs;
  const hardDeadline = start + budget;
  const preStopDelayMs = clamp(
    deps.preStopDelayMs ?? DEFAULT_PRE_STOP_DELAY_MS,
    0,
    Math.max(0, cleanupDeadline - start),
  );
  const requestDrainMs = clamp(
    deps.requestDrainMs ?? Math.floor(budget * 0.5),
    0,
    Math.max(0, cleanupDeadline - start),
  );
  const jobDrainMs = clamp(
    deps.jobDrainMs ?? Math.floor(budget * 0.3),
    0,
    Math.max(0, cleanupDeadline - start),
  );

  // Step 1: readiness fails immediately.
  onDrainStart?.();

  // Step 2: give load balancers time to observe the 503.
  if (preStopDelayMs > 0) {
    log.info(`[shutdown] pre-stop delay ${preStopDelayMs}ms`);
    await sleep(preStopDelayMs);
  }

  // Step 3: no new scheduled work.
  try {
    stopSchedulers();
  } catch (err) {
    log.error('[shutdown] failed to stop schedulers:', err);
  }

  // Step 4: wait for background jobs, bounded by their slice and the deadline.
  const inFlightJobs = getInFlightJobs();
  if (inFlightJobs > 0) {
    log.info(`[shutdown] waiting for ${inFlightJobs} in-flight job(s)...`);
    const jobDeadline = Math.min(now() + jobDrainMs, cleanupDeadline);
    await waitFor(
      () => getInFlightJobs() === 0,
      jobDeadline,
      now,
      sleep,
    );
    const remainingJobs = getInFlightJobs();
    if (remainingJobs > 0) {
      log.warn(
        `[shutdown] ${remainingJobs} job(s) still running, proceeding`,
      );
    }
  }

  // Step 5: close SSE streams so their requests leave the in-flight count.
  try {
    drainSse?.();
  } catch (err) {
    log.error('[shutdown] failed to drain SSE sessions:', err);
  }

  // Step 6: stop accepting new connections. Do not await the callback yet —
  // it resolves only once every connection has closed, which is exactly what
  // we are about to bound.
  let serverClosed = false;
  const closed = new Promise<void>((resolve) => {
    try {
      server.close((err?: Error) => {
        if (err) {
          // ERR_SERVER_NOT_RUNNING is expected when the listener already died.
          if ((err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            log.error('[shutdown] error while closing HTTP server:', err);
          }
        } else {
          log.info('[shutdown] HTTP server closed');
        }
        serverClosed = true;
        resolve();
      });
    } catch (err) {
      log.error('[shutdown] server.close() threw:', err);
      serverClosed = true;
      resolve();
    }
  });

  // Idle keep-alive sockets are not serving anything: close them right away
  // (available in Node ≥ 18.2).
  try {
    server.closeIdleConnections?.();
  } catch (err) {
    log.error('[shutdown] closeIdleConnections() failed:', err);
  }

  // Step 7: let in-flight requests finish within their slice.
  const requestDeadline = Math.min(now() + requestDrainMs, cleanupDeadline);
  await waitFor(
    () => getInFlightRequests() === 0 || serverClosed,
    requestDeadline,
    now,
    sleep,
  );

  // Step 8: force-close whatever is still connected.
  const stragglers = getInFlightRequests();
  let forceClosedConnections = false;
  if (!serverClosed) {
    if (stragglers > 0) {
      log.warn(
        `[shutdown] ${stragglers} request(s) still in flight after ${requestDrainMs}ms, force-closing connections`,
      );
    }
    try {
      server.closeAllConnections?.();
      forceClosedConnections = true;
    } catch (err) {
      log.error('[shutdown] closeAllConnections() failed:', err);
    }
    // Give the close callback a moment to fire now that sockets are gone.
    await withTimeout(
      closed,
      Math.min(SERVER_CLOSE_GRACE_MS, Math.max(0, hardDeadline - now())),
      sleep,
    );
  }

  // Step 9: cleanup always runs, with the reserved slice.
  const cleanupSteps: CleanupStep[] = [];
  if (closeRedis) cleanupSteps.push({ name: 'redis', run: closeRedis });
  if (closeDb) cleanupSteps.push({ name: 'database', run: closeDb });
  if (shutdownTracing) {
    cleanupSteps.push({ name: 'tracing', run: shutdownTracing });
  }

  const cleanupFailures: string[] = [];
  for (const step of cleanupSteps) {
    const remainingMs = hardDeadline - now();
    if (remainingMs <= 0) {
      // Out of budget: still attempt the cleanup, but do not let a hang keep
      // the process alive indefinitely.
      log.warn(
        `[shutdown] no budget left for ${step.name} cleanup, attempting anyway`,
      );
    }
    const outcome = await runCleanupStep(
      step.run,
      Math.max(1, remainingMs),
      sleep,
    );
    if (outcome.status === 'timeout') {
      cleanupFailures.push(step.name);
      log.error(
        `[shutdown] ${step.name} cleanup exceeded the remaining budget`,
      );
    } else if (outcome.status === 'error') {
      cleanupFailures.push(step.name);
      log.error(`[shutdown] error closing ${step.name}:`, outcome.error);
    } else {
      log.info(`[shutdown] ${step.name} cleanup complete`);
    }
  }

  const durationMs = now() - start;
  if (durationMs > budget) {
    log.warn(
      `[shutdown] exceeded the ${budget}ms budget (took ${durationMs}ms)`,
    );
  }

  return {
    exitCode: cleanupFailures.length > 0 ? 1 : 0,
    durationMs,
    forceClosedConnections,
    cleanupFailures,
  };
}
