import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { pinJson, pinFile, isPinataConfigured } from '../services/ipfs';
import { getPendingMilestones as getPendingMilestonesFromDb, getDriver, removePendingMilestone, incrementValidatorApproved, queryEvents, getEventsCount, updatePlayerProgress, getValidatorStats } from '../db';
import { invalidateMilestoneCache } from '../services/cache';
import { recordAudit } from '../utils/audit';
import { isValidMetadataUri, URI_VALIDATION_ERROR } from '../utils/uriValidator';
import { checkWalletOwnership } from '../middleware/requireOwner';

// Re-exported so callers/tests can import the metadata_uri validator directly
// from validatorController without reaching into utils/uriValidator.
export { isValidMetadataUri };
import { tierForApprovedMilestones } from '../services/tierPromotion';
import config from '../config';
import { safeFetch, SafeFetchError, SafeFetchResult, sniffContentType } from '../utils/safeFetch';
import { recordEvidenceRejection } from '../middleware/metrics';

/** MIME types accepted as evidence. */
const ALLOWED_CONTENT_TYPE_PREFIXES = ['video/', 'image/', 'application/pdf', 'text/plain'];

const BUDGET_WINDOW_MS = 60 * 60 * 1000;
const evidenceBudget = new Map<string, { windowStart: number; bytes: number }>();

function budgetEntry(key: string): { windowStart: number; bytes: number } {
  const now = Date.now();
  let entry = evidenceBudget.get(key);
  if (!entry || now - entry.windowStart >= BUDGET_WINDOW_MS) {
    entry = { windowStart: now, bytes: 0 };
    evidenceBudget.set(key, entry);
  }
  return entry;
}

function hasEvidenceBudget(key: string): boolean {
  return budgetEntry(key).bytes < config.evidenceValidatorBytesPerHour;
}

function consumeEvidenceBudget(key: string, bytes: number): void {
  budgetEntry(key).bytes += bytes;
}

function isAllowedContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Download an HTTPS URL, validate its content and size, then pin the
 * file buffer to IPFS via Pinata.  Returns the resulting CID.
 *
 * Throws structured errors that the route handler converts to HTTP responses:
 *   - { status: 422, message } — unsupported content type
 *   - { status: 413, message } — file exceeds EVIDENCE_MAX_BYTES
 *   - { status: 422, message } — URL resolves to a private/metadata address,
 *     redirects somewhere disallowed, or content bytes don't match the type
 *   - { status: 429, message } — per-validator hourly byte budget exhausted
 *
 * The download goes through the SSRF-safe fetcher in utils/safeFetch.ts.
 */
export async function downloadAndPinEvidence(url: string, budgetKey = 'unknown'): Promise<string> {
  // In local development/test, preserve offline evidence submission without
  // pretending an empty file was pinned. Deployments must never persist a
  // synthetic evidence CID.
  if (!isPinataConfigured()) {
    if (config.nodeEnv === 'development' || config.nodeEnv === 'test') {
      const stubFilename = path.basename(new URL(url).pathname) || 'evidence';
      logger.warn('[validator] Pinata not configured — returning local evidence stub CID');
      return pinJson({ evidenceUri: url, filename: stubFilename });
    }
    throw new Error('IPFS service unavailable: PINATA_API_KEY and PINATA_SECRET must be set in staging and production');
  }

  // Per-validator byte budget (sliding hour window).
  if (!hasEvidenceBudget(budgetKey)) {
    recordEvidenceRejection('budget_exceeded');
    const err = new Error('Evidence download budget exceeded for this validator; try again later') as Error & { status: number };
    err.status = 429;
    throw err;
  }

  let fetched: SafeFetchResult;
  try {
    fetched = await safeFetch(url, { maxBytes: config.evidenceMaxBytes, timeoutMs: 30000, maxRedirects: 3 });
  } catch (fetchErr) {
    if (fetchErr instanceof SafeFetchError) {
      recordEvidenceRejection(fetchErr.reason);
      const err = new Error(fetchErr.message) as Error & { status: number };
      err.status = fetchErr.status;
      throw err;
    }
    throw fetchErr;
  }
  const { buffer, declaredContentType } = fetched;
  consumeEvidenceBudget(budgetKey, buffer.length);

  // Trust magic bytes, not the remote Content-Type.
  const declared = declaredContentType.split(';')[0].trim().toLowerCase();
  const sniffed = sniffContentType(buffer);
  if (declared && declared !== 'application/octet-stream' && !isAllowedContentType(declared)) {
    recordEvidenceRejection('unsupported_content');
    const err = new Error(`Unsupported evidence content type: ${declared}. Accepted: video/*, image/*, application/pdf, text/plain`) as Error & { status: number };
    err.status = 422;
    throw err;
  }
  if (!sniffed || (declared && declared !== 'application/octet-stream' && declared.split('/')[0] !== sniffed.split('/')[0])) {
    recordEvidenceRejection('unsupported_content');
    const err = new Error(`Evidence content does not match an accepted type (declared ${declared || 'none'}, detected ${sniffed ?? 'unknown'}). Accepted: video/*, image/*, application/pdf, text/plain`) as Error & { status: number };
    err.status = 422;
    throw err;
  }

  const filename = path.basename(new URL(fetched.finalUrl).pathname) || 'evidence';
  return pinFile(buffer, filename, sniffed);
}

export const milestoneSchema = z.object({
  playerId: z.string().min(1),
  milestoneType: z.enum(['identity', 'performance', 'trial_offer']),
  evidenceUri: z.string().min(1).refine(isValidMetadataUri, URI_VALIDATION_ERROR),
  // Optional free-text fields (#29). Accepted and persisted with the audit
  // record; not required for submission.
  notes: z.string().max(2000).optional(),
  validatorComment: z.string().max(2000).optional(),
}).strict();

export const MAX_PAGE_SIZE = 100;

export const pendingQuerySchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  playerId: z.string().optional(),
  // Inclusive bounds on submitted_at (Unix seconds), issue #1135.
  submittedAfter: z.coerce.number().int().optional(),
  submittedBefore: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).optional(),
  // Literal 100 (== MAX_PAGE_SIZE) so the OpenAPI generator's static analysis
  // can emit `maximum: 100`.
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** POST /api/validators/milestone */
function getCorrelationId(req: Request): string {
  return String(req.headers?.['x-correlation-id'] ?? req.headers?.['correlation-id'] ?? 'none');
}

export async function submitMilestoneEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const { playerId, milestoneType, evidenceUri } = milestoneSchema.parse(req.body);

    let evidenceCid: string;

    if (evidenceUri.startsWith('https://')) {
      // Download the remote file, validate its content type and size, then pin to IPFS.
      try {
        evidenceCid = await downloadAndPinEvidence(evidenceUri, req.account ?? 'unknown');
      } catch (downloadErr) {
        const err = downloadErr as Error & { status?: number };
        if (err.status === 422) {
          res.status(422).json({ success: false, error: err.message });
          return;
        }
        if (err.status === 413 || err.status === 429 || err.status === 502 || err.status === 504) {
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        throw err;
      }
    } else {
      // evidenceUri is an ipfs:// URI — strip the prefix to get the bare CID and
      // record the metadata envelope on IPFS so we have a stable audit record.
      const cid = evidenceUri.startsWith('ipfs://') ? evidenceUri.slice('ipfs://'.length) : evidenceUri;
      evidenceCid = await pinJson({ playerId, milestoneType, evidenceUri: cid });
    }
    // Invalidate milestone + player cache so updated progress tier is reflected
    await invalidateMilestoneCache(playerId);

    const validatorWallet = req.account ?? 'unknown';
    const correlationId = getCorrelationId(req);
    logger.info(
      `[validator] action=submit_milestone validator=${validatorWallet} playerId=${playerId} milestoneType=${milestoneType} evidenceCid=${evidenceCid} correlationId=${correlationId}`
    );

    await recordAudit(validatorWallet, 'milestone_submitted', { playerId, milestoneType, evidenceCid }, `correlationId=${correlationId}`);

    res.status(201).json({ success: true, data: { evidenceCid } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/validators/milestones/pending or /api/validators/:wallet/milestones/pending */
export async function getPendingMilestones(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const { region, position, playerId, submittedAfter, submittedBefore, page, pageSize } =
    pendingQuerySchema.parse(req.query);
  const validatorWallet = req.params.wallet as string || req.account;
  const { data, total } = await getPendingMilestonesFromDb({
    validatorWallet: validatorWallet,
    region,
    position,
    playerId,
    submittedAfter,
    submittedBefore,
    page,
    pageSize,
  });

  // Transform to the desired output format
  const milestones = data.map((m) => ({
    milestoneId: m.milestone_id,
    playerId: m.player_id,
    milestoneType: m.milestone_type,
    evidenceUri: m.evidence_uri,
    submittedAt: m.submitted_at,
  }));

  const currentValidatorWallet = req.account ?? 'unknown';
  await recordAudit(
    currentValidatorWallet,
    'pending_milestones_viewed', 
    { 
      region: region ?? null, 
      position: position ?? null,
      validatorWallet,
      pendingCount: total,
    }, 
    'pending milestones viewed'
  );

  const effectivePage = page || 1;
  const effectivePageSize = pageSize || 20;
  res.json({
    success: true,
    data: milestones,
    total,
    page: effectivePage,
    pageSize: effectivePageSize,
    hasMore: effectivePage * effectivePageSize < total,
  });
}

export const bulkApproveSchema = z.object({
  milestoneIds: z.array(z.string()).min(1),
}).strict();

export async function approveBulkMilestones(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const { milestoneIds } = bulkApproveSchema.parse(req.body);
    const validatorWallet = req.account ?? 'unknown';
    const correlationId = getCorrelationId(req);
    
    const results = [];
    const driver = getDriver();

    const uniqueIds = Array.from(new Set(milestoneIds));

    for (const milestoneId of uniqueIds) {
      try {
        const row = await driver.get<any>('SELECT * FROM pending_milestones WHERE milestone_id = ?', [milestoneId]);
        if (!row) {
          results.push({ milestoneId, status: 'invalid', error: 'Not found or already processed' });
          continue;
        }

        if (row.validator_wallet !== validatorWallet) {
          results.push({ milestoneId, status: 'unauthorized', error: 'Not assigned to this validator' });
          continue;
        }

        const playerId = row.player_id;

        await removePendingMilestone(milestoneId);
        await incrementValidatorApproved(validatorWallet);

        const onChainApprovedCount = getEventsCount('milestone_approved', {
          payloadFilter: { player_id: playerId },
        });

        // Count this new off-chain approval + existing ones
        await updatePlayerProgress(playerId, tierForApprovedMilestones(onChainApprovedCount + 1));

        await invalidateMilestoneCache(playerId);

        await recordAudit(
          validatorWallet,
          'milestone_approved',
          { milestoneId, playerId, bulk: true },
          `correlationId=${correlationId}`
        );
        
        results.push({ milestoneId, status: 'approved' });
      } catch (err) {
        logger.error(`[validator] error approving milestone ${milestoneId}:`, err);
        results.push({ milestoneId, status: 'error', error: String(err) });
      }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
}

/** Maximum recent-activity items returned by the stats endpoint (#1136). */
const RECENT_ACTIVITY_LIMIT = 20;

/** Number of seconds in 30 days, used to filter approvedLast30d. */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * GET /api/validators/:wallet/stats
 *
 * Returns a dashboard summary for the given validator wallet:
 *   - pending:          number of pending milestones currently assigned to this validator
 *   - approvedTotal:    total milestones approved (from validator_stats table)
 *   - rejectedTotal:    total milestones rejected (from validator_stats table)
 *   - approvedLast30d:  approvals recorded in the last 30 days (from indexed events)
 *   - recent:           up to 20 most recent milestone events (submitted/approved/rejected)
 *                       involving this validator, newest first
 *
 * Auth: validators may only query their own wallet; admins can query any wallet.
 */
export async function getValidatorDashboardStats(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { wallet } = req.params as { wallet: string };

    // Enforce ownership: validators see only their own stats; admins may query any wallet.
    if (!checkWalletOwnership(req, res)) return;

    // 1. Count pending milestones for this validator.
    const { total: pending } = await getPendingMilestonesFromDb({
      validatorWallet: wallet,
      pageSize: 1,
      page: 1,
    });

    // 2. Pull approved / rejected totals from the write-optimised stats table.
    const statsRow = await getValidatorStats(wallet);
    const approvedTotal = statsRow?.milestones_approved ?? 0;
    const rejectedTotal = statsRow?.milestones_rejected ?? 0;

    // 3. Derive approvedLast30d from indexed milestone_approved events.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cutoff = nowSeconds - THIRTY_DAYS_SECONDS;

    const approvedLast30d = getEventsCount('milestone_approved', {
      payloadAnyOf: [{ validator: wallet }, { validator_wallet: wallet }],
      createdAfter: cutoff,
    });

    // 4. Build the recent-activity list (bounded to RECENT_ACTIVITY_LIMIT).
    //    Combine submitted, approved, and rejected events for this validator.
    const milestoneEventTypes = [
      'milestone_submitted',
      'milestone_approved',
      'milestone_rejected',
    ] as const;

    const recentActivity = milestoneEventTypes
      .flatMap((type) =>
        queryEvents(type, {
          payloadAnyOf: [{ validator: wallet }, { validator_wallet: wallet }],
        }).map((e) => ({
          type: e.type as string,
          playerId: (e.payload.player_id ?? e.payload.playerId ?? null) as string | null,
          milestoneId: (e.payload.milestone_id ?? e.payload.milestoneId ?? null) as string | null,
          createdAt: e.created_at ?? null,
        })),
      )
      // Sort newest first (nulls treated as 0).
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, RECENT_ACTIVITY_LIMIT);

    res.json({
      success: true,
      data: {
        wallet,
        pending,
        approvedTotal,
        rejectedTotal,
        approvedLast30d,
        recent: recentActivity,
      },
    });
  } catch (err) {
    next(err);
  }
}
