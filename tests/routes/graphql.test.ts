/**
 * Tests for the graphql_enabled feature flag gating of the /graphql endpoint.
 *
 * The flag is read dynamically per request via src/services/featureFlags.
 * We mock isEnabled so tests don't need a real DB.
 */

jest.mock('../../src/services/featureFlags', () => ({
  ...jest.requireActual('../../src/services/featureFlags'),
  isEnabled: jest.fn(),
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
import app from '../../src/app';
import * as featureFlags from '../../src/services/featureFlags';

const mockIsEnabled = featureFlags.isEnabled as jest.Mock;

describe('GET /graphql — feature flag gating', () => {
  afterEach(() => {
    mockIsEnabled.mockReset();
  });

  it('returns 404 when graphql_enabled flag is OFF', async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await request(app).get('/graphql');
    expect(res.status).toBe(404);
  });

  it('does not expose a GraphQL schema when flag is OFF', async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __schema { types { name } } }' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
  });

  it('forwards to GraphQL handler (returns non-404) when flag is ON', async () => {
    mockIsEnabled.mockReturnValue(true);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    // The stub handler returns 501 when the real yoga is not installed;
    // the important assertion is that the flag guard did NOT short-circuit to 404.
    expect(res.status).not.toBe(404);
  });

  it('calls isEnabled with the GRAPHQL_ENABLED key on each request', async () => {
    mockIsEnabled.mockReturnValue(false);
    await request(app).get('/graphql');
    expect(mockIsEnabled).toHaveBeenCalledWith('graphql_enabled');
  });
});

describe('POST /graphql — feature flag gating', () => {
  afterEach(() => {
    mockIsEnabled.mockReset();
  });

  it('returns 404 for POST when flag is OFF', async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
  });
});

describe('featureFlags service unit tests', () => {
  const { isEnabled: realIsEnabled, clearFlagCache } =
    jest.requireActual<typeof import('../../src/services/featureFlags')>(
      '../../src/services/featureFlags',
    );

  beforeEach(() => {
    clearFlagCache();
  });

  it('returns false for graphql_enabled by default (no DB)', () => {
    // With no DB initialised the service falls back to DEFAULTS (false)
    const result = realIsEnabled('graphql_enabled');
    expect(result).toBe(false);
  });
});
