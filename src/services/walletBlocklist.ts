/**
 * Wallet Blocklist Service (#1019)
 *
 * Manages the wallet blocklist used to terminate established SSE connections
 * when a wallet is blocked (abuse prevention).
 *
 * Design constraints:
 *   - The SSE keep-alive tick must NOT perform a DB query per connection.
 *   - Blocking must be detected promptly (bounded) by established connections.
 *
 * Strategy (mirrors tokenBlocklist.ts):
 *   - Primary signal: in-process events. `blockWallet()` persists to the DB
 *     and synchronously notifies subscribers (`onWalletBlocked`) so SSE
 *     connections in this process react immediately.
 *   - Cross-process safety: `refreshBlockedWallets()` re-syncs the in-memory
 *     cache from the DB in a single query; the SSE route runs it on a slow
 *     sweep interval (default 30 s) shared by ALL connections — never once
 *     per keep-alive tick.
 *   - `isWalletBlocklisted` is cache-first: a fresh DB check happens at most
 *     once per wallet per cache TTL (and at connection time), never per tick.
 *
 * The DB table is created by db/022_wallet_blocklist.sql.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import {
  blockWalletDb,
  unblockWalletDb,
  isWalletBlocklistedDb,
  listBlockedWalletsDb,
} from '../db';

// ─── Configuration ────────────────────────────────────────────────────────────

/** How long a cached blocklist entry is trusted before a fresh DB read. */
const CACHE_TTL_MS = parseInt(process.env.WALLET_BLOCKLIST_CACHE_TTL_MS ?? '30000', 10);

// ─── State ────────────────────────────────────────────────────────────────────

/** wallet → timestamp of the last cache (re)fill. */
const blockedCache = new Map<string, number>();

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per SSE connection

const BLOCKED_EVENT = 'wallet_blocked';

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function refreshWallet(wallet: string): Promise<boolean> {
  try {
    const blocked = await isWalletBlocklistedDb(wallet);
    if (blocked) {
      blockedCache.set(wallet, Date.now());
    } else {
      blockedCache.delete(wallet);
    }
    return blocked;
  } catch (err) {
    // Fail-open on store errors: never block legitimate traffic because the
    // blocklist store is temporarily unavailable.
    logger.warn(`[walletBlocklist] DB check failed for ${wallet}:`, err);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Blocklist a wallet. Persists immediately and notifies local subscribers
 * (SSE connections) synchronously.
 */
export async function blocklistWallet(wallet: string, reason: string | null = null): Promise<void> {
  try {
    await blockWalletDb(wallet, reason);
    blockedCache.set(wallet, Date.now());
    emitter.emit(BLOCKED_EVENT, wallet);
    logger.warn(`[walletBlocklist] wallet blocked: ${wallet}`);
  } catch (err) {
    logger.error(`[walletBlocklist] block failed for ${wallet}:`, err);
    throw err;
  }
}

/** Remove a wallet from the blocklist. Returns true if it was blocked. */
export async function unblocklistWallet(wallet: string): Promise<boolean> {
  try {
    const removed = await unblockWalletDb(wallet);
    blockedCache.delete(wallet);
    if (removed) {
      logger.info(`[walletBlocklist] wallet unblocked: ${wallet}`);
    }
    return removed;
  } catch (err) {
    logger.error(`[walletBlocklist] unblock failed for ${wallet}:`, err);
    throw err;
  }
}

/**
 * Cache-first blocklist check. At most one fresh DB read per wallet per
 * CACHE_TTL_MS — safe to call on connection setup, never on keep-alive ticks.
 */
export async function isWalletBlocklisted(wallet: string): Promise<boolean> {
  const lastChecked = blockedCache.get(wallet);
  const cacheFresh = lastChecked !== undefined && Date.now() - lastChecked < CACHE_TTL_MS;
  if (cacheFresh) return true; // cached as blocked
  return refreshWallet(wallet);
}

/**
 * Re-sync the in-memory cache from the DB (one query). Returns the wallets
 * that are currently blocked. Called by the SSE route on its shared sweep
 * interval so cross-process blocks are picked up within the sweep bound.
 */
export async function refreshBlockedWallets(): Promise<string[]> {
  try {
    const wallets = await listBlockedWalletsDb();
    const now = Date.now();
    blockedCache.clear();
    for (const w of wallets) blockedCache.set(w, now);
    return wallets;
  } catch (err) {
    logger.warn('[walletBlocklist] refresh from DB failed:', err);
    return Array.from(blockedCache.keys());
  }
}

/**
 * Subscribe to blocklist events. The callback fires synchronously whenever a
 * wallet is blocklisted in this process. Returns an unsubscribe function.
 */
export function onWalletBlocked(cb: (wallet: string) => void): () => void {
  emitter.on(BLOCKED_EVENT, cb);
  return () => {
    emitter.off(BLOCKED_EVENT, cb);
  };
}

/** Exposed for tests: reset cache + listeners. */
export function _resetWalletBlocklistForTests(): void {
  blockedCache.clear();
  emitter.removeAllListeners();
}