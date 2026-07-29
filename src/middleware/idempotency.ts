import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import config from '../config';
import type { IdempotencyCleanupDriver } from '../services/idempotencyCleanup';

export interface IdempotencyRecord {
  key: string;
  expiresAt: number;
  requestHash: string;
  method: string;
  path: string;
  statusCode: number;
  responseBody: string;
  createdAt: number;
}

interface IdempotencyRequest extends Request {
  idempotencyKey?: string;
  idempotencyReplay?: boolean;
}

const DEFAULT_TTL_SECONDS = 86_400;
const DEFAULT_PURGE_INTERVAL_MS = 60_000;

let db: InstanceType<typeof Database> | undefined;

function getDatabase(): InstanceType<typeof Database> {
  if (!db) {
    db = new Database(config.dbPath);
    initializeDatabase();
  }

  return db;
}

function initializeDatabase(): void {
  const migrationPath = path.resolve(__dirname, '../../db/003_idempotency_keys.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  getDatabase().exec(migrationSql);
  getDatabase().exec(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
    ON idempotency_keys (expires_at);
  `);
  getDatabase().exec(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
    ON idempotency_keys (created_at);
  `);
}

export function getIdempotencyDatabase(): InstanceType<typeof Database> {
  return getDatabase();
}

function getTtlSeconds(): number {
  const parsed = Number.parseInt(String(process.env.IDEMPOTENCY_TTL_SECONDS ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return config.idempotency?.ttlSeconds && config.idempotency.ttlSeconds > 0
    ? config.idempotency.ttlSeconds
    : DEFAULT_TTL_SECONDS;
}

function getPurgeIntervalMs(): number {
  const parsed = Number.parseInt(String(process.env.IDEMPOTENCY_PURGE_INTERVAL_MS ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return config.idempotency?.purgeIntervalMs && config.idempotency.purgeIntervalMs > 0
    ? config.idempotency.purgeIntervalMs
    : DEFAULT_PURGE_INTERVAL_MS;
}

function isMutatingMethod(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

function buildRequestHash(req: Request): string {
  return `${req.method}:${req.originalUrl || req.url}`;
}

export function getIdempotencyRecord(
  key: string,
  now: number = Math.floor(Date.now() / 1000)
): IdempotencyRecord | undefined {
  return getDatabase()
    .prepare(
      'SELECT key, expires_at AS expiresAt, request_hash AS requestHash, method, path, status_code AS statusCode, response_body AS responseBody, created_at AS createdAt FROM idempotency_keys WHERE key = ? AND expires_at > ?'
    )
    .get(key, now) as IdempotencyRecord | undefined;
}

export function recordIdempotencyKey(
  key: string,
  req: Request,
  expiresAt: number,
  now: number = Math.floor(Date.now() / 1000)
): void {
  getDatabase()
    .prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(key, expiresAt, buildRequestHash(req), req.method, req.originalUrl || req.url, 0, '', now);
}

export function purgeExpiredIdempotencyKeys(now: number = Math.floor(Date.now() / 1000)): number {
  return getDatabase().prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now)
    .changes;
}

export function startIdempotencyPurgeJob(
  intervalMs: number = getPurgeIntervalMs()
): NodeJS.Timeout | undefined {
  if (intervalMs <= 0) {
    return undefined;
  }

  return setInterval(() => {
    purgeExpiredIdempotencyKeys();
  }, intervalMs);
}

export function idempotencyMiddleware(
  req: IdempotencyRequest,
  _res: Response,
  next: NextFunction
): void {
  if (!isMutatingMethod(req.method)) {
    next();
    return;
  }

  const key = req.get('Idempotency-Key') || req.get('idempotency-key');
  if (!key) {
    next();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const record = getIdempotencyRecord(key, now);

  if (record) {
    req.idempotencyKey = key;
    req.idempotencyReplay = true;
    next();
    return;
  }

  const expiresAt = now + getTtlSeconds();
  recordIdempotencyKey(key, req, expiresAt, now);

  req.idempotencyKey = key;
  req.idempotencyReplay = false;
  next();
}

export const cleanupDriver: IdempotencyCleanupDriver = {
  deleteOlderThan(threshold: number): number {
    return getDatabase()
      .prepare('DELETE FROM idempotency_keys WHERE created_at < ?')
      .run(threshold).changes;
  },
};
