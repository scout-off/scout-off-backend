import { Request, Response } from 'express';
import axios from 'axios';
import config from '../config';
import { getDriver } from '../db';
import { getRedisClient } from '../services/redis';
import { server } from '../services/stellar';
import { logger } from '../utils/logger';

export interface DependencyHealth {
  endpoint: string;
  version: string | null;
  status: 'ok' | 'error' | 'disabled';
  latencyMs: number | null;
  error?: string;
}

export interface HealthDependenciesResponse {
  status: 'ok' | 'degraded';
  dependencies: {
    stellar: DependencyHealth;
    horizon: DependencyHealth;
    ipfs: DependencyHealth;
    redis: DependencyHealth;
    db: DependencyHealth;
  };
}

/**
 * Sanitize URLs to strip usernames and passwords before exposing in health endpoints.
 */
export function sanitizeEndpointUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username) {
      parsed.username = '***';
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/:\/\/[^@]+@/, '://***@');
  }
}

/**
 * Probe Database (PostgreSQL or SQLite) version and round-trip latency.
 */
export async function probeDbDependency(): Promise<DependencyHealth> {
  const isPostgres = config.dbDriver === 'postgres';
  const rawEndpoint = isPostgres
    ? config.databaseUrl || 'postgres'
    : config.dbPath || 'sqlite';
  const endpoint = sanitizeEndpointUrl(rawEndpoint);
  const start = Date.now();

  try {
    const driver = getDriver();
    let versionStr = 'unknown';
    if (isPostgres) {
      const row = await driver.get<{ version: string }>('SELECT version() as version');
      versionStr = row?.version ?? 'unknown';
    } else {
      const row = await driver.get<{ version: string }>('SELECT sqlite_version() as version');
      versionStr = row?.version ? `SQLite ${row.version}` : 'unknown';
    }
    const latencyMs = Math.max(0, Date.now() - start);
    return { endpoint, version: versionStr, status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - start);
    return {
      endpoint,
      version: null,
      status: 'error',
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe Redis server version and round-trip latency via INFO server.
 */
export async function probeRedisDependency(): Promise<DependencyHealth> {
  if (!config.redisUrl) {
    return {
      endpoint: 'none',
      version: null,
      status: 'disabled',
      latencyMs: null,
    };
  }

  const endpoint = sanitizeEndpointUrl(config.redisUrl);
  const redis = getRedisClient();
  if (!redis) {
    return {
      endpoint,
      version: null,
      status: 'disabled',
      latencyMs: null,
    };
  }

  const start = Date.now();
  try {
    const info = await redis.info('server');
    const match = info.match(/redis_version:(.+)\r?\n/);
    const versionStr = match ? match[1].trim() : 'ok';
    const latencyMs = Math.max(0, Date.now() - start);
    return { endpoint, version: versionStr, status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - start);
    return {
      endpoint,
      version: null,
      status: 'error',
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe Stellar RPC reachability, network version/handshake, and round-trip latency.
 */
export async function probeStellarRpcDependency(): Promise<DependencyHealth> {
  const endpoint = sanitizeEndpointUrl(config.sorobanRpcUrl);
  if (!config.stellarHealthCheckEnabled) {
    return {
      endpoint,
      version: null,
      status: 'disabled',
      latencyMs: null,
    };
  }

  const start = Date.now();
  try {
    let versionStr = 'healthy';
    if (typeof (server as any).getNetwork === 'function') {
      try {
        const net = await (server as any).getNetwork();
        if (net?.protocolVersion !== undefined) {
          versionStr = `healthy (protocol ${net.protocolVersion})`;
        } else if (net?.passphrase) {
          versionStr = `healthy (${net.passphrase})`;
        }
      } catch {
        await server.getLatestLedger();
      }
    } else {
      await server.getLatestLedger();
    }
    const latencyMs = Math.max(0, Date.now() - start);
    return { endpoint, version: versionStr, status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - start);
    return {
      endpoint,
      version: null,
      status: 'error',
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe Stellar Horizon reachability, version info, and round-trip latency.
 */
export async function probeHorizonDependency(): Promise<DependencyHealth> {
  const endpoint = sanitizeEndpointUrl(config.horizonUrl);
  const start = Date.now();
  try {
    const res = await axios.get(config.horizonUrl, { timeout: 5000 });
    const data = res.data ?? {};
    const versionStr = data.horizon_version ?? data.stellar_core_version ?? data.version ?? 'healthy';
    const latencyMs = Math.max(0, Date.now() - start);
    return { endpoint, version: versionStr, status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - start);
    return {
      endpoint,
      version: null,
      status: 'error',
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe IPFS Gateway reachability via HEAD request and record round-trip latency.
 */
export async function probeIpfsDependency(): Promise<DependencyHealth> {
  const endpoint = sanitizeEndpointUrl(config.pinata?.gateway || 'https://gateway.pinata.cloud');
  const start = Date.now();
  try {
    const res = await axios.head(endpoint, { timeout: 5000 });
    const serverHeader = res.headers ? res.headers['server'] : undefined;
    const versionStr = serverHeader ? String(serverHeader) : `HTTP ${res.status}`;
    const latencyMs = Math.max(0, Date.now() - start);
    return { endpoint, version: versionStr, status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - start);
    if (axios.isAxiosError(err) && err.response) {
      const serverHeader = err.response.headers ? err.response.headers['server'] : undefined;
      const versionStr = serverHeader ? String(serverHeader) : `HTTP ${err.response.status}`;
      return { endpoint, version: versionStr, status: 'ok', latencyMs };
    }
    return {
      endpoint,
      version: null,
      status: 'error',
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Operator-facing endpoint reporting version and latency per downstream dependency.
 * Gated behind admin authentication.
 */
export async function getHealthDependencies(_req: Request, res: Response): Promise<void> {
  try {
    const [db, redis, stellar, horizon, ipfs] = await Promise.all([
      probeDbDependency(),
      probeRedisDependency(),
      probeStellarRpcDependency(),
      probeHorizonDependency(),
      probeIpfsDependency(),
    ]);

    const dependencies = {
      stellar,
      horizon,
      ipfs,
      redis,
      db,
    };

    const hasError = Object.values(dependencies).some((dep) => dep.status === 'error');
    const overallStatus = hasError ? 'degraded' : 'ok';

    if (res.headersSent) return;
    res.json({
      status: overallStatus,
      dependencies,
    });
  } catch (err) {
    logger.error('[health] Failed to collect dependencies health:', err);
    if (res.headersSent) return;
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve dependency health',
    });
  }
}
