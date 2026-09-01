import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  upsertScoutNote,
  getScoutNote,
  getScoutNotes,
  insertScoutPlayerNote,
  getScoutPlayerNotes,
  updateScoutPlayerNote,
  deleteScoutPlayerNote,
} from '../db';
import { sanitizeInput } from '../utils/sanitizer';
import { logger } from '../utils/logger';

// ─── Validation ────────────────────────────────────────────────────────────────

export const upsertNoteSchema = z.object({
  note: z.string().min(1, 'Note text is required').max(10_000, 'Note must be 10 000 characters or fewer'),
}).strict();

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * PUT /api/scouts/:wallet/notes/:playerId
 *
 * Create or update a private note for the authenticated scout on the given player.
 * Uses upsert semantics — upserting twice for the same player updates in place.
 *
 * @auth Bearer (scout role, wallet must match authenticated account)
 */
export async function putScoutNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {playerId} = req.params as {playerId: string};
  const parsed = upsertNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const sanitizedNote = sanitizeInput(parsed.data.note);
  const now = Math.floor(Date.now() / 1000);

  await upsertScoutNote({
    scout_wallet: req.params.wallet as string,
    player_id: playerId,
    note_text: sanitizedNote,
    updated_at: now,
  });

  logger.info({ scout: req.params.wallet as string, playerId, action: 'scout_note_upserted' });

  res.status(200).json({
    success: true,
    data: {
      scout_wallet: req.params.wallet as string,
      player_id: playerId,
      note: sanitizedNote,
      updated_at: now,
    },
  });
}

/**
 * GET /api/scouts/:wallet/notes/:playerId
 *
 * Retrieve the authenticated scout's private note for a specific player.
 * Returns 404 when no note exists yet.
 *
 * @auth Bearer (scout role, wallet must match authenticated account)
 */
export async function getScoutNoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {playerId} = req.params as {playerId: string};
  const row = await getScoutNote(req.params.wallet as string, playerId);

  if (!row) {
    res.status(404).json({ success: false, error: 'Note not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      scout_wallet: row.scout_wallet,
      player_id: row.player_id,
      note: row.note_text,
      updated_at: row.updated_at,
    },
  });
}

/**
 * GET /api/scouts/:wallet/notes
 *
 * List all private notes for the authenticated scout, newest-first.
 *
 * @auth Bearer (scout role, wallet must match authenticated account)
 */
export async function listScoutNotesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rows = await getScoutNotes(req.params.wallet as string);

  res.json({
    success: true,
    data: rows.map((r) => ({
      scout_wallet: r.scout_wallet,
      player_id: r.player_id,
      note: r.note_text,
      updated_at: r.updated_at,
    })),
  });
}

// ─── Multi-note CRUD (#488 v2) ────────────────────────────────────────────────

const MAX_NOTE_CONTENT_LENGTH = 2_000;

/**
 * Zod schema for the note content field used by POST and PUT.
 */
export const noteContentSchema = z.object({
  content: z
    .string()
    .min(1, 'content is required')
    .max(MAX_NOTE_CONTENT_LENGTH, `content must be ${MAX_NOTE_CONTENT_LENGTH} characters or fewer`),
}).strict();

/**
 * POST /api/scouts/:wallet/players/:playerId/notes
 *
 * Create a new private note for the authenticated scout on the given player.
 * Content is sanitised (HTML stripped, whitespace trimmed) before storage.
 *
 * @body { content: string } – max 2 000 characters
 * @response 201 { success: true, data: { id, scout_wallet, player_id, content, created_at, updated_at } }
 * @response 400 Invalid or missing content / content too long
 * @response 403 Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function createPlayerNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = noteContentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const {playerId} = req.params as {playerId: string};
  const sanitized = sanitizeInput(parsed.data.content);
  const now = Math.floor(Date.now() / 1000);

  const id = await insertScoutPlayerNote({
    scout_wallet: req.params.wallet as string,
    player_id: playerId,
    content: sanitized,
    created_at: now,
    updated_at: now,
  });

  logger.info({ scout: req.params.wallet as string, playerId, noteId: id, action: 'player_note_created' });

  res.status(201).json({
    success: true,
    data: {
      id,
      scout_wallet: req.params.wallet as string,
      player_id: playerId,
      content: sanitized,
      created_at: now,
      updated_at: now,
    },
  });
}

/**
 * GET /api/scouts/:wallet/players/:playerId/notes
 *
 * List all private notes for the authenticated scout on the given player,
 * ordered newest-first.
 *
 * @response 200 { success: true, data: Array<{ id, scout_wallet, player_id, content, created_at, updated_at }> }
 * @response 403 Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function listPlayerNotes(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {playerId} = req.params as {playerId: string};
  const rows = await getScoutPlayerNotes(req.params.wallet as string, playerId);

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      scout_wallet: r.scout_wallet,
      player_id: r.player_id,
      content: r.content,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
}

/**
 * PUT /api/scouts/:wallet/players/:playerId/notes/:noteId
 *
 * Update an existing note's content.
 * Returns 404 when the note doesn't exist or belongs to another scout.
 *
 * @body { content: string } – max 2 000 characters
 * @response 200 { success: true, data: { id, scout_wallet, player_id, content, updated_at } }
 * @response 400 Invalid or missing content / content too long
 * @response 403 Wallet mismatch
 * @response 404 Note not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function updatePlayerNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {playerId, noteId} = req.params as {playerId: string, noteId: string};
  const id = parseInt(noteId, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid note id' });
    return;
  }

  const parsed = noteContentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const sanitized = sanitizeInput(parsed.data.content);
  const now = Math.floor(Date.now() / 1000);

  const updated = await updateScoutPlayerNote({
    id,
    scout_wallet: req.params.wallet as string,
    content: sanitized,
    updated_at: now,
  });

  if (!updated) {
    res.status(404).json({ success: false, error: 'Note not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, playerId, noteId: id, action: 'player_note_updated' });

  res.json({
    success: true,
    data: {
      id,
      scout_wallet: req.params.wallet as string,
      player_id: playerId,
      content: sanitized,
      updated_at: now,
    },
  });
}

/**
 * DELETE /api/scouts/:wallet/players/:playerId/notes/:noteId
 *
 * Delete a note by id.
 * Returns 404 when the note doesn't exist or belongs to another scout.
 *
 * @response 200 { success: true, data: { removed: true, id } }
 * @response 403 Wallet mismatch
 * @response 404 Note not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function deletePlayerNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {playerId, noteId} = req.params as {playerId: string, noteId: string};
  const id = parseInt(noteId, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid note id' });
    return;
  }

  const removed = await deleteScoutPlayerNote(id, req.params.wallet as string);

  if (!removed) {
    res.status(404).json({ success: false, error: 'Note not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, playerId, noteId: id, action: 'player_note_deleted' });

  res.json({ success: true, data: { removed: true, id } });
}
