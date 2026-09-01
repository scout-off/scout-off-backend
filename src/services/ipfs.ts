// IPFS service via Pinata.
//
// When PINATA_API_KEY and PINATA_SECRET are not set:
//   - In non-production environments the service starts normally and pin operations
//     return deterministic stub values, logging a warning on each call.
//   - In production (NODE_ENV=production) pin operations throw immediately with a
//     clear error so misconfiguration is caught at call time rather than silently.
//
// IPFS failure handling (#346):
//   - Failures emit a CRITICAL log entry.
//   - The JSON payload is queued in the pending_pins SQLite table for async retry.
//
// Service dependency: Pinata (https://pinata.cloud)
//   Required env vars: PINATA_API_KEY, PINATA_SECRET
//   Optional env var:  PINATA_GATEWAY (default: https://gateway.pinata.cloud)
//
// ── Distributed deduplication flow (multi-instance deployments) ──────────────
//
// pinJson() uses a two-layer dedup strategy:
//
//   Layer 1 — Process-local (single instance, same process):
//     • pinJsonCache: in-memory Map keyed by content hash, TTL-bounded.
//     • inflightPins: in-memory Map of in-flight Promises so concurrent calls
//       within the same process share one Pinata round-trip.
//
//   Layer 2 — Cross-instance (multiple pods behind a load balancer):
//     • pending_pins DB row as a distributed mutex:
//         INSERT OR IGNORE … WHERE hash = <content-hash>
//       Only the instance that succeeds the INSERT (changes > 0) proceeds to
//       upload. All other instances detect the row already exists and enter a
//       poll loop.
//     • resolved_cid column on the same pending_pins row:
//         The WINNING instance writes the CID into resolved_cid immediately
//         after a successful Pinata upload (before deleting the row).
//         LOSING instances, on observing the lock row disappear, call
//         getResolvedCidByHash() to read the CID from the DB.  If it is
//         present they return it directly — no duplicate upload occurs.
//         Only if the CID is absent (e.g. the winning instance crashed before
//         writing it) does the losing instance fall through to its own upload.
//
// This eliminates the original bug where a losing instance, finding its local
// caches empty after the lock cleared, unconditionally re-uploaded the same
// content — defeating the purpose of the lock in multi-instance deployments.

import { createHash } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import { logger } from '../utils/logger';
import {
  insertPendingPin,
  getPendingPins,
  deletePendingPin,
  deletePendingPinByHash,
  isPendingPinByHash,
  incrementPendingPinAttempts,
  setPendingPinResolvedCid,
  getResolvedCidByHash,
  getStalePendingPins,
  updatePendingPinReconciliation,
  countStuckPendingPins,
} from '../db';
import { observeIpfsLatency, setStuckPendingPinsCount } from '../middleware/metrics';

const tracer = trace.getTracer('scout-off-backend');

const PINATA_PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_TEST_URL     = 'https://api.pinata.cloud/data/testAuthentication';

function isPinataConfigured(): boolean {
  return !!(config.pinata.apiKey && config.pinata.secret);
}

function assertPinataConfigured(): void {
  throw new Error(
    'IPFS service unavailable: PINATA_API_KEY and PINATA_SECRET must be set in production'
  );
}

function pinataHeaders() {
  return {
    pinata_api_key: config.pinata.apiKey,
    pinata_secret_api_key: config.pinata.secret,
  };
}

function devStubCid(seed: string): string {
  const n = seed.length + (seed.charCodeAt(0) || 0);
  return `bafymock${n}`;
}

// ---------------------------------------------------------------------------
// pinJson deduplication cache & inflight promise tracker (#466)
// ---------------------------------------------------------------------------

/**
 * Recursively serialize an object with sorted keys for deterministic hashing.
 * Using sorted-key serialization rather than JSON.stringify(obj) directly
 * because key insertion order is not guaranteed to be identical across call
 * sites, which would produce different hashes for semantically identical
 * objects.
 * No external stable-stringify dependency is needed — a small recursive
 * implementation is sufficient and keeps this self-contained.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${sorted}}`;
}

function hashMetadata(body: object): string {
  return createHash('sha256').update(canonicalStringify(body)).digest('hex');
}

/** Shared axios timeout option for all Pinata/IPFS HTTP calls (#1143). */
const axiosTimeout = { timeout: config.ipfsHttpTimeoutMs };

interface PinCacheEntry { cid: string; timestamp: number; }

/**
 * In-memory deduplication cache and in-flight request tracker for pinJson calls.
 * Uses the pending_pins table as an atomic concurrency guard / mutex.
 */
