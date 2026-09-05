/**
 * GraphQL API-key scope enforcement (#1019).
 *
 * The GraphQL context resolves X-API-Key headers through the SAME
 * resolveApiKey path as REST, and resolvers enforce the shared scope
 * contract (src/utils/apiKeyScopes.ts):
 *   - milestones        → read:milestones
 *   - scoutSubscription → read:subscription
 *
 * Legacy/unrestricted keys and JWT/anon requests are never scope-gated.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  getPlayerById: jest.fn(),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getLatestSubscription: jest.fn(),
  queryEvents: jest.fn().mockReturnValue([]),
  getActiveApiKeyByLookupHash: jest.fn().mockReturnValue(null),
  getActiveApiKeysAwaitingLookupHash: jest.fn().mockReturnValue([]),
  setApiKeyLookupHash: jest.fn(),
  touchApiKeyLastUsed: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/tokenBlocklist', () => ({
  isTokenRevoked: jest.fn().mockResolvedValue(false),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { createYoga, createSchema } from 'graphql-yoga';
import { useValidationRule } from '@envelop/core';
import request from 'supertest';
import express from 'express';
import { getPlayerById, getActiveApiKeyByLookupHash } from '../../src/db';
import { generateApiKey } from '../../src/controllers/apiKeyController';
import { typeDefs } from '../../src/graphql/schema';
import { resolvers } from '../../src/graphql/resolvers';
import { createContext } from '../../src/graphql/context';
import { createDepthLimitRule, createQueryCostRule, MAX_DEPTH, MAX_QUERY_COST } from '../../src/graphql/validation';

const mockGetPlayerById = getPlayerById as jest.Mock;
const mockGetByLookup = getActiveApiKeyByLookupHash as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PLAYER_ID = 'p-scope';
const PLAYER_WALLET = 'GPLAYEROWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Seed one active API key with the given scopes; returns the raw key. Mirrors
 * the indexed lookup added in #1033 — the row resolves only for its own
 * derived lookup hash.
 */
function seedKey(scopes: string[] | null): string {
  const { key, keyHash, lookupHash } = generateApiKey();
  const row = {
    id: 55,
    key_hash: keyHash,
    scout_wallet: PLAYER_WALLET,
    label: 'fixture',
    created_at: 0,
    last_used_at: null,
    revoked_at: null,
    scopes: scopes === null ? null : JSON.stringify(scopes),
    rate_limit_per_minute: null,
    lookup_hash: lookupHash,
  };
  mockGetByLookup.mockImplementation((candidate: string) =>
    candidate === lookupHash ? row : null,
  );
  return key;
}

function buildApp() {
  const app = express();
  app.use(express.json());

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: createContext,
    plugins: [
      useValidationRule(createDepthLimitRule(MAX_DEPTH)),
      useValidationRule(createQueryCostRule(MAX_QUERY_COST)),
    ],
    graphqlEndpoint: '/graphql',
    maskedErrors: false,
  });

  app.use('/graphql', yoga);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlayerById.mockReturnValue({
    player_id: PLAYER_ID,
    wallet: PLAYER_WALLET,
    position: 'striker',
    region: 'europe',
    metadata_uri: 'ipfs://QmTest',
    progress_level: 2,
    created_at: 1_700_000_000,
    is_active: 1,
  });
});

const MILESTONE_QUERY = `{ milestones(playerId: "${PLAYER_ID}") { milestoneId } }`;

// ─── Milestones read scope ────────────────────────────────────────────────────

describe('GraphQL — milestones + API-key read:milestones scope', () => {
  it('allows a restricted key that has read:milestones', async () => {
    const key = seedKey(['read:milestones']);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', key)
      .send({ query: MILESTONE_QUERY });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.milestones).toEqual([]);
  });

  it('denies a restricted key without read:milestones (UNAUTHORIZED)', async () => {
    const key = seedKey(['write:contacts']);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', key)
      .send({ query: MILESTONE_QUERY });

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions?.code).toBe('UNAUTHORIZED');
    expect(String(res.body.errors[0].message)).toContain('read:milestones');
    expect(res.body.data?.milestones).toBeUndefined();
  });

  it('allows a legacy (null scopes) key', async () => {
    const key = seedKey(null);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', key)
      .send({ query: MILESTONE_QUERY });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.milestones).toEqual([]);
  });

  it('allows anonymous requests (public read unaffected by scopes)', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .send({ query: MILESTONE_QUERY });

    expect(res.body.errors).toBeUndefined();
  });

  it('treats an invalid API key as unauthenticated on protected queries', async () => {
    mockGetByLookup.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', 'unknown-key')
      .send({ query: MILESTONE_QUERY });

    // milestones is public, so an invalid key still works anonymously —
    // the key must simply not grant anything.
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.milestones).toEqual([]);
  });
});

// ─── Subscription read scope ──────────────────────────────────────────────────

describe('GraphQL — scoutSubscription + API-key read:subscription scope', () => {
  const SUB_QUERY = `{ scoutSubscription(wallet: "${PLAYER_WALLET}") { active } }`;

  it('allows a restricted key that has read:subscription', async () => {
    const key = seedKey(['read:subscription']);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', key)
      .send({ query: SUB_QUERY });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.scoutSubscription.active).toBe(false);
  });

  it('denies a restricted key without read:subscription (UNAUTHORIZED)', async () => {
    const key = seedKey(['read:milestones']);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', key)
      .send({ query: SUB_QUERY });

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions?.code).toBe('UNAUTHORIZED');
    expect(String(res.body.errors[0].message)).toContain('read:subscription');
  });

  it('allows a legacy (null scopes) key to query its own subscription', async () => {
    const key = seedKey(null);
    const app = buildApp();

    const res = await request(app)
      .post('/graphql')
      .set('X-API-Key', key)
      .send({ query: SUB_QUERY });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.scoutSubscription.active).toBe(false);
  });
});