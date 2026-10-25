/**
 * /graphql gate against the real feature_flags table (#1516). Runs under both
 * DB_DRIVER=sqlite and DB_DRIVER=postgres (`npm run test:postgres`).
 */
jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import app from '../../src/app';
import { setFeatureFlag, clearFeatureFlagCache, GRAPHQL_ENABLED } from '../../src/services/featureFlags';

describe('/graphql flag gate (driver-agnostic)', () => {
  beforeEach(() => clearFeatureFlagCache());
  afterAll(async () => {
    await setFeatureFlag(GRAPHQL_ENABLED, false, 'test');
    clearFeatureFlagCache();
  });

  it('serves requests once the flag is enabled and 404s again when disabled', async () => {
    await setFeatureFlag(GRAPHQL_ENABLED, true, 'test');
    const on = await request(app).post('/graphql').send({ query: '{ __typename }' });
    expect(on.status).toBe(200);

    await setFeatureFlag(GRAPHQL_ENABLED, false, 'test');
    const off = await request(app).post('/graphql').send({ query: '{ __typename }' });
    expect(off.status).toBe(404);
  });
});
