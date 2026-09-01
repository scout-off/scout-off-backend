/**
 * IP Reputation Scoring Service
 *
 * Tracks per-IP behaviour metrics (error rate, rate-limit hits, auth failures)
 * and calculates a reputation score (0 = clean, 100 = blocked).
 *
 * The score is stored in a process-local in-memory map only. Scores decay by
 * 10% per hour to forgive transient spikes. Admin endpoints can manually
 * whitelist (score=0) or blacklist (score=100) an IP.
 *
 * Known limitation: this store is not shared across instances — in a
 * multi-instance deployment, a given IP's score is fragmented per instance
 * rather than tracked cross-instance. See issue #1100 for backing this with
 * Redis.
 *
 * Score thresholds:
 *   0–49  : normal - no penalty
 *   50–74 : degraded - 500 ms response delay
 *   75–89 : restricted - rate limit reduced to 5 req/min
 *   90–100: blocked - immediate 429
 */

const HOUR_MS = 60 * 60 * 1000;
const DECAY_RATE = 0.10; // 10% decay per hour
const DECAY_INTERVAL_MS = HOUR_MS;

export interface IpReputation {
  score: number;
  lastSeen: number;
  /** Unix timestamp (ms) when this IP was manually pinned to a score (whitelist/blacklist). */
  pinnedAt?: number;
  /** If set, the score is pinned and decay/increment are suppressed. */
  pinned?: boolean;
}

export type ReputationTier = 'normal' | 'degraded' | 'restricted' | 'blocked';

// ─── Prometheus-style counters ────────────────────────────────────────────────

export const ipReputationCounters = {
  blocked: 0,
  penalised: 0,
};

export function resetIpReputationCounters(): void {
  ipReputationCounters.blocked = 0;
  ipReputationCounters.penalised = 0;
}

// ─── In-memory store (primary backing; can be swapped to Redis via wrapper) ───

const reputationStore = new Map<string, IpReputation>();

let decayTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic decay timer. Safe to call multiple times (idempotent).
 * Must be called explicitly from the server bootstrap (see src/index.ts).
 */
export function startDecayTimer(): void {
  if (decayTimer !== null) return;
  decayTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, rep] of reputationStore.entries()) {
      if (rep.pinned) continue; // pinned IPs are immune to decay
      const hoursElapsed = (now - rep.lastSeen) / HOUR_MS;
      if (hoursElapsed >= 1) {
        applyDecay(ip, hoursElapsed);
      }
    }
  }, DECAY_INTERVAL_MS);
  // Don't block process exit for this timer
  if (decayTimer && typeof (decayTimer as NodeJS.Timeout).unref === 'function') {
    (decayTimer as NodeJS.Timeout).unref();
  }
}

/** Stop the decay timer. Intended for test teardown. */
export function stopDecayTimer(): void {
  if (decayTimer !== null) {
    clearInterval(decayTimer);
    decayTimer = null;
  }
}

/** Reset the entire reputation store. Intended for test isolation. */
export function resetReputationStore(): void {
  reputationStore.clear();
}

// ─── Score thresholds ────────────────────────────────────────────────────────

export const SCORE_DELAY_THRESHOLD = 50;      // 500 ms delay
export const SCORE_RESTRICT_THRESHOLD = 75;   // reduced rate limit
export const SCORE_BLOCK_THRESHOLD = 90;      // immediate 429

// ─── Point increments ────────────────────────────────────────────────────────

export const POINTS = {
  RATE_LIMIT_HIT: 5,
  ERROR_4XX: 1,
  ERROR_5XX: 2,
  AUTH_FAILURE: 10,
  BAD_USER_AGENT: 20,
} as const;

// Known bad/scanner user-agent substrings (lowercase)
const BAD_USER_AGENTS = [
  'sqlmap',
  'nikto',
  'masscan',
  'nmap',
  'zgrab',
  'dirbuster',
  'gobuster',
  'hydra',
  'nessus',
  'openvas',
];

export function isBadUserAgent(ua: string | undefined): boolean {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return BAD_USER_AGENTS.some((bad) => lower.includes(bad));
}

// ─── Core getters / setters ──────────────────────────────────────────────────

function getOrCreate(ip: string): IpReputation {
  let rep = reputationStore.get(ip);
  if (!rep) {
    rep = { score: 0, lastSeen: Date.now() };
    reputationStore.set(ip, rep);
  }
  return rep;
}

export function getReputation(ip: string): IpReputation | undefined {
  return reputationStore.get(ip);
}

export function getScore(ip: string): number {
  return reputationStore.get(ip)?.score ?? 0;
}

export function getTier(score: number): ReputationTier {
  if (score >= SCORE_BLOCK_THRESHOLD) return 'blocked';
  if (score >= SCORE_RESTRICT_THRESHOLD) return 'restricted';
  if (score >= SCORE_DELAY_THRESHOLD) return 'degraded';
  return 'normal';
}

/**
 * Add points to an IP's reputation score.
 * Pinned IPs are immune to increments.
 * Score is clamped to [0, 100].
 */
export function addPoints(ip: string, points: number): void {
  const rep = getOrCreate(ip);
  if (rep.pinned) return;
  rep.score = Math.min(100, rep.score + points);
  rep.lastSeen = Date.now();
}

/**
 * Apply score decay for a given number of hours elapsed.
 * Used by unit tests to verify decay behaviour without waiting for the timer.
 */
export function applyDecay(ip: string, hoursElapsed: number): void {
  const rep = reputationStore.get(ip);
  if (!rep || rep.pinned) return;
  const decayFactor = Math.pow(1 - DECAY_RATE, hoursElapsed);
  rep.score = Math.max(0, Math.round(rep.score * decayFactor));
  if (rep.score === 0) {
    reputationStore.delete(ip);
  }
}

/**
 * Manually pin an IP to a fixed score (admin whitelist/blacklist).
 * A pinned IP is immune to both score increments and decay.
 * Set `pinned = false` to un-pin.
 */
export function setIpScore(ip: string, score: number, pinned = true): void {
  const rep = getOrCreate(ip);
  rep.score = Math.max(0, Math.min(100, score));
  rep.pinned = pinned;
  rep.pinnedAt = Date.now();
  rep.lastSeen = Date.now();
}
