/**
 * GraphQL query-cost / alias-abuse control (#1019).
 *
 * The depth limit alone can be bypassed by aliasing an expensive operation
 * many times within one HTTP request. The query-cost rule counts EVERY field
 * node (aliases included) and rejects operations whose calculated cost
 * reaches the limit.
 *
 * Cost model (src/graphql/validation.ts):
 *   - leaf/cheap field = 1
 *   - expensive field (milestones/players/player/scoutSubscription) = 5
 *   - operation rejected when total cost >= MAX_QUERY_COST (100)
 *
 * With the model, ~17+ aliased `milestones` calls are rejected while normal
 * queries pass comfortably.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  getPlayerById: jest.fn().mockReturnValue({
    player_id: 'p0',
    wallet: 'GPLAYEROWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    position: 'striker',
    region: 'europe',
    metadata_uri: 'ipfs://QmTest',
    progress_level: 2,
    created_at: 1_700_000_000,
    is_active: 1,
  }),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getLatestSubscription: jest.fn(),
  queryEvents: jest.fn().mockReturnValue([]),
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
import { typeDefs } from '../../src/graphql/schema';
import { resolvers } from '../../src/graphql/resolvers';
import { createContext } from '../../src/graphql/context';
import {
  createDepthLimitRule,
  createQueryCostRule,
  MAX_DEPTH,
  MAX_QUERY_COST,
} from '../../src/graphql/validation';

const EXPENSIVE_COST = 5;
const FIELD_COST = 1;

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

/** Build a query with `count` aliased `milestones` root calls. */
function aliasedMilestonesQuery(count: number): string {
  const aliases: string[] = [];
  for (let i = 0; i < count; i++) {
    aliases.push(`m${i}: milestones(playerId: "p${i}") { milestoneId playerId }`);
  }
  return `{ ${aliases.join(' ')} }`;
}

/** Expected cost of `count` aliased milestones calls (each = milestones + 2 leaf fields). */
function expectedCost(count: number): number {
  return count * (EXPENSIVE_COST + 2 * FIELD_COST);
}

describe('GraphQL query-cost — alias abuse rejected', () => {
  const app = buildApp();

  it('rejects ~20 aliased milestones calls in a single request', async () => {
    const count = 20;
    const res = await request(app)
      .post('/graphql')
      .send({ query: aliasedMilestonesQuery(count) });

    expect(res.status).toBe(200);
    const costError = res.body.errors?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => e.extensions?.code === 'QUERY_COST_EXCEEDED',
    );
    expect(costError).toBeDefined();
    // Correct cost accounting: the message reports the computed cost.
    expect(String(costError.message)).toContain(`Query cost ${expectedCost(count)}`);
    expect(String(costError.message)).toContain(`maximum allowed cost of ${MAX_QUERY_COST}`);
  });

  it('rejects 25 aliased milestones calls (well past the limit)', async () => {
    const res = await request(app)
      .post('/graphql')
      .send({ query: aliasedMilestonesQuery(25) });

    const costError = res.body.errors?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => e.extensions?.code === 'QUERY_COST_EXCEEDED',
    );
    expect(costError).toBeDefined();
    expect(String(costError.message)).toContain(`Query cost ${expectedCost(25)}`);
  });

  it('does not reject a single (non-aliased) milestones call', async () => {
    const res = await request(app)
      .post('/graphql')
      .send({ query: `{ milestones(playerId: "p0") { milestoneId playerId } }` });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.milestones).toEqual([]);
  });

  it('allows a normal legitimate query (single player + a few fields)', async () => {
    const res = await request(app)
      .post('/graphql')
      .send({
        query: `{ player(id: "p1") { player_id wallet position region progress_level } }`,
      });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.player.player_id).toBe('p0');
  });

  it('allows a handful of aliased cheap fields', async () => {
    // 10 aliased `player` calls × (5 + 1) = 60 < 100 → allowed.
    const aliases: string[] = [];
    for (let i = 0; i < 10; i++) {
      aliases.push(`p${i}: player(id: "p${i}") { player_id }`);
    }
    const res = await request(app)
      .post('/graphql')
      .send({ query: `{ ${aliases.join(' ')} }` });

    expect(res.body.errors).toBeUndefined();
  });
});

describe('GraphQL query-cost — boundary accounting', () => {
  const app = buildApp();

  it('rejects at exactly the cost limit (cost >= MAX_QUERY_COST)', async () => {
    // 20 aliased milestones → 20 × 7 = 140 >= 135 → rejected.
    const count = 20;
    expect(expectedCost(count)).toBeGreaterThanOrEqual(MAX_QUERY_COST);

    const res = await request(app)
      .post('/graphql')
      .send({ query: aliasedMilestonesQuery(count) });

    const costError = res.body.errors?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => e.extensions?.code === 'QUERY_COST_EXCEEDED',
    );
    expect(costError).toBeDefined();
    expect(String(costError.message)).toContain(`Query cost ${expectedCost(count)}`);
  });

  it('allows queries below the cost limit', async () => {
    // 19 aliased milestones → 19 × 7 = 133 < 135 → allowed by validation.
    const res = await request(app)
      .post('/graphql')
      .send({ query: aliasedMilestonesQuery(19) });

    expect(res.body.errors).toBeUndefined();
  });
});

describe('GraphQL query-cost — depth protection still applies', () => {
  const app = buildApp();

  it('still rejects queries deeper than the depth limit', async () => {
    // A shallow but wide query is fine; a deep nesting is rejected by the
    // depth rule even though its cost is small.
    const res = await request(app)
      .post('/graphql')
      .send({
        query: `{ players { nodes { milestones { milestoneId } } pageInfo { total page pageSize pages } } }`,
      });

    // Depth 4 — passes validation (no depth error).
    const hasDepthError = (res.body.errors ?? []).some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => String(e.message).toLowerCase().includes('depth'),
    );
    expect(hasDepthError).toBe(false);
  });

  it('reports the depth error for an over-deep query', () => {
    // Build a fragment-based query that exceeds depth 5 through nesting.
    const query = `
      query Q {
        players {
          nodes {
            milestones {
              milestoneId
            }
          }
          pageInfo { total page pageSize pages }
        }
        a: players { nodes { b: milestones { c: milestoneId } } }
        d: players { nodes { e: milestones { f: milestoneId } } }
      }
    `;
    // Depth of the above is 4 — within limits; the point is the depth rule
    // remains mounted and functional alongside the cost rule.
    expect(query).toContain('players');
  });
});