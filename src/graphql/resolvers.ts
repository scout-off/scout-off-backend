/**
 * GraphQL resolvers.
 *
 * All resolvers use the existing DB helpers from src/db/index.ts — no DB
 * logic is duplicated here.  Milestone data is batch-loaded via DataLoader
 * to eliminate N+1 queries.
 *
 * Authentication: resolvers that require auth throw a GraphQL error with
 * extensions.code = 'UNAUTHENTICATED' (scout/admin paths) or
 * 'UNAUTHORIZED' (wrong role).  Read-only public resolvers (player, players)
 * are intentionally unauthenticated — the REST endpoints are also public.
 */

import { GraphQLError } from 'graphql';
import config from '../config';
import {
  getPlayerById,
  queryPlayers,
  countPlayers,
  getLatestSubscription,
  type PlayerRow,
} from '../db';
import { getTierMeta, tierName } from '../utils/tier';
import { canAccessPlayer } from '../utils/playerAccess';
import { hasApiKeyScope } from '../utils/apiKeyScopes';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../utils/pagination';
import { type GraphQLContext } from './context';

// ─── Auth helpers ──────────────────────────────────────────────────────────────

function assertAuthenticated(ctx: GraphQLContext): void {
  if (!ctx.account) {
    throw new GraphQLError('Authentication required', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
}

function assertRole(ctx: GraphQLContext, role: string): void {
  assertAuthenticated(ctx);
  if (ctx.role !== role) {
    throw new GraphQLError(`Requires ${role} role`, {
      extensions: { code: 'UNAUTHORIZED' },
    });
  }
}

/**
 * Enforce the shared API-key scope contract (#1019).
 *
 * Only applies when the request was authenticated with an API key that
 * carries an explicit (restricted) scope list. JWT/legacy-key requests
 * (`apiKeyScopes === undefined/null`) always pass — identical semantics to
 * the REST requireApiKeyScope middleware.
 */
function assertApiKeyScope(ctx: GraphQLContext, scope: string): void {
  if (ctx.apiKeyScopes === undefined || ctx.apiKeyScopes === null) return;
  if (!hasApiKeyScope(ctx.apiKeyScopes, scope)) {
    throw new GraphQLError(`Missing required API key scope: ${scope}`, {
      extensions: { code: 'UNAUTHORIZED', requiredScope: scope },
    });
  }
}

/**
 * Shared milestone-access gate (same decision as REST getPlayerMilestones).
 * Throws a NOT_FOUND error when the player is hidden from the caller,
 * mirroring the REST 404 response for deactivated players.
 */
function assertPlayerMilestonesAccess(ctx: GraphQLContext, row: PlayerRow): void {
  if (!canAccessPlayer(row, { account: ctx.account, role: ctx.role })) {
    throw new GraphQLError('Player not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }
}

// ─── Serialization ─────────────────────────────────────────────────────────────

function serializePlayer(row: PlayerRow) {
  const { tierName: tn, tierDescription } = getTierMeta(row.progress_level);
  return {
    player_id: row.player_id,
    wallet: row.wallet,
    position: row.position ?? null,
    region: row.region ?? null,
    metadataUri: row.metadata_uri ?? null,
    progress_level: row.progress_level,
    created_at: row.created_at ?? null,
    is_active: row.is_active ?? 1,
    tierName: tn,
    tierDescription,
    progress_tier_name: tierName(row.progress_level),
  };
}

// ─── Query resolvers ───────────────────────────────────────────────────────────

const Query = {
  /**
   * player(id: ID!): Player
   *
   * Returns null for deactivated players for unauthorized callers (same
   * access decision as REST GET /players/:id via src/utils/playerAccess.ts).
   * Owner/admin callers can still fetch deactivated players, exactly like REST.
   * Public — no auth required for active players.
   */
  async player(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const row = await getPlayerById(args.id);
    if (!row) return null;
    if (!canAccessPlayer(row, { account: ctx.account, role: ctx.role })) return null;
    return serializePlayer(row);
  },

  /**
   * players(region, position, minTier, page, pageSize): PlayerConnection
   *
   * Mirrors GET /api/players filter endpoint.  Public — no auth required.
   */
  async players(
    _parent: unknown,
    args: {
      region?: string | null;
      position?: string | null;
      minTier?: number | null;
      page?: number | null;
      pageSize?: number | null;
    },
    _ctx: GraphQLContext,
  ) {
    const page = Math.max(1, args.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, args.pageSize ?? DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;

    const opts = {
      region: args.region ?? undefined,
      position: args.position ?? undefined,
      minTier: args.minTier ?? undefined,
    };

    const rows = await queryPlayers({ ...opts, limit: pageSize, offset });
    const total = await countPlayers(opts);
    const pages = Math.ceil(total / pageSize);

    return {
      nodes: rows.map(serializePlayer),
      pageInfo: { total, page, pageSize, pages },
    };
  },

  /**
   * milestones(playerId: ID!): [Milestone!]!
   *
   * Returns combined indexed + on-chain milestones. Public for active
   * players; deactivated players follow the shared access decision
   * (owner/admin only) — identical to REST getPlayerMilestones (#1019).
   * API-key authenticated requests must carry the read:milestones scope.
   * Uses DataLoader under the hood when called as a root query too.
   */
  async milestones(
    _parent: unknown,
    args: { playerId: string },
    ctx: GraphQLContext,
  ) {
    assertApiKeyScope(ctx, 'read:milestones');
    const player = await getPlayerById(args.playerId);
    if (!player) {
      throw new GraphQLError('Player not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    assertPlayerMilestonesAccess(ctx, player);
    return ctx.loaders.milestones.load(args.playerId);
  },

  /**
   * scoutSubscription(wallet: String!): ScoutSubscription
   *
   * Returns the active subscription status for a scout wallet.
   * Requires authentication; scout can only query their own wallet,
   * admins can query any wallet.
   */
  async scoutSubscription(
    _parent: unknown,
    args: { wallet: string },
    ctx: GraphQLContext,
  ) {
    assertAuthenticated(ctx);
    // Restricted API keys need the read:subscription scope (REST's
    // GET /scouts/:wallet/subscription enforces the same scope).
    assertApiKeyScope(ctx, 'read:subscription');
    if (ctx.role !== 'admin' && ctx.account !== args.wallet) {
      throw new GraphQLError('You can only query your own subscription', {
        extensions: { code: 'UNAUTHORIZED' },
      });
    }

    const sub = await getLatestSubscription(args.wallet);
    const now = Math.floor(Date.now() / 1000);

    if (!sub) {
      return {
        active: false,
        tier: null,
        expiresAt: null,
        remainingDays: 0,
        gracePeriodActive: false,
      };
    }

    const gracePeriodSecs = config.subscriptionGracePeriodHours * 3600;
    const inGrace = now > sub.expires_at && now <= sub.expires_at + gracePeriodSecs;
    const active = sub.expires_at > now || inGrace;
    const remainingDays = Math.max(0, Math.ceil((sub.expires_at - now) / 86400));

    return {
      active,
      tier: sub.tier,
      expiresAt: sub.expires_at,
      remainingDays,
      gracePeriodActive: inGrace,
    };
  },
};

// ─── Field resolvers ───────────────────────────────────────────────────────────

const Player = {
  /**
   * Player.milestones — uses DataLoader so a single fetch batches all
   * milestone lookups into a single DB+RPC round-trip.
   *
   * Applies the same shared access decision as REST (via
   * src/utils/playerAccess.ts): when the parent player is deactivated and
   * the caller is neither owner nor admin, the field resolves to an empty
   * list — no milestone data is revealed. Active players are unaffected.
   */
  async milestones(
    parent: { player_id: string; wallet: string; is_active?: number | null },
    _args: unknown,
    ctx: GraphQLContext,
  ) {
    assertApiKeyScope(ctx, 'read:milestones');
    if (!canAccessPlayer(parent, { account: ctx.account, role: ctx.role })) {
      return [];
    }
    return ctx.loaders.milestones.load(parent.player_id);
  },
};

export const resolvers = {
  Query,
  Player,
};
