/**
 * Tests for runtime feature flags (#494 / #805)
 *
 * Verifies:
 *  - GET /api/admin/feature-flags returns all flags
 *  - PUT /api/admin/feature-flags toggles a flag immediately (no restart)
 *  - PUT /api/admin/feature-flags/:name toggles by URL param
 *  - A feature_flag_toggled audit entry is written on every toggle
 *  - Disabling a flag makes the next requireFeatureFlag-guarded request return 404
 *  - Non-admin callers get 403; unauthenticated callers get 401
 *  - Seeded flags (player_tokens_enabled, saved_search_alerts_enabled, graphql_enabled) exist
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { getDriver } from '../../src/db';
import {
  clearFeatureFlagCache,
  isFeatureEnabled,
  FeatureFlags,
} from '../../src/services/featureFlags';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function getAdminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function getScoutToken(): string {
  return jwt.sign(
    { sub: 'GSCOUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', role: 'scout' },
    SECRET,
    { expiresIn: '1h' },
  );
}

/** Seed a flag directly into the DB for test isolation. */
async function seedFlag(name: string, enabled: 0 | 1): Promise<void> {
  await getDriver().run(
    `INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
     VALUES (?, ?, ?, 'system')
     ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_by = 'system'`,
    [name, enabled, Date.now()],
  );
}

/** Read the latest audit_log row matching an action. */
async function latestAuditRow(action: string): Promise<Record<string, unknown> | undefined> {
  return getDriver().get<Record<string, unknown>>(
    `SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1`,
    [action],
  );
}

