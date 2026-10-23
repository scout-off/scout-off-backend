import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import {
  drainAwareConnectionMiddleware,
  getInFlightRequestCount,
  resetInFlightRequestCountForTests,
  runShutdown,
  trackInFlightRequest,
} from '../src/shutdown';

interface ListeningServer {
  server: http.Server;
  port: number;
}

function listen(app: express.Express): Promise<ListeningServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected a TCP address');
      }
      resolve({ server, port: address.port });
    });
  });
}

/**
 * Opens a request and leaves it in flight. Resolves once the socket is closed
 * by the server (force-close) rather than waiting for a response.
 */
function openHangingRequest(port: number, path: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      () => {
        // The server never responds for the hanging route; if we somehow get
        // a response, consider the request done.
        resolve();
      },
    );
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.end();
  });
}

/** Fires a request and resolves with its status once it completes. */
function fireAndForgetRequest(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function buildApp(): express.Express {
  const app = express();
  app.use(trackInFlightRequest);
  return app;
}

function baseDeps(server: http.Server) {
  return {
    server,
    timeoutMs: 1_000,
    requestDrainMs: 150,
    cleanupReserveMs: 250,
    stopSchedulers: jest.fn(),
    closeRedis: jest.fn(async () => undefined),
    closeDb: jest.fn(async () => undefined),
    shutdownTracing: jest.fn(async () => undefined),
  };
}

describe('graceful shutdown (#1538)', () => {
  beforeEach(() => {
    resetInFlightRequestCountForTests();
  });

  it('force-closes a request that outlives the drain deadline, then still closes Redis, DB and tracing', async () => {
    const app = buildApp();
    app.get('/slow', () => {
      // Intentionally never responds: simulates /admin/events/export.
    });

    const { server, port } = await listen(app);
    const hanging = openHangingRequest(port, '/slow');
    // Give the request time to reach the handler and be counted.
    await new Promise((r) => setTimeout(r, 50));
    expect(getInFlightRequestCount()).toBe(1);

    const deps = baseDeps(server);
    const closeAllSpy = jest.spyOn(server, 'closeAllConnections');
    const startedAt = Date.now();

    const result = await runShutdown(deps);

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
    expect(result.forceClosedConnections).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(deps.closeRedis).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
    expect(deps.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(result.durationMs).toBeLessThanOrEqual(1_000);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(1_200);

    await hanging;
    // The server-side 'close' event that decrements the counter is delivered
    // asynchronously after the socket is destroyed.
    await new Promise((r) => setTimeout(r, 50));
    expect(getInFlightRequestCount()).toBe(0);
  });

  it('lets an in-flight request finish inside the drain window without force-closing', async () => {
    const app = buildApp();
    app.get('/almost-slow', (_req, res) => {
      setTimeout(() => res.status(200).json({ ok: true }), 120);
    });

    const { server, port } = await listen(app);
    const responsePromise = fireAndForgetRequest(port, '/almost-slow');
    await new Promise((r) => setTimeout(r, 30));

    const deps = baseDeps(server);
    deps.requestDrainMs = 600;
    const closeAllSpy = jest.spyOn(server, 'closeAllConnections');

    const result = await runShutdown(deps);

    await expect(responsePromise).resolves.toBe(200);
    expect(closeAllSpy).not.toHaveBeenCalled();
    expect(result.forceClosedConnections).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(deps.closeRedis).toHaveBeenCalledTimes(1);
  });

  it('always runs cleanup even when a background job never finishes', async () => {
    const { server } = await listen(express());
    const deps = {
      ...baseDeps(server),
      getInFlightJobs: () => 3,
    };

    const startedAt = Date.now();
    const result = await runShutdown(deps);

    expect(result.exitCode).toBe(0);
    expect(deps.closeRedis).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('returns exit code 1 when a cleanup step throws, but still runs the remaining steps', async () => {
    const { server } = await listen(express());
    const deps = baseDeps(server);
    deps.closeRedis = jest.fn(async () => {
      throw new Error('redis down');
    });

    const result = await runShutdown(deps);

    expect(result.exitCode).toBe(1);
    expect(result.cleanupFailures).toEqual(['redis']);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
    expect(deps.shutdownTracing).toHaveBeenCalledTimes(1);
  });

  it('sets Connection: close on responses only while draining', () => {
    let draining = false;
    const middleware = drainAwareConnectionMiddleware(() => draining);
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;
    const next = jest.fn() as NextFunction;

    middleware({} as Request, res, next);
    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    draining = true;
    middleware({} as Request, res, next);
    expect(setHeader).toHaveBeenCalledWith('Connection', 'close');
  });
});
