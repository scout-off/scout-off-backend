// ─── Player ──────────────────────────────────────────────────────────────────

export type ProgressLevel = 0 | 1 | 2 | 3;

export interface Player {
  playerId: string;
  wallet: string;
  metadataUri: string; // IPFS CID pointing to off-chain profile JSON
  position: string;
  region: string;
  progressLevel: ProgressLevel;
  createdAt: number; // ledger timestamp
}

export interface PlayerMetadata {
  name: string;
  age: number;
  position: string;
  region: string;
  club?: string;
  highlightReels: string[]; // IPFS CIDs
  stats?: Record<string, string | number>;
}

// Detailed player profile stored off-chain (IPFS JSON). Example:
// {
//   "displayName": "John Doe",
//   "birthDate": "2004-05-10",
//   "positions": ["LW","ST"],
//   "bio": "Youth prospect",
//   "social": { "instagram": "@johndoe" },
//   "milestones": [{ "id": "m1", "type": "performance", "note": "Scored hat-trick" }]
// }
export interface PlayerProfile {
  displayName: string;
  birthDate?: string; // ISO date string
  positions: string[];
  bio?: string;
  social?: Record<string, string>;
  // Off-chain references to milestone summaries or documents
  milestones?: Array<{
    id: string;
    type: MilestoneType;
    note?: string;
    evidenceCid?: string; // IPFS CID
  }>;
}

// Subscription tier values coming from on-chain scout_subscribed events
export type SubscriptionTier = 'basic' | 'premium' | 'pro';

// Subscription state for scouts subscribing to player contact details
export interface Subscription {
  subscriptionId: string;
  scoutWallet: string;
  playerId: string;
  startedAt: number; // unix timestamp
  expiresAt?: number; // optional expiry timestamp
  tier?: SubscriptionTier;
}

// Return type of isSubscribed() — includes tier when subscription is active
export interface SubscriptionStatus {
  active: boolean;
  tier: SubscriptionTier | null;
  expiresAt: number | null;
  remainingDays: number;
}

// ─── Milestone ────────────────────────────────────────────────────────────────

export type MilestoneType = 'identity' | 'performance' | 'trial_offer';

export type MilestoneStatus = 'pending' | 'approved' | 'rejected';

export interface Milestone {
  milestoneId: string;
  playerId: string;
  milestoneType: MilestoneType;
  evidenceUri: string; // IPFS CID
  validator: string;   // Stellar address
  approved: boolean;
  createdAt: number;
}

export interface PlayerMilestone {
  status: MilestoneStatus;
  approvedBy: string;
  submittedAt: number;
  evidenceUri: string;
}

// ─── Scout ────────────────────────────────────────────────────────────────────


export interface Scout {
  wallet: string;
  subscriptionExpiry?: number; // ledger timestamp; undefined = no active sub
}

export interface ContactUnlock {
  scout: string;
  playerId: string;
  unlockedAt: number;
}

/** A single entry in a scout's payment history. */
export interface PaymentHistoryItem {
  /** On-chain transaction hash, or null when unavailable. */
  transactionId: string | null;
  amount: string;
  token: string;
  timestamp: string;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface AdminEvent {
  type: ContractEventType;
  ledger: number;
  txHash: string;
  payload: Record<string, unknown>;
}

// ─── API shapes ───────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  correlationId?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

export interface FilterPlayersQuery {
  region?: string;
  position?: string;
  minTier?: ProgressLevel;
  page?: number;
  pageSize?: number;
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  wallet: string;
  role: string;
  exp: number;
  permissions?: string[];
}

// ─── Express Request augmentation ─────────────────────────────────────────────
//
// Extends the Express Request interface so that req.account and req.role are
// properly typed throughout the codebase — no (req as any) casts needed.
// These fields are attached by requireAuth / requireRole middleware in
// src/middleware/auth.ts.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Stellar public key of the authenticated user (set by auth middleware). */
      account?: string;
      /** Role of the authenticated user, e.g. 'admin', 'validator', 'scout'. */
      role?: string;
      /** JWT ID of the bearer token used for this request (set by auth middleware). */
      jti?: string;
      /**
       * Parsed API-key scopes when the request was authenticated via
       * X-API-Key. `null` = legacy/unrestricted key; `undefined` = the
       * request was not authenticated with an API key (e.g. JWT).
       */
      apiKeyScopes?: string[] | null;
    }
  }
}

// ─── SEP-10 ───────────────────────────────────────────────────────────────────

export interface Sep10Challenge {
  challenge: string; // XDR
  networkPassphrase: string;
}

export interface Sep10Token {
  token: string;
  account: string;
  expiresAt: number; // Unix timestamp
}

/** Shape of a single fee withdrawal record from GET /api/admin/fees. */
export interface FeeHistoryItem {
  amount: string;
  recipient: string;
  ledger: number;
  txHash: string;
  timestamp: number;
}

// ─── Contract events (indexed) ────────────────────────────────────────────────

export type ContractEventType =
  | 'player_registered'
  | 'milestone_submitted'
  | 'milestone_approved'
  | 'milestone_rejected'
  | 'scout_subscribed'
  | 'contact_unlocked'
  | 'trial_offer_logged'
  | 'trial_offer_accepted'
  | 'trial_offer_rejected'
  | 'trial_offer_cancelled'
  | 'fees_withdrawn'
  | 'player_deactivated'
  | 'player_reactivated';

export interface ContractEvent {
  type: ContractEventType;
  ledger: number;
  txHash: string;
  payload: Record<string, unknown>;
}

export interface EventRecord {
  source: string;
  type: ContractEventType;
  payload: Record<string, unknown>;
  contractAddress: string;
  created_at?: number | null;
}