describe('Admin feature flags (#494/#805)', () => {
  beforeEach(async () => {
    clearFeatureFlagCache();
    // Ensure saved_searches exists and is enabled for tests that depend on it
    await seedFlag(FeatureFlags.SAVED_SEARCHES, 1);
    clearFeatureFlagCache();
  });

  // ─── GET /api/admin/feature-flags ──────────────────────────────────────────

  describe('GET /api/admin/feature-flags', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app).get('/api/admin/feature-flags');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const res = await request(app)
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getScoutToken()}`);
      expect(res.status).toBe(403);
    });

    it('returns all feature flags for admin', async () => {
      const res = await request(app)
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: FeatureFlags.SAVED_SEARCHES,
            enabled: true,
          }),
        ]),
      );
    });

    it('returns seeded flags: player_tokens_enabled, saved_search_alerts_enabled, graphql_enabled', async () => {
      // Ensure the seeded flags exist (migration 020 may not run in-memory — seed them directly)
      await seedFlag('player_tokens_enabled', 0);
      await seedFlag('saved_search_alerts_enabled', 0);
      await seedFlag('graphql_enabled', 1);

      const res = await request(app)
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`);

      expect(res.status).toBe(200);
      const names = (res.body.data as { name: string }[]).map((f) => f.name);
      expect(names).toContain('player_tokens_enabled');
      expect(names).toContain('saved_search_alerts_enabled');
      expect(names).toContain('graphql_enabled');
    });

    it('always reflects DB state (cache is cleared before responding)', async () => {
      // Write directly to DB bypassing the cache
      await getDriver().run(
        `UPDATE feature_flags SET enabled = 0 WHERE name = ?`,
        [FeatureFlags.SAVED_SEARCHES],
      );

      const res = await request(app)
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`);

      expect(res.status).toBe(200);
      const row = (res.body.data as { name: string; enabled: boolean }[]).find(
        (f) => f.name === FeatureFlags.SAVED_SEARCHES,
      );
      expect(row?.enabled).toBe(false);
    });
  });

  // ─── PUT /api/admin/feature-flags ──────────────────────────────────────────

  describe('PUT /api/admin/feature-flags', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getScoutToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });
      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid flag name', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: 'Invalid-Flag', enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when enabled field is missing', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES });
      expect(res.status).toBe(400);
    });

    it('updates a flag and takes effect immediately without restart', async () => {
      expect(await isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(true);

      const disableRes = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });

      expect(disableRes.status).toBe(200);
      expect(disableRes.body.data.enabled).toBe(false);
      expect(await isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(false);

      const enableRes = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: true });

      expect(enableRes.status).toBe(200);
      expect(await isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(true);
    });

    it('persists flag state to the database', async () => {
      await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });

      clearFeatureFlagCache();

      const row = (await getDriver().get(
        'SELECT enabled FROM feature_flags WHERE name = ?',
        [FeatureFlags.SAVED_SEARCHES],
      )) as { enabled: number };

      expect(row.enabled).toBe(0);
      expect(await isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(false);
    });

    it('writes a feature_flag_toggled audit entry', async () => {
      await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });

      const auditRow = await latestAuditRow('feature_flag_toggled');
      expect(auditRow).toBeDefined();

      const params = JSON.parse(auditRow!.query_params as string) as Record<string, unknown>;
      expect(params.flag_name).toBe(FeatureFlags.SAVED_SEARCHES);
      expect(params.old_value).toBe(true);
      expect(params.new_value).toBe(false);
      expect(params.admin_wallet).toBe(ADMIN_WALLET);
    });
  });

  // ─── PUT /api/admin/feature-flags/:name ────────────────────────────────────

  describe('PUT /api/admin/feature-flags/:name', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app)
        .put(`/api/admin/feature-flags/${FeatureFlags.SAVED_SEARCHES}`)
        .send({ enabled: false });
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const res = await request(app)
        .put(`/api/admin/feature-flags/${FeatureFlags.SAVED_SEARCHES}`)
        .set('Authorization', `Bearer ${getScoutToken()}`)
        .send({ enabled: false });
      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid flag name in URL param', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags/Invalid-Flag')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ enabled: false });
      expect(res.status).toBe(400);
    });

    it('returns 400 when enabled is missing from body', async () => {
      const res = await request(app)
        .put(`/api/admin/feature-flags/${FeatureFlags.SAVED_SEARCHES}`)
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 when flag does not exist in DB', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags/nonexistent_flag_xyz')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ enabled: true });
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('toggles a flag by name in URL and returns 200', async () => {
      expect(await isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(true);

      const res = await request(app)
        .put(`/api/admin/feature-flags/${FeatureFlags.SAVED_SEARCHES}`)
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe(FeatureFlags.SAVED_SEARCHES);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.updated_by).toBe(ADMIN_WALLET);

      // Takes effect immediately in process
      expect(await isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(false);
    });

    it('persists toggled state to the DB', async () => {
      await request(app)
        .put(`/api/admin/feature-flags/${FeatureFlags.SAVED_SEARCHES}`)
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ enabled: false });

      clearFeatureFlagCache();

      const row = (await getDriver().get(
        'SELECT enabled FROM feature_flags WHERE name = ?',
        [FeatureFlags.SAVED_SEARCHES],
      )) as { enabled: number };

      expect(row.enabled).toBe(0);
    });

    it('writes a feature_flag_toggled audit entry', async () => {
      await request(app)
        .put(`/api/admin/feature-flags/${FeatureFlags.SAVED_SEARCHES}`)
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ enabled: false });

      const auditRow = await latestAuditRow('feature_flag_toggled');
      expect(auditRow).toBeDefined();

      const params = JSON.parse(auditRow!.query_params as string) as Record<string, unknown>;
      expect(params.flag_name).toBe(FeatureFlags.SAVED_SEARCHES);
      expect(params.new_value).toBe(false);
      expect(params.admin_wallet).toBe(ADMIN_WALLET);
    });
  });

  // ─── requireFeatureFlag integration ────────────────────────────────────────

  describe('requireFeatureFlag — immediate effect after toggle', () => {
    it('disabling saved_searches makes the saved-search list endpoint return 404', async () => {
      const scoutWallet = 'GSCOUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const scoutToken = jwt.sign({ sub: scoutWallet, role: 'scout' }, SECRET, { expiresIn: '1h' });

      // Disable the flag via admin API
      await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });

      // The guarded endpoint should now return 404
      const res = await request(app)
        .get(`/api/scouts/${scoutWallet}/saved-searches`)
        .set('Authorization', `Bearer ${scoutToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FEATURE_DISABLED');

      // Re-enable for other tests
      await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: true });
    });
  });
});
