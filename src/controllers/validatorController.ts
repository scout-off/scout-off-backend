import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { logger } from '../utils/logger';
import { pinJson, pinFile } from '../services/ipfs';
import { getPendingMilestones as getPendingMilestonesFromDb, getDb, removePendingMilestone, incrementValidatorApproved, queryEvents, updatePlayerProgress } from '../db';
import { invalidateMilestoneCache } from '../services/cache';
import { recordAudit } from '../utils/audit';
import { isValidMetadataUri, URI_VALIDATION_ERROR } from '../utils/uriValidator';

// Re-exported so callers/tests can import the metadata_uri validator directly
// from validatorController without reaching into utils/uriValidator.
export { isValidMetadataUri };
import { tierForApprovedMilestones } from '../services/tierPromotion';
import config from '../config';

/** MIME types accepted as evidence. */
const ALLOWED_CONTENT_TYPE_PREFIXES = ['video/', 'image/', 'application/pdf', 'text/plain'];

function isAllowedContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Download an HTTPS URL, validate its Content-Type and size, then pin the
 * file buffer to IPFS via Pinata.  Returns the resulting CID.
 *
 * Throws structured errors that the route handler converts to HTTP responses:
 *   - { status: 422, message } — unsupported content type
 *   - { status: 413, message } — file exceeds EVIDENCE_MAX_BYTES
 */
export async function downloadAndPinEvidence(url: string): Promise<string> {
  // In non-production without Pinata credentials the IPFS service returns stub
  // CIDs without hitting any network.  Mirror that behaviour here so local dev
  // and test environments work without real external HTTP.
  if (!config.pinata.apiKey && !config.pinata.secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('IPFS service unavailable: PINATA_API_KEY and PINATA_SECRET must be set in production');
    }
    logger.warn('[validator] Pinata not configured — returning dev stub CID for HTTPS evidence download');
    const stubFilename = path.basename(new URL(url).pathname) || 'evidence';
    return pinFile(Buffer.alloc(0), stubFilename, 'application/octet-stream');
  }

  // Step 1: HEAD request to check Content-Type and Content-Length before downloading.
  let contentType: string;
  let contentLength: number | null = null;

  try {
    const head = await axios.head(url, { timeout: 10000 });
    contentType = (head.headers['content-type'] as string | undefined) ?? '';
    const clHeader = head.headers['content-length'];
    if (clHeader) {
      contentLength = parseInt(clHeader, 10);
    }
  } catch {
    // Some servers reject HEAD — fall through to GET with streaming
    contentType = '';
    contentLength = null;
  }

  // Validate content type from HEAD (if available).
  if (contentType && !isAllowedContentType(contentType)) {
    const err = new Error(`Unsupported evidence content type: ${contentType}. Accepted: video/*, image/*, application/pdf, text/plain`) as Error & { status: number };
    err.status = 422;
    throw err;
  }

  // Reject based on Content-Length from HEAD if already over the limit.
  if (contentLength !== null && contentLength > config.evidenceMaxBytes) {
    const err = new Error(`Evidence file too large: ${contentLength} bytes exceeds the ${config.evidenceMaxBytes}-byte limit`) as Error & { status: number };
    err.status = 413;
    throw err;
  }

  // Step 2: Download the content as a buffer.
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: config.evidenceMaxBytes,
    maxBodyLength: config.evidenceMaxBytes,
  });

  const downloadedType = (response.headers['content-type'] as string | undefined) ?? contentType;
  const buffer = Buffer.from(response.data);

  // Validate content type from GET response (may differ from HEAD).
  if (downloadedType && !isAllowedContentType(downloadedType)) {
    const err = new Error(`Unsupported evidence content type: ${downloadedType}. Accepted: video/*, image/*, application/pdf, text/plain`) as Error & { status: number };
    err.status = 422;
    throw err;
  }

  // Validate actual downloaded size.
  if (buffer.length > config.evidenceMaxBytes) {
    const err = new Error(`Evidence file too large: ${buffer.length} bytes exceeds the ${config.evidenceMaxBytes}-byte limit`) as Error & { status: number };
    err.status = 413;
    throw err;
  }

  const filename = path.basename(new URL(url).pathname) || 'evidence';
  const mimeType = downloadedType.split(';')[0].trim() || 'application/octet-stream';

  return pinFile(buffer, filename, mimeType);
}

export const milestoneSchema = z.object({
  playerId: z.string().min(1),
  milestoneType: z.enum(['identity', 'performance', 'trial_offer']),
  evidenceUri: z.string().min(1).refine(isValidMetadataUri, URI_VALIDATION_ERROR),
});

export const pendingQuerySchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  playerId: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
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
        evidenceCid = await downloadAndPinEvidence(evidenceUri);
      } catch (downloadErr) {
        const err = downloadErr as Error & { status?: number };
        if (err.status === 422) {
          res.status(422).json({ success: false, error: err.message });
          return;
        }
        if (err.status === 413) {
          res.status(413).json({ success: false, error: err.message });
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

    recordAudit(validatorWallet, 'milestone_submitted', { playerId, milestoneType, evidenceCid }, `correlationId=${correlationId}`);

    res.status(201).json({ success: true, data: { evidenceCid } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/validators/milestones/pending or /api/validators/:wallet/milestones/pending */
export async function getPendingMilestones(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { region, position, playerId, page, pageSize } = pendingQuerySchema.parse(req.query);
    const validatorWallet = req.params.wallet || req.account;
    const { data, total } = getPendingMilestonesFromDb({
      validatorWallet: validatorWallet,
      region,
      position,
      playerId,
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
    recordAudit(
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

    res.json({ 
      success: true, 
      data: milestones, 
      total, 
      page: page || 1, 
      pageSize: pageSize || 20 
    });
  } catch (err) {
    next(err);
  }
}

export const bulkApproveSchema = z.object({
  milestoneIds: z.array(z.string()).min(1),
});

export async function approveBulkMilestones(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { milestoneIds } = bulkApproveSchema.parse(req.body);
    const validatorWallet = req.account ?? 'unknown';
    const correlationId = getCorrelationId(req);
    
    const results = [];
    const db = getDb();
    
    const uniqueIds = Array.from(new Set(milestoneIds));

    for (const milestoneId of uniqueIds) {
      try {
        const row = db.prepare('SELECT * FROM pending_milestones WHERE milestone_id = ?').get(milestoneId) as any;
        if (!row) {
          results.push({ milestoneId, status: 'invalid', error: 'Not found or already processed' });
          continue;
        }
        
        if (row.validator_wallet !== validatorWallet) {
          results.push({ milestoneId, status: 'unauthorized', error: 'Not assigned to this validator' });
          continue;
        }

        const playerId = row.player_id;
        
        removePendingMilestone(milestoneId);
        incrementValidatorApproved(validatorWallet);
        
        const onChainApprovedCount = queryEvents('milestone_approved').filter(
          (e) => e.payload.player_id === playerId
        ).length;
        
        // Count this new off-chain approval + existing ones
        updatePlayerProgress(playerId, tierForApprovedMilestones(onChainApprovedCount + 1));
        
        await invalidateMilestoneCache(playerId);
        
        recordAudit(
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