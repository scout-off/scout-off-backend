import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import config from '../config';
import { DbTxHandle } from '../db/driver';
import { canonicalJSON } from './hashChain';

export interface AuditCheckpoint {
  last_id: number;
  last_hash: string;
  previous_hash: string;
  archive_file: string;
  archive_sha256: string;
  created_at: string;
  signature: string;
}
export function signCheckpoint(checkpoint: Omit<AuditCheckpoint, 'signature'>): string {
  if (!config.retention.checkpointKey) throw new Error('Missing retention checkpoint signing key');
  return createHmac('sha256', Buffer.from(config.retention.checkpointKey, 'hex'))
    .update(canonicalJSON(checkpoint)).digest('hex');
}

/** A missing key or invalid signature fails closed, including on the append path. */
export async function latestAuditCheckpoint(tx: DbTxHandle): Promise<AuditCheckpoint | undefined> {
  const row = await tx.get<AuditCheckpoint>('SELECT * FROM audit_checkpoints ORDER BY last_id DESC LIMIT 1');
  if (!row) return undefined;
  row.last_id = Number(row.last_id);
  if (!Number.isSafeInteger(row.last_id) || row.last_id < 1) throw new Error('Invalid audit checkpoint id');
  const { signature, ...content } = row;
  const expected = signCheckpoint(content);
  if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
    throw new Error('Invalid audit checkpoint signature');
  }
  return row;
}

export function checkpointArchivePath(filename: string): string {
  if (path.basename(filename) !== filename || !/^audit-[a-f0-9-]+\.json$/.test(filename)) throw new Error('Invalid checkpoint archive filename');
  return path.join(config.retention.archiveDir, filename);
}

export async function verifyCheckpointArchive(checkpoint: AuditCheckpoint): Promise<void> {
  const data = await readFile(checkpointArchivePath(checkpoint.archive_file));
  if (createHash('sha256').update(data).digest('hex') !== checkpoint.archive_sha256) throw new Error('Audit checkpoint archive is missing or corrupt');
}
