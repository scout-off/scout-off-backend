// ─── Player ──────────────────────────────────────────────────────────────────

export type ProgressLevel = 0 | 1 | 2 | 3;

export interface Player {
  playerId: string;
  wallet: string;
  metadataUri: string; // IPFS CID pointing to off-chain profile JSON
  position: string;
  region: string;
  progressLevel: ProgressLevel;
  createdAt: number;  // ledger timestamp
  updatedAt: number;  // unix timestamp of last profile update
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

// Subscription state for scouts subscribing to player contact details
export interface Subscription {
  subscriptionId: string;
  scoutWallet: string;
  playerId: string;
  startedAt: number; // unix timestamp
  expiresAt?: number; // optional expiry timestamp
  tier?: string;
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

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface AdminEvent {
  type: ContractEventType;
  ledger: number;
  txHash: string;
  payload: Record<string, unknown>;
}

export interface FeeHistoryItem {
  amount: number;
  recipient: string;
  ledger: number;
}

// ─── API shapes ───────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
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

// ─── Contract events (indexed) ────────────────────────────────────────────────

export type ContractEventType =
  | 'player_registered'
  | 'milestone_submitted'
  | 'milestone_approved'
  | 'scout_subscribed'
  | 'contact_unlocked'
  | 'trial_offer_logged'
  | 'fees_withdrawn';

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
}
