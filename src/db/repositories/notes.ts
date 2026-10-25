/**
 * Repository: encrypted scout player notes (v1 and v2 multi-note).
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';
import { decryptField, encryptField } from '../../utils/fieldCipher';

// ─── Scout player notes helpers (#488) ───────────────────────────────────────

export interface ScoutPlayerNoteRow {
  id: number;
  scout_wallet: string;
  player_id: string;
  note_text: string;
  updated_at: number;
}

/**
 * Create or update a private note for a scout on a specific player.
 * Uses upsert semantics: calling twice for the same (scout_wallet, player_id)
 * pair overwrites the note rather than creating a duplicate row.
 */
function encryptScoutNoteContent(plaintext: string): string {
  return encryptField(plaintext, { purpose: 'notes' });
}

function decryptScoutNoteContent(stored: string): string {
  return decryptField(stored, { purpose: 'notes' });
}

function mapScoutPlayerNoteRow(row: ScoutPlayerNoteRow): ScoutPlayerNoteRow {
  return { ...row, note_text: decryptScoutNoteContent(row.note_text) };
}

function mapScoutPlayerNoteV2Row(row: ScoutPlayerNoteV2Row): ScoutPlayerNoteV2Row {
  return { ...row, content: decryptScoutNoteContent(row.content) };
}

export async function upsertScoutNote(p: {
  scout_wallet: string;
  player_id: string;
  note_text: string;
  updated_at: number;
}): Promise<void> {
  const sql = `
    INSERT INTO scout_player_notes (scout_wallet, player_id, note_text, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scout_wallet, player_id) DO UPDATE SET
      note_text  = excluded.note_text,
      updated_at = excluded.updated_at
  `;
  const encryptedNote = encryptScoutNoteContent(p.note_text);
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.scout_wallet, p.player_id, encryptedNote, p.updated_at]),
  );
}

/**
 * Retrieve a single private note by scout wallet + player id.
 * Returns null when no note exists.
 */
export async function getScoutNote(
  scoutWallet: string,
  playerId: string,
): Promise<ScoutPlayerNoteRow | null> {
  const sql =
    'SELECT * FROM scout_player_notes WHERE scout_wallet = ? AND player_id = ? LIMIT 1';
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<ScoutPlayerNoteRow>(sql, [scoutWallet, playerId]);
    return row ? mapScoutPlayerNoteRow(row) : null;
  });
}

/**
 * List all private notes authored by a scout, ordered newest-first.
 */
export async function getScoutNotes(scoutWallet: string): Promise<ScoutPlayerNoteRow[]> {
  const sql =
    'SELECT * FROM scout_player_notes WHERE scout_wallet = ? ORDER BY updated_at DESC';
  return timedQueryAsync(sql, async () => {
    const rows = await getDriver().all<ScoutPlayerNoteRow>(sql, [scoutWallet]);
    return rows.map(mapScoutPlayerNoteRow);
  });
}

// ─── Scout player notes v2 helpers (multi-note CRUD) ─────────────────────────

export interface ScoutPlayerNoteV2Row {
  id: number;
  scout_wallet: string;
  player_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/**
 * Insert a new private note for a scout on a specific player.
 * Returns the new row id.
 */
export async function insertScoutPlayerNote(p: {
  scout_wallet: string;
  player_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}): Promise<number> {
  const sql = `
    INSERT INTO scout_player_notes_v2 (scout_wallet, player_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `;
  const encryptedContent = encryptScoutNoteContent(p.content);
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [
      p.scout_wallet,
      p.player_id,
      encryptedContent,
      p.created_at,
      p.updated_at,
    ]);
    return info.lastId;
  });
}

/**
 * List all notes for a scout-player pair, ordered newest-first.
 */
export async function getScoutPlayerNotes(
  scoutWallet: string,
  playerId: string,
): Promise<ScoutPlayerNoteV2Row[]> {
  const sql = `
    SELECT * FROM scout_player_notes_v2
    WHERE scout_wallet = ? AND player_id = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, async () => {
    const rows = await getDriver().all<ScoutPlayerNoteV2Row>(sql, [scoutWallet, playerId]);
    return rows.map(mapScoutPlayerNoteV2Row);
  });
}

/**
 * Update the content of a note identified by id and scout_wallet.
 * Scoping the update to scout_wallet prevents cross-scout tampering.
 * Returns true when a row was updated, false when not found.
 */
export async function updateScoutPlayerNote(p: {
  id: number;
  scout_wallet: string;
  content: string;
  updated_at: number;
}): Promise<boolean> {
  const sql = `
    UPDATE scout_player_notes_v2
    SET content = ?, updated_at = ?
    WHERE id = ? AND scout_wallet = ?
  `;
  const encryptedContent = encryptScoutNoteContent(p.content);
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [encryptedContent, p.updated_at, p.id, p.scout_wallet]);
    return info.changes > 0;
  });
}

/**
 * Delete a note by id, scoped to the owning scout wallet.
 * Returns true when a row was deleted, false when not found.
 */
export async function deleteScoutPlayerNote(id: number, scoutWallet: string): Promise<boolean> {
  const sql = `
    DELETE FROM scout_player_notes_v2
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [id, scoutWallet]);
    return info.changes > 0;
  });
}
