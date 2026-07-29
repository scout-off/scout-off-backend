import fs from 'fs';
import os from 'os';
import path from 'path';

describe('idempotency cleanup job', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idempotency-cleanup-')), 'db.sqlite');
    process.env.DB_PATH = dbPath;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('deletes only keys where created_at is older than 24 hours', () => {
    const { getIdempotencyDatabase, cleanupDriver } = require('../../src/middleware/idempotency');
    const { deleteExpiredIdempotencyKeys } = require('../../src/services/idempotencyCleanup');
    const { idempotencyKeysDeletedTotal } = require('../../src/middleware/metrics');
    const incSpy = jest.spyOn(idempotencyKeysDeletedTotal, 'inc');

    const db = getIdempotencyDatabase();
    const now = 1_000_000_000;
    const oneDay = 24 * 60 * 60;

    db.prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('old-key', now + oneDay, 'hash-1', 'POST', '/api/test', 200, '{}', now - 2 * oneDay);

    db.prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('recent-key', now + oneDay, 'hash-2', 'POST', '/api/test', 200, '{}', now - 12 * 60 * 60);

    const deleted = deleteExpiredIdempotencyKeys(cleanupDriver, now);

    expect(deleted).toBe(1);
    expect(db.prepare('SELECT key FROM idempotency_keys ORDER BY key').all()).toEqual([
      { key: 'recent-key' },
    ]);
    expect(incSpy).toHaveBeenCalledWith(1);
  });

  it('does not delete any rows when all keys are recent', () => {
    const { getIdempotencyDatabase, cleanupDriver } = require('../../src/middleware/idempotency');
    const { deleteExpiredIdempotencyKeys } = require('../../src/services/idempotencyCleanup');
    const { idempotencyKeysDeletedTotal } = require('../../src/middleware/metrics');
    const incSpy = jest.spyOn(idempotencyKeysDeletedTotal, 'inc');

    const db = getIdempotencyDatabase();
    const now = 1_000_000_000;
    const oneDay = 24 * 60 * 60;

    db.prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('recent-a', now + oneDay, 'hash-1', 'POST', '/api/test', 200, '{}', now - 10 * 60 * 60);

    db.prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('recent-b', now + oneDay, 'hash-2', 'POST', '/api/test', 200, '{}', now - 5 * 60 * 60);

    const deleted = deleteExpiredIdempotencyKeys(cleanupDriver, now);

    expect(deleted).toBe(0);
    expect(db.prepare('SELECT key FROM idempotency_keys ORDER BY key').all()).toEqual([
      { key: 'recent-a' },
      { key: 'recent-b' },
    ]);
    expect(incSpy).not.toHaveBeenCalled();
  });

  it('skips the cleanup job in test environment', () => {
    process.env.NODE_ENV = 'test';
    jest.resetModules();

    const { startIdempotencyCleanupJob } = require('../../src/services/idempotencyCleanup');
    const { cleanupDriver } = require('../../src/middleware/idempotency');

    const result = startIdempotencyCleanupJob(cleanupDriver);
    expect(result).toBeUndefined();
  });
});
