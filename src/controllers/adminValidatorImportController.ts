import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { insertValidator, getValidatorByWallet } from '../services/indexer';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { logAuditEvent } from '../services/audit';
import { registerValidatorOnChain, ValidatorActionError } from '../services/stellar';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { proposeAction } from '../services/adminMultiSig';
import { withConcurrencyLimit } from '../utils/concurrency';

// ─── Validator import types ───────────────────────────────────────────────────

export interface ImportValidatorEntry {
  wallet: string;
  label?: string;
  region?: string;
}

export type ImportResultStatus = 'registered' | 'duplicate' | 'invalid' | 'pending_approval';

export interface ImportValidatorResult {
  wallet: string;
  status: ImportResultStatus;
  reason?: string;
  label?: string;
  region?: string;
}

/**
 * Parse a CSV text body into an array of ImportValidatorEntry objects.
 *
 * Supported formats:
 *   - Single-column:  wallet
 *   - Two-column:     wallet,label
 *   - Three-column:   wallet,label,region
 *
 * Lines beginning with # or empty lines are ignored.
 * A header row whose first token is the literal "wallet" (case-insensitive)
 * is silently skipped.
 */
export function parseCsvBody(text: string): ImportValidatorEntry[] {
  const entries: ImportValidatorEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    // Skip header row
    if (cols[0].toLowerCase() === 'wallet') continue;
    const [wallet, label, region] = cols;
    entries.push({ wallet: wallet ?? '', label: label || undefined, region: region || undefined });
  }
  return entries;
}

/** Envelope schema for the JSON body variant of POST /api/admin/validators/import. */
export const importValidatorsBodySchema = z.object({
  validators: z.array(z.unknown()).min(1),
}).strict();

/**
 * Process a batch of ImportValidatorEntry items and return per-entry results.
 *
 * Multi-sig gating:
 *   - When ADMIN_THRESHOLD > 1, queues each valid row as a pending admin action
 *     instead of registering immediately on-chain. Per-row status is "pending_approval".
 *   - When ADMIN_THRESHOLD <= 1, calls registerValidatorOnChain() for each valid row
 *     with a concurrency limit of 5 simultaneous calls.
 *
 * Database mutation ordering:
 *   - DB insert (insertValidator) happens ONLY AFTER on-chain confirmation succeeds
 *   - Prevents orphaned rows that don't reflect contract state
 *   - Uses allSettled semantics so one failure doesn't abort the batch
 *
 * Duplicate detection:
 *   - A validator that already exists AND is not revoked → "duplicate"
 *   - A validator that was previously revoked is re-registered (same as single-
 *     registration, which also does INSERT OR REPLACE)
 */
