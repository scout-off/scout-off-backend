import { getAllAuditLogRows, AuditLogRow } from '../db';
import { computeChainHash, auditChainContent, GENESIS_HASH } from './hashChain';
import { logger } from './logger';
import config from '../config';

export interface AuditChainVerification {
  valid: boolean;
  /** id of the first row where the chain breaks, or null if the chain is intact. */
  brokenAtId: number | null;
  reason?: string;
  rowsChecked: number;
}

/**
 * A single hash-chain violation found during a full audit walk.
 */
export interface AuditViolation {
  id: number;
  expected_hash: string;
  stored_hash: string;
  audit_event_type: string;
  created_at: string;
}

/**
 * Full audit chain integrity report returned by verifyAuditChainFull().
 */
export interface AuditChainReport {
  status: 'ok' | 'tampered' | 'timeout';
  chain_length: number;
  violations: AuditViolation[];
  rows_checked: number;
}

const BATCH_SIZE = 1000;

/**
 * Walks the entire audit_log table in id ASC order, recomputing each row's
 * expected hash and collecting ALL violations rather than stopping at the
 * first broken row.
 *
 * Rows are processed in logical batches of 1 000 so that the deadline can be
 * checked between batches. After each batch it checks whether the request
 * deadline has been reached; if so it returns early with `status: 'timeout'`
 * and the partial results gathered so far.
 *
 * @param deadlineMs  Unix epoch milliseconds after which the walk should
 *                    abort.  Defaults to (now + requestTimeoutMs - 500) so
 *                    the response always has a small buffer to write itself
 *                    out before the outer request timeout fires.
 */
export async function verifyAuditChainFull(deadlineMs?: number): Promise<AuditChainReport> {
  const deadline = deadlineMs ?? Date.now() + config.requestTimeoutMs - 500;

  // Fetch all rows at once (getAllAuditLogRows does not support limit/offset).
  const allRows: AuditLogRow[] = await getAllAuditLogRows();
  const totalRows = allRows.length;

  const violations: AuditViolation[] = [];
  let expectedPrevHash = GENESIS_HASH;
  let rowsChecked = 0;

  // Process in logical batches so the deadline can be checked periodically
  // without loading a second cursor against the database.
  for (let batchStart = 0; batchStart < totalRows; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalRows);
    const batch = allRows.slice(batchStart, batchEnd);

    for (const row of batch) {
      const expectedHash = computeChainHash(
        auditChainContent({
          action: row.action,
          adminWallet: row.admin_wallet,
          queryParams: row.query_params,
          createdAt: row.created_at,
          eventSource: row.event_source,
        }),
        expectedPrevHash,
      );

      if (row.hash !== expectedHash) {
        const violation: AuditViolation = {
          id: row.id,
          expected_hash: expectedHash,
          stored_hash: row.hash,
          audit_event_type: row.action,
          created_at: row.created_at,
        };
        violations.push(violation);
        logger.warn(
          { id: row.id, expected_hash: expectedHash, stored_hash: row.hash },
          'audit chain violation detected',
        );
        // Continue checking the rest of the chain using the stored hash so
        // violations that follow an already-broken link are still reported
        // independently.
        expectedPrevHash = row.hash;
      } else {
        expectedPrevHash = row.hash;
      }

      rowsChecked += 1;
    }

    // Deadline check after processing each batch.
    if (Date.now() >= deadline) {
      return {
        status: 'timeout',
        chain_length: totalRows,
        violations,
        rows_checked: rowsChecked,
      };
    }
  }

  return {
    status: violations.length > 0 ? 'tampered' : 'ok',
    chain_length: totalRows,
    violations,
    rows_checked: rowsChecked,
  };
}

/**
 * Legacy single-pass chain verification (stops at the first broken row).
 * Kept for backward compatibility — internal callers that only need a
 * boolean valid/invalid result can continue using this lighter function.
 *
 * @deprecated Use verifyAuditChainFull() for richer reporting (#764).
 */
export async function verifyAuditChain(): Promise<AuditChainVerification> {
  const rows: AuditLogRow[] = await getAllAuditLogRows();
  let expectedPrevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtId: row.id,
        reason: `row ${row.id}: stored prev_hash does not match the previous row's actual hash (a row may have been deleted, reordered, or its prev_hash tampered with)`,
        rowsChecked: rows.length,
      };
    }

    const expectedHash = computeChainHash(
      auditChainContent({
        action: row.action,
        adminWallet: row.admin_wallet,
        queryParams: row.query_params,
        createdAt: row.created_at,
        eventSource: row.event_source,
      }),
      expectedPrevHash,
    );

    if (row.hash !== expectedHash) {
      return {
        valid: false,
        brokenAtId: row.id,
        reason: `row ${row.id}: stored hash does not match the hash recomputed from its content — row may have been tampered with`,
        rowsChecked: rows.length,
      };
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true, brokenAtId: null, rowsChecked: rows.length };
}
