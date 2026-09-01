/**
 * Integration test: saved searches respect live feature-flag toggles (#494)
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { getDriver } from '../../src/db';
import {
  clearFeatureFlagCache,
  FeatureFlags,
  setFeatureFlag,
} from '../../src/services/featureFlags';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
const SCOUT_WALLET = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';

function getAdminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function getScoutToken(): string {
  return jwt.sign({ sub: SCOUT_WALLET, role: 'scout' }, SECRET, { expiresIn: '1h' });
}

describe('saved searches live feature-flag integration (#494)', () => {
  beforeEach(() => {
    clearFeatureFlagCache();
    setFeatureFlag(FeatureFlags.SAVED_SEARCHES, true, 'test');
  });

  it('blocks saved-search routes immediately after admin disables the flag', async () => {
    const enabledRes = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/saved-searches`)
      .set('Authorization', `Bearer ${getScoutToken()}`)
      .send({ name: 'Enabled test', filters: { region: 'West Africa' } });

    expect(enabledRes.status).toBe(201);

    await request(app)
      .put('/api/admin/feature-flags')
      .set('Authorization', `Bearer ${getAdminToken()}`)
      .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false })
      .expect(200);

    const blockedRes = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/saved-searches`)
      .set('Authorization', `Bearer ${getScoutToken()}`);

    expect(blockedRes.status).toBe(404);
    expect(blockedRes.body.code).toBe('FEATURE_DISABLED');

    const row = (await getDriver().get(
      'SELECT enabled FROM feature_flags WHERE name = ?',
      [FeatureFlags.SAVED_SEARCHES],
    )) as { enabled: number };
    expect(row.enabled).toBe(0);
  });
});
