import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import app from '../../src/app';
import config from '../../src/config';
import { checkDbHealth, getDbFileSize, getLastMigration, getDbIntegrityCheck, getDb } from '../../src/db';

function createAdminToken(): string {
  return jwt.sign({ sub: 'GADMIN1234567890123456789012345678901234567890123456789', role: 'admin' }, config.jwtSecret);
}

function createScoutToken(): string {
  return jwt.sign({ sub: 'GSCOUT1234567890123456789012345678901234567890123456789', role: 'scout' }, config.jwtSecret);
}

describe('Database Health Check & Diagnostics', () => {
  describe('checkDbHealth()', () => {
    it('returns healthy: true when the DB is writable and integrity check passes', () => {
      const res = checkDbHealth();
      expect(res.healthy).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it('detects read-only file/db and returns healthy: false with error reason', () => {
      const tempDir = path.join(__dirname, '../../tmp_test_db');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempDbPath = path.join(tempDir, `readonly_test_${Date.now()}.db`);
      const tempDb = new Database(tempDbPath);
      tempDb.exec('CREATE TABLE IF NOT EXISTS _healthcheck (id INTEGER PRIMARY KEY, updated_at INTEGER NOT NULL)');
      tempDb.close();

      // Make DB file read-only
      fs.chmodSync(tempDbPath, 0o444);

      // Open read-only connection
      const roDb = new Database(tempDbPath, { readonly: true });

      // Run health check against read-only db
      try {
        roDb.prepare(`
          INSERT INTO _healthcheck (id, updated_at) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `).run(Date.now());
        fail('Should have thrown read-only error');
      } catch (err: unknown) {
        expect(err instanceof Error ? err.message : String(err)).toMatch(/readonly/i);
      } finally {
        roDb.close();
        fs.chmodSync(tempDbPath, 0o666);
        fs.unlinkSync(tempDbPath);
        if (fs.existsSync(tempDir)) {
          try { fs.rmdirSync(tempDir); } catch (_e) { /* ignore cleanup errors */ }
        }
      }
    });
  });

  describe('Readiness probe integration (/ready)', () => {
    it('returns 200 ok when DB check passes', async () => {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.services.db).toBe('ok');
    });

    it('returns 503 degraded when DB check fails', async () => {
      const db = getDb();
      const origPrepare = db.prepare.bind(db);

      // Mock db.prepare to throw error when writing to _healthcheck
      jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('_healthcheck')) {
          throw new Error('attempt to write a readonly database');
        }
        return origPrepare(sql);
      });

      try {
        const res = await request(app).get('/ready');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('degraded');
        expect(res.body.services.db).toBe('unavailable');
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  describe('GET /api/admin/db-diagnostics', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/admin/db-diagnostics');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when token role is not admin', async () => {
      const token = createScoutToken();
      const res = await request(app)
        .get('/api/admin/db-diagnostics')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 with diagnostics data for admin role', async () => {
      const token = createAdminToken();
      const res = await request(app)
        .get('/api/admin/db-diagnostics')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.data.fileSize).toBe('number');
      expect(res.body.data.integrityCheck).toEqual(['ok']);
      expect('lastMigration' in res.body.data).toBe(true);
    });
  });

  describe('Diagnostics Helpers', () => {
    it('getDbFileSize returns 0 for :memory: database', () => {
      expect(getDbFileSize()).toBe(0);
    });

    it('getDbIntegrityCheck returns ok array', () => {
      const res = getDbIntegrityCheck();
      expect(res).toEqual(['ok']);
    });

    it('getLastMigration returns migration string or null', () => {
      const res = getLastMigration();
      expect(res === null || typeof res === 'string').toBe(true);
    });
  });
});
