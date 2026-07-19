import fs from 'fs';
import os from 'os';
import path from 'path';

describe('idempotency cleanup', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idempotency-')), 'db.sqlite');
    process.env.DB_PATH = dbPath;
    jest.resetModules();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('removes expired rows while preserving unexpired ones', () => {
    const { getIdempotencyDatabase, purgeExpiredIdempotencyKeys } = require('../../src/middleware/idempotency');
    const db = getIdempotencyDatabase();

    db.prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('expired-key', 10, 'hash-1', 'POST', '/api/players', 200, '{"ok":true}', 1);

    db.prepare(
      `INSERT INTO idempotency_keys (key, expires_at, request_hash, method, path, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('active-key', 1000, 'hash-2', 'POST', '/api/players', 200, '{"ok":true}', 1);

    const deleted = purgeExpiredIdempotencyKeys(100);

    expect(deleted).toBe(1);
    expect(db.prepare('SELECT key FROM idempotency_keys ORDER BY key').all()).toEqual([
      { key: 'active-key' },
    ]);
  });
});