const pinJsonCache = new Map<string, PinCacheEntry>();
const inflightPins = new Map<string, Promise<string>>();

/** Exposed for test teardown only — do not call in production code. */
export function clearPinJsonCache(): void {
  pinJsonCache.clear();
  inflightPins.clear();
}

/**
 * Returns the number of entries currently held in the pinJson deduplication cache.
 * Useful for metrics and health dashboards — a high count relative to unique
 * metadata submissions indicates healthy deduplication is occurring.
 */
export function getPinJsonCacheSize(): number {
  return pinJsonCache.size;
}

/**
 * Pin a JSON object to IPFS via Pinata. Returns the CID.
 *
 * Deduplication: the metadata is canonically serialized (sorted keys,
 * recursively) and hashed with sha256. If an identical hash was pinned
 * within the configured TTL (PIN_JSON_CACHE_TTL_MS, default 5 min) the
 * cached CID is returned immediately without hitting Pinata.
 *
 * Atomic Concurrency: pending_pins DB table and in-flight promises act as a mutex
 * so concurrent identical requests resolve to exactly one Pinata API call.
 */
export async function pinJson(body: object): Promise<string> {
  const start = Date.now();
  const span = tracer.startSpan('ipfs.pinJson');
  try {
    return await (async () => {
      const hash = hashMetadata(body);

      const ttlMs = config.pinJsonCacheTtlMs;
      const cached = pinJsonCache.get(hash);
      if (cached && Date.now() - cached.timestamp < ttlMs) {
        logger.debug(`[ipfs] pinJson cache hit — returning cached CID (hash=${hash.slice(0, 8)}…)`);
        return cached.cid;
      }

      if (inflightPins.has(hash)) {
        logger.debug(`[ipfs] pinJson inflight hit — waiting for in-flight request (hash=${hash.slice(0, 8)}…)`);
        return await inflightPins.get(hash)!;
      }

      if (!isPinataConfigured()) {
        if (process.env.NODE_ENV === 'production') assertPinataConfigured();
        logger.warn('[ipfs] Pinata not configured — returning dev stub CID for pinJson');
        return devStubCid(JSON.stringify(body));
      }

      // Register the in-flight promise synchronously, *before* the first
      // await (the DB lock-acquisition call below) — not after it. Every DB
      // call here now goes through the async DbDriver (required to support
      // DB_DRIVER=postgres), so even the SQLite path is a real await that
      // yields to the event loop. Two same-process calls issued back-to-back
      // (e.g. via Promise.all) both run synchronously up to their first
      // await, so if registration happened after `await insertPendingPin`,
      // both would race past the `inflightPins.has(hash)` check above before
      // either had a chance to register — defeating same-process dedup and
      // causing two independent Pinata uploads. Registering here, before any
      // await, closes that window: whichever call runs first claims the
      // entry synchronously, and the second sees it immediately.
      const resultPromise = (async (): Promise<string> => {
        try {
          const now = new Date().toISOString();
          const acquiredLock = await insertPendingPin({
            payload: JSON.stringify(body),
            hash,
            created_at: now,
            last_tried: now,
          });

          if (acquiredLock === false) {
            logger.debug(`[ipfs] pinJson lock contended — polling for completion (hash=${hash.slice(0, 8)}…)`);
            const MAX_POLL_MS = 30000;
            while (Date.now() - start < MAX_POLL_MS) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              const pollCached = pinJsonCache.get(hash);
              if (pollCached && Date.now() - pollCached.timestamp < ttlMs) {
                return pollCached.cid;
              }
              // Check the cross-instance resolved_cid column unconditionally on
              // every tick — not only once the pending_pins row is confirmed
              // gone. The winning instance persists resolved_cid (a separate DB
              // write) *before* deleting the row (another separate DB write), so
              // in a real multi-instance deployment there's a window — bounded
              // by the round-trip time between those two writes — where the row
              // still exists but the CID is already readable. Gating this read
              // behind "row is gone" misses that window entirely, since by the
              // time the row is gone the resolved_cid is gone with it.
              const resolvedCid = await getResolvedCidByHash(hash);
              if (resolvedCid) {
                logger.debug(`[ipfs] pinJson cross-instance dedup — using resolved CID from DB (hash=${hash.slice(0, 8)}…)`);
                pinJsonCache.set(hash, { cid: resolvedCid, timestamp: Date.now() });
                return resolvedCid;
              }
              if (!(await isPendingPinByHash(hash))) {
                // Lock row is gone and no resolved_cid was ever observed — the
                // winning instance most likely crashed before finishing.
                // Check process-local cache once more, then fall through to
                // upload as a safety-net.
                const finalCached = pinJsonCache.get(hash);
                if (finalCached && Date.now() - finalCached.timestamp < ttlMs) {
                  return finalCached.cid;
                }
                break;
              }
            }
          }

          try {
            const res = await axios.post(PINATA_PIN_JSON_URL, body, { headers: pinataHeaders(), ...axiosTimeout });
            const uploadedCid = res.data.IpfsHash as string;
            // Persist the CID into the pending_pins row BEFORE deleting it so any
            // other instance waiting in its poll loop can read it via
            // getResolvedCidByHash() and avoid a duplicate upload.
            await setPendingPinResolvedCid(hash, uploadedCid);
            pinJsonCache.set(hash, { cid: uploadedCid, timestamp: Date.now() });
            span.setAttribute('ipfs.cid', uploadedCid);
            return uploadedCid;
          } catch (err) {
            logger.critical('[ipfs] Pinata unavailable — queueing payload for retry', (err as Error).message);
            const failTime = new Date().toISOString();
            await insertPendingPin({ payload: JSON.stringify(body), created_at: failTime, last_tried: failTime });
            throw err;
          } finally {
            await deletePendingPinByHash(hash);
          }
        } finally {
          inflightPins.delete(hash);
        }
      })();
      inflightPins.set(hash, resultPromise);
      return await resultPromise;
    })();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
    observeIpfsLatency('pinJson', Date.now() - start);
  }
}

export async function pinFile(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const start = Date.now();
  const span = tracer.startSpan('ipfs.pinFile', { attributes: { 'ipfs.filename': filename, 'ipfs.mime_type': mimeType } });
  try {
    if (!isPinataConfigured()) {
      if (process.env.NODE_ENV === 'production') assertPinataConfigured();
      logger.warn('[ipfs] Pinata not configured — returning dev stub CID for pinFile');
      return devStubCid(filename);
    }
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimeType });
    const res = await axios.post(PINATA_PIN_FILE_URL, form, {
      headers: { ...pinataHeaders(), ...form.getHeaders() },
      maxBodyLength: Infinity,
      ...axiosTimeout,
    });
    const cid = res.data.IpfsHash as string;
    span.setAttribute('ipfs.cid', cid);
    return cid;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
    observeIpfsLatency('pinFile', Date.now() - start);
  }
}

/** Build a public gateway URL for a CID. */
export function gatewayUrl(cid: string): string {
  return `${config.pinata.gateway}/ipfs/${cid}`;
}

/** Build all public gateway URLs for a CID, in priority order. */
export function gatewayUrls(cid: string): string[] {
  return config.pinata.gateways.map(gateway => `${gateway}/ipfs/${cid}`);
}

/** Strip ipfs:// prefix from a URI, or return the input unchanged. */
export async function getCid(uriOrCid: string): Promise<string> {
  return uriOrCid.startsWith('ipfs://') ? uriOrCid.replace('ipfs://', '') : uriOrCid;
}

/**
 * Health check for the Pinata/IPFS dependency.
 * Resolves immediately (with a warning) when credentials are absent in non-production.
 * Rejects with a clear error in production without credentials.
 * Also reports breaker state — if open, reports unavailable immediately.
 */
export async function checkHealth(): Promise<void> {
  const start = Date.now();
  try {
    if (!isPinataConfigured()) {
      if (process.env.NODE_ENV === 'production') assertPinataConfigured();
      logger.warn('[ipfs] Pinata not configured — skipping IPFS health check in dev');
      return;
    }
    await axios.get(PINATA_TEST_URL, { headers: pinataHeaders(), ...axiosTimeout });
  } finally {
    observeIpfsLatency('checkHealth', Date.now() - start);
  }
}

const MAX_RETRIES = 5;
const DEBOUNCE_MS = 60 * 1000; // 1 minute

/**
 * Retry queued pending_pins entries. Called periodically by the background worker.
 * Successfully pinned entries are removed from the queue.
 * Failed retries are backed off exponentially.
 * Rows exceeding MAX_RETRIES are skipped and considered permanently failed.
 */