export async function processBatch(
  entries: ImportValidatorEntry[],
  adminWallet: string,
): Promise<ImportValidatorResult[]> {
  const results: ImportValidatorResult[] = [];
  const seenInBatch = new Set<string>();

  // Split entries into two phases: validation, then registration/queueing
  const validatedEntries: Array<{
    entry: ImportValidatorEntry;
    index: number;
  }> = [];

  // Phase 1: Validation (fast path, synchronous)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { wallet, label, region } = entry;

    // Check if wallet address is valid
    if (!isValidStellarAddress(wallet)) {
      logger.warn(`[admin] import_validator rejected — invalid address | admin=${adminWallet} target=${wallet}`);
      results[i] = { wallet, status: 'invalid', reason: 'invalid Stellar address', label, region };
      continue;
    }

    // Check intra-batch duplicate
    if (seenInBatch.has(wallet)) {
      results[i] = { wallet, status: 'duplicate', reason: 'duplicate within batch', label, region };
      continue;
    }

    // Check DB for already-active (non-revoked) registration
    const existing = await getValidatorByWallet(wallet);
    if (existing && existing.revoked_at === null) {
      results[i] = { wallet, status: 'duplicate', reason: 'already registered', label, region };
      seenInBatch.add(wallet);
      continue;
    }

    // Passes validation
    seenInBatch.add(wallet);
    validatedEntries.push({ entry, index: i });
  }

  // Phase 2: Registration/Queueing (async, with multi-sig gating and concurrency limit)
  if (validatedEntries.length > 0) {
    if (config.adminThreshold > 1) {
      // Multi-sig: queue each validated entry as a pending admin action
      for (const { entry, index } of validatedEntries) {
        const { wallet, label, region } = entry;
        try {
          const proposal = await proposeAction(
            'bulk_validator_import',
            { wallet, label: label || undefined, region: region || undefined },
            adminWallet,
          );
          // Status depends on whether threshold was already met (immediate) or pending
          const status = proposal.status === 'immediate' ? 'registered' : 'pending_approval';
          logger.info(
            `[admin] action=import_register_validator_multisig admin=${adminWallet} target=${wallet} status=${status}`,
          );
          results[index] = {
            wallet,
            status: status as ImportResultStatus,
            label,
            region,
          };
        } catch (err) {
          logger.error(`[admin] import_validator_multisig error | admin=${adminWallet} target=${wallet} error=${err}`);
          results[index] = {
            wallet,
            status: 'invalid',
            reason: `Multi-sig queuing failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            label,
            region,
          };
        }
      }
    } else {
      // Single-admin: call registerValidatorOnChain with concurrency limit of 5
      const tasks = validatedEntries.map(({ entry, index }) => {
        return async () => {
          const { wallet, label, region } = entry;
          try {
            logger.info(`[admin] action=import_register_validator admin=${adminWallet} target=${wallet}`);
            const result = await registerValidatorOnChain(wallet);

            // DB insert ONLY after on-chain confirmation succeeds
            await insertValidator(wallet, result.transactionId);

            logger.info(
              `[admin] action=import_register_validator_success admin=${adminWallet} target=${wallet} txid=${result.transactionId}`,
            );
            results[index] = {
              wallet,
              status: 'registered',
              label,
              region,
            };
          } catch (err) {
            logger.error(
              `[admin] import_validator error | admin=${adminWallet} target=${wallet} error=${err instanceof Error ? err.message : 'unknown'}`,
            );
            // Do NOT insert into DB if on-chain call fails
            results[index] = {
              wallet,
              status: 'invalid',
              reason:
                err instanceof ValidatorActionError
                  ? `On-chain registration failed: ${err.code}`
                  : `On-chain registration failed: ${err instanceof Error ? err.message : 'unknown error'}`,
              label,
              region,
            };
          }
        };
      });

      // Execute with concurrency limit of 5
      await withConcurrencyLimit(tasks, 5);

      // Results are already populated by each task
    }
  }

  return results;
}

/**
 * POST /api/admin/validators/import
 *
 * Accepts either:
 *   - JSON body:  { validators: [{ wallet, label?, region? }, …] }
 *   - CSV body:   Content-Type: text/csv  with rows: wallet[,label[,region]]
 *
 * Returns a per-entry result summary so partial failures don't block the whole
 * batch. Invalid addresses and already-registered (non-revoked) validators are
 * skipped cleanly rather than erroring the request.
 *
 * @response 200 { success: true, data: { results, summary: { total, registered, duplicates, invalid } } }
 * @response 400 { success: false, error: string } - Unparseable body or no entries
 * @auth Bearer (admin role required)
 */
export async function importValidators(req: Request, res: Response, next: NextFunction): Promise<void> {
  const adminWallet = req.account ?? 'unknown';
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();

  let entries: ImportValidatorEntry[];

  if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
    // ── CSV path ──────────────────────────────────────────────────────────
    const rawBody = req.body as string;
    if (typeof rawBody !== 'string' || !rawBody.trim()) {
      res.status(400).json({ success: false, error: 'CSV body is empty', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    entries = parseCsvBody(rawBody);
  } else {
    // ── JSON path (default) ───────────────────────────────────────────────
    const jsonBody = req.body as { validators?: unknown };
    if (!jsonBody || !Array.isArray(jsonBody.validators)) {
      res.status(400).json({
        success: false,
        error: 'Request body must contain a "validators" array or use Content-Type: text/csv',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    // Coerce each item — we accept { wallet } at minimum; label/region are optional strings
    entries = (jsonBody.validators as Array<unknown>).map((item) => {
      if (typeof item === 'string') return { wallet: item };
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        return {
          wallet: typeof obj['wallet'] === 'string' ? obj['wallet'] : '',
          label: typeof obj['label'] === 'string' ? obj['label'] : undefined,
          region: typeof obj['region'] === 'string' ? obj['region'] : undefined,
        };
      }
      return { wallet: '' };
    });
  }

  if (entries.length === 0) {
    res.status(400).json({ success: false, error: 'No validator entries found in request', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  const results = await processBatch(entries, adminWallet);

  const registered = results.filter((r) => r.status === 'registered').length;
  const pending = results.filter((r) => r.status === 'pending_approval').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const invalid = results.filter((r) => r.status === 'invalid').length;

  logger.info(
    `[admin] action=import_validators admin=${adminWallet} total=${results.length} registered=${registered} pending=${pending} duplicates=${duplicates} invalid=${invalid}`,
  );

  await logAuditEvent({
    action: 'bulk_validator_import',
    adminWallet,
    queryParams: {
      total: results.length,
      registered: registered + pending,
      duplicates,
      invalid,
    },
    timestamp: new Date().toISOString(),
  }).catch(() => {});

  res.status(200).json({
    success: true,
    data: {
      results,
      summary: {
        total: results.length,
        registered: registered + pending,
        duplicates,
        invalid,
      },
    },
  });
}
