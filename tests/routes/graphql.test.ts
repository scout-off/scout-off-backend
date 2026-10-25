/**
 * Tests for the graphql_enabled feature flag gating of the /graphql endpoint.
 *
 * The flag is read dynamically per request via src/services/featureFlags.
 * We mock isFeatureEnabled so tests don't need a real DB.
 */

jest.mock('../../src/services/featureFlags', () => ({
  ...jest.requireActual('../../src/services/featureFlags'),
  isFeatureEnabled: jest.fn(),
  bootstrapFeatureFlags: jest.fn(),
  GRAPHQL_ENABLED: 'graphql_enabled',
}));

// Stub IPFS and indexer so app.ts imports don't throw
jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as featureFlags from '../../src/services/featureFlags';
import config from '../../src/config';
import { mountGraphQL } from '../../src/graphql';

const mockIsEnabled = featureFlags.isFeatureEnabled as jest.Mock;

describe('GET /graphql — feature flag gating', () => {
  afterEach(() => {
    mockIsEnabled.mockReset();
  });

  it('returns 404 when graphql_enabled flag is OFF', async () => {
    mockIsEnabled.mockResolvedValue(false);
    const res = await request(app).get('/graphql');
    expect(res.status).toBe(404);
  });

  it('does not expose a GraphQL schema when flag is OFF', async () => {
    mockIsEnabled.mockResolvedValue(false);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __schema { types { name } } }' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
  });

  it('forwards to GraphQL handler (returns non-404) when flag is ON', async () => {
    mockIsEnabled.mockResolvedValue(true);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    // The stub handler returns 501 when the real yoga is not installed;
    // the important assertion is that the flag guard did NOT short-circuit to 404.
    expect(res.status).not.toBe(404);
  });

  it('calls isFeatureEnabled with the GRAPHQL_ENABLED key on each request', async () => {
    mockIsEnabled.mockResolvedValue(false);
    await request(app).get('/graphql');
    expect(mockIsEnabled).toHaveBeenCalledWith('graphql_enabled');
  });
});

describe('POST /graphql — feature flag gating', () => {
  afterEach(() => {
    mockIsEnabled.mockReset();
  });

  it('returns 404 for POST when flag is OFF', async () => {
    mockIsEnabled.mockResolvedValue(false);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
  });
});

describe('GraphQL rate limiting', () => {
  it('limits requests by IP and authenticated wallet', async () => {
    const previousMax = config.rateLimit.max;
    config.rateLimit.max = 1;

    try {
      const rateLimitedApp = express();
      rateLimitedApp.set('trust proxy', true);
      rateLimitedApp.use(express.json());
      mockIsEnabled.mockResolvedValue(true);
      mountGraphQL(rateLimitedApp);

      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      const firstIpRequest = await request(rateLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', ip)
        .send({ query: '{ __typename }' });
      const secondIpRequest = await request(rateLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', ip)
        .send({ query: '{ __typename }' });

      expect(firstIpRequest.status).not.toBe(429);
      expect(secondIpRequest.status).toBe(429);

      const wallet = `G${Date.now()}WALLET`;
      const walletIp = `198.51.101.${Math.floor(Math.random() * 200) + 1}`;
      const token = jwt.sign({ sub: wallet, role: 'scout' }, config.jwtSecret, {
        expiresIn: '1h',
      });
      const walletLimitedApp = express();
      walletLimitedApp.set('trust proxy', true);
      walletLimitedApp.use(express.json());
      mountGraphQL(walletLimitedApp);

      const firstWalletRequest = await request(walletLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', walletIp)
        .set('Authorization', `Bearer ${token}`)
        .send({ query: '{ __typename }' });
      const secondWalletRequest = await request(walletLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', `198.51.102.${Math.floor(Math.random() * 200) + 1}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ query: '{ __typename }' });

      expect(firstWalletRequest.status).not.toBe(429);
      expect(secondWalletRequest.status).toBe(429);
    } finally {
      config.rateLimit.max = previousMax;
    }
  });
});

describe('featureFlags service unit tests', () => {
  const real = jest.requireActual<typeof import('../../src/services/featureFlags')>(
    '../../src/services/featureFlags',
  );

  beforeEach(() => {
    real.clearFeatureFlagCache();
  });

  it('reflects setFeatureFlag() on the very next read and does no DB read on a cache hit', async () => {
    const db = jest.requireActual<typeof import('../../src/db')>('../../src/db');
    await real.setFeatureFlag('graphql_enabled', true, 'test');
    const spy = jest.spyOn(db, 'getFeatureFlag');
    expect(await real.isFeatureEnabled('graphql_enabled')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    await real.setFeatureFlag('graphql_enabled', false, 'test');
    expect(await real.isFeatureEnabled('graphql_enabled')).toBe(false);
    spy.mockRestore();
  });
});
