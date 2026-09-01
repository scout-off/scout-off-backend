/**
 * GraphQL SDL schema for the read-heavy scout/player query paths.
 *
 * Mutations are intentionally out of scope (read-only queries only).
 * Types mirror the REST API shapes — any field that is nullable in the DB
 * is marked nullable here.
 */
export const typeDefs = /* GraphQL */ `
  type Player {
    player_id: ID!
    wallet: String!
    position: String
    region: String
    metadataUri: String
    progress_level: Int!
    created_at: Int
    is_active: Int!
    tierName: String!
    tierDescription: String!
    progress_tier_name: String!
    milestones: [Milestone!]!
  }

  type PageInfo {
    total: Int!
    page: Int!
    pageSize: Int!
    pages: Int!
  }

  type PlayerConnection {
    nodes: [Player!]!
    pageInfo: PageInfo!
  }

  type Milestone {
    milestoneId: String
    playerId: String!
    milestoneType: String
    evidenceUri: String
    approved: Boolean
    approvedBy: String
    submittedAt: Int
    approvedAt: Int
  }

  type ScoutSubscription {
    active: Boolean!
    tier: String
    expiresAt: Int
    remainingDays: Int!
    gracePeriodActive: Boolean!
  }

  type ContactUnlock {
    scout_wallet: String!
    player_id: String!
    tx_hash: String!
    unlocked_at: Int!
  }

  type TrialOffer {
    offer_id: String!
    scout_wallet: String!
    player_id: String!
    details_uri: String!
    status: String!
    reject_reason: String
    responded_at: Int
    created_at: Int!
  }

  type Query {
    """Fetch a single player by ID. Returns null if not found or deactivated."""
    player(id: ID!): Player

    """
    Paginated player list with optional region/position/minTier filters.
    Mirrors GET /api/players.
    """
    players(
      region: String
      position: String
      minTier: Int
      page: Int
      pageSize: Int
    ): PlayerConnection!

    """All approved and pending milestones for a player."""
    milestones(playerId: ID!): [Milestone!]!

    """Active subscription status for a scout wallet."""
    scoutSubscription(wallet: String!): ScoutSubscription
  }
`;