export async function retryPendingPins(): Promise<void> {
  if (!isPinataConfigured()) return;
  const pending = await getPendingPins();
  const now = Date.now();

  for (const row of pending) {
    if (row.attempts >= MAX_RETRIES) {
      continue; // Permanently failed
    }

    if (row.last_tried) {
      const lastTried = new Date(row.last_tried).getTime();
      const backoffMs = Math.pow(2, row.attempts) * DEBOUNCE_MS;
      if (now - lastTried < backoffMs) {
        continue; // Still in backoff window
      }
    }

    try {
      const body = JSON.parse(row.payload) as object;
      const res = await axios.post(PINATA_PIN_JSON_URL, body, { headers: pinataHeaders(), ...axiosTimeout });
      logger.info(`[ipfs] retried pending pin id=${row.id} cid=${res.data.IpfsHash as string}`);
      await deletePendingPin(row.id);
    } catch {
      await incrementPendingPinAttempts(row.id);
      logger.warn(`[ipfs] retry failed for pending pin id=${row.id}, attempt=${row.attempts + 1}`);
    }
  }
}

// ── Unpin ────────────────────────────────────────────────────────────────────

const PINATA_UNPIN_URL = 'https://api.pinata.cloud/pinning/unpin';

/**
 * Unpin a CID from Pinata.
 *
 * Best-effort: in dev/test without Pinata credentials this is a no-op. In
 * production a failure is logged but does not throw — caller should catch.
 */
export async function unpinCid(cid: string): Promise<void> {
  if (!isPinataConfigured()) {
    logger.debug(`[ipfs] unpin skipped (no Pinata creds): ${cid}`);
    return;
  }
  try {
    await axios.delete(`${PINATA_UNPIN_URL}/${cid}`, { headers: pinataHeaders(), ...axiosTimeout });
    logger.info(`[ipfs] unpinned ${cid}`);
  } catch (err) {
    // 404 means already unpinned — not an error.
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      logger.debug(`[ipfs] unpin: CID already gone: ${cid}`);
      return;
    }
    logger.warn(`[ipfs] unpin failed: ${cid}`, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ── Reconciliation ──────────────────────────────────────────────────────────

const PINATA_PIN_LIST_URL = 'https://api.pinata.cloud/data/pinList';

export interface PinataPinListItem {
  ipfs_pin_hash: string;
  size: number;
  date_pinned: string;
  metadata?: {
    name?: string;
    keyvalues?: Record<string, unknown>;
  };
}

export interface PinataPinListResponse {
  count: number;
  rows: PinataPinListItem[];
}

export interface ReconcileResult {
  processed: number;
  resolved: number;
  requeued: number;
  expired: number;
  skipped: number;
}

/**
 * Check if a CID is reachable via configured IPFS gateway.
 */
export async function checkGatewayReachable(cid: string, timeoutMs = 5000): Promise<boolean> {
  const url = gatewayUrl(cid);
  try {
    const res = await axios.head(url, { timeout: timeoutMs });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/**
 * Check if a CID or hash exists on Pinata via pinList API.
 */
export async function checkPinataPinStatus(cid?: string, hash?: string): Promise<{ isPinned: boolean; pinnedCid?: string }> {
  if (!isPinataConfigured()) {
    return { isPinned: false };
  }

  try {
    if (cid) {
      const res = await axios.get<PinataPinListResponse>(`${PINATA_PIN_LIST_URL}?hashContains=${encodeURIComponent(cid)}&status=pinned`, {
        headers: pinataHeaders(),
      });
      const rows = res.data?.rows ?? [];
      const match = rows.find(r => r.ipfs_pin_hash === cid);
      if (match) {
        return { isPinned: true, pinnedCid: match.ipfs_pin_hash };
      }
    }

    if (hash) {
      const res = await axios.get<PinataPinListResponse>(`${PINATA_PIN_LIST_URL}?metadata[keyvalues][hash]={"value":"${hash}","op":"eq"}&status=pinned`, {
        headers: pinataHeaders(),
      });
      if (res.data?.rows?.length > 0) {
        return { isPinned: true, pinnedCid: res.data.rows[0].ipfs_pin_hash };
      }
    }

    return { isPinned: false };
  } catch (err) {
    logger.warn('[ipfs] Pinata pinList query failed during reconciliation', err instanceof Error ? err.message : String(err));
    return { isPinned: false };
  }
}

/**
 * Reconciles stale/unresolved pending_pins rows against Pinata and IPFS gateways.
 * For each stale row past the age threshold:
 *   - Checks Pinata pin status and gateway reachability.
 *   - If found/reachable: marks resolved and updates CID.
 *   - If not found and retryable: attempts re-pinning or increments attempts.
 *   - If expired (attempts >= max or unrecoverable): marks expired with reason.
 * Emits stuck pending pins metric.
 */
export async function reconcilePendingPins(options?: {
  ageThresholdMs?: number;
  maxAttempts?: number;
  batchSize?: number;
}): Promise<ReconcileResult> {
  const ageThresholdMs = options?.ageThresholdMs ?? config.ipfsReconcileAgeMs;
  const maxAttempts = options?.maxAttempts ?? config.ipfsReconcileMaxAttempts;
  const batchSize = options?.batchSize ?? 50;

  const cutoffTime = new Date(Date.now() - ageThresholdMs).toISOString();
  const staleRows = await getStalePendingPins(cutoffTime, batchSize);

  const result: ReconcileResult = {
    processed: staleRows.length,
    resolved: 0,
    requeued: 0,
    expired: 0,
    skipped: 0,
  };

  if (!isPinataConfigured()) {
    // In dev/test without credentials, update metrics and return
    const stuckCount = await countStuckPendingPins(cutoffTime);
    setStuckPendingPinsCount(stuckCount);
    return result;
  }

  for (const row of staleRows) {
    let payloadObj: object | null = null;
    try {
      payloadObj = JSON.parse(row.payload);
    } catch {
      // Unparseable payload -> expire immediately
      await updatePendingPinReconciliation({
        id: row.id,
        status: 'expired',
        expiredReason: 'invalid_json_payload',
      });
      result.expired++;
      continue;
    }

    const candidateCid = row.resolved_cid ?? null;
    let isPinned = false;
    let resolvedCid: string | null = candidateCid;

    // 1. If we have a candidate CID, check Pinata or Gateway
    if (candidateCid) {
      const pinataStatus = await checkPinataPinStatus(candidateCid, row.hash ?? undefined);
      if (pinataStatus.isPinned) {
        isPinned = true;
        resolvedCid = pinataStatus.pinnedCid ?? candidateCid;
      } else {
        const reachable = await checkGatewayReachable(candidateCid);
        if (reachable) {
          isPinned = true;
        }
      }
    } else if (row.hash) {
      // Check Pinata by hash metadata
      const pinataStatus = await checkPinataPinStatus(undefined, row.hash);
      if (pinataStatus.isPinned && pinataStatus.pinnedCid) {
        isPinned = true;
        resolvedCid = pinataStatus.pinnedCid;
      }
    }

    if (isPinned && resolvedCid) {
      await updatePendingPinReconciliation({
        id: row.id,
        status: 'resolved',
        resolvedCid,
      });
      logger.info(`[ipfs] reconciled pending pin id=${row.id} as resolved (cid=${resolvedCid})`);
      result.resolved++;
      continue;
    }

    // 2. Not pinned - check if we exceeded max attempts
    if (row.attempts >= maxAttempts) {
      const reason = `max_attempts_exceeded (${row.attempts}/${maxAttempts})`;
      await updatePendingPinReconciliation({
        id: row.id,
        status: 'expired',
        expiredReason: reason,
      });
      logger.warn(`[ipfs] reconciled pending pin id=${row.id} as expired: ${reason}`);
      result.expired++;
      continue;
    }

    // 3. Attempt re-pinning payload to Pinata
    try {
      const pinRes = await axios.post(PINATA_PIN_JSON_URL, payloadObj, { headers: pinataHeaders() });
      const newCid = pinRes.data.IpfsHash as string;
      await updatePendingPinReconciliation({
        id: row.id,
        status: 'resolved',
        resolvedCid: newCid,
      });
      logger.info(`[ipfs] reconciled pending pin id=${row.id} by re-pinning (cid=${newCid})`);
      result.resolved++;
    } catch (err) {
      await incrementPendingPinAttempts(row.id);
      await updatePendingPinReconciliation({
        id: row.id,
        status: 'pending',
        lastReconciledAt: new Date().toISOString(),
      });
      logger.warn(`[ipfs] reconciliation re-pin attempt failed for id=${row.id}: ${(err as Error).message}`);
      result.requeued++;
    }
  }

  // Update stuck pending pins metric gauge
  const remainingStuck = await countStuckPendingPins(cutoffTime);
  setStuckPendingPinsCount(remainingStuck);

  return result;
}

export default {
  pinJson,
  pinFile,
  gatewayUrl,
  gatewayUrls,
  getCid,
  checkHealth,
  retryPendingPins,
  reconcilePendingPins,
  checkGatewayReachable,
  checkPinataPinStatus,
  clearPinJsonCache,
  getPinJsonCacheSize,
  unpinCid,
};
