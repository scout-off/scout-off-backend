import { Pool, PoolConfig } from 'pg';
import config from '../config';
import { logger } from '../utils/logger';
import { dbPoolActiveConnections, dbPoolIdleConnections, dbPoolErrorTotal } from '../middleware/metrics';

let pool: Pool | null = null;

function buildPoolConfig(): PoolConfig {
  const pc: PoolConfig = {
    connectionString: config.databaseUrl || undefined,
    min: config.dbPoolMin,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    options: '--client_encoding=UTF8',
  };

  if (config.databaseSsl) {
    pc.ssl = config.databaseSsl;
  }

  return pc;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());

    pool.on('error', (err) => {
      dbPoolErrorTotal.inc();
      logger.error('PostgreSQL pool error:', err.message);
    });
  }
  return pool;
}

export function updatePoolMetrics(): void {
  const p = pool;
  if (!p) return;
  try {
    dbPoolActiveConnections.set(p.totalCount - p.idleCount);
    dbPoolIdleConnections.set(p.idleCount);
  } catch {
    // Pool may be shut down — ignore metric update
  }
}

export async function poolHealth(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
