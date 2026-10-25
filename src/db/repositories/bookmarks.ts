/**
 * Repository: bookmarks and bookmark folders.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';
import { getPlayerById } from './players';
import type { PlayerRow } from './players';

// ─── Scout bookmarks helpers (#487) ──────────────────────────────────────────

export interface ScoutBookmarkRow {
  id: number;
  scout_wallet: string;
  player_id: string;
  folder_id: number | null;
  note: string | null;
  created_at: number;
}

export interface ScoutBookmarkFolderRow {
  id: number;
  scout_wallet: string;
  name: string;
  created_at: number;
}

/**
 * Insert a bookmark.  Uses INSERT OR IGNORE so re-bookmarking is idempotent.
 * Returns true when a new row was inserted, false when it already existed.
 */
export async function insertBookmark(p: {
  scout_wallet: string;
  player_id: string;
  folder_id?: number | null;
  note?: string | null;
  created_at: number;
}): Promise<boolean> {
  const sql = `
    INSERT INTO scout_bookmarks (scout_wallet, player_id, folder_id, note, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (scout_wallet, player_id) DO NOTHING
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [
      p.scout_wallet,
      p.player_id,
      p.folder_id ?? null,
      p.note ?? null,
      p.created_at,
    ]);
    return info.changes > 0;
  });
}

/**
 * Delete a bookmark.
 * Returns true when a row was deleted, false when it did not exist.
 */
export async function deleteBookmark(scoutWallet: string, playerId: string): Promise<boolean> {
  const sql = `DELETE FROM scout_bookmarks WHERE scout_wallet = ? AND player_id = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [scoutWallet, playerId]);
    return info.changes > 0;
  });
}

/**
 * List all bookmarks for a scout, ordered by creation time (newest first).
 * Optionally filter by folder_id.
 */
export async function getBookmarksByScout(scoutWallet: string, folderId?: number | null): Promise<ScoutBookmarkRow[]> {
  let sql: string;
  let params: (string | number | null)[];

  if (folderId !== undefined) {
    sql = `
      SELECT * FROM scout_bookmarks
      WHERE scout_wallet = ? AND folder_id = ?
      ORDER BY created_at DESC
    `;
    params = [scoutWallet, folderId];
  } else {
    sql = `
      SELECT * FROM scout_bookmarks
      WHERE scout_wallet = ?
      ORDER BY created_at DESC
    `;
    params = [scoutWallet];
  }

  return timedQueryAsync(sql, () => getDriver().all<ScoutBookmarkRow>(sql, params));
}

/**
 * Insert a bookmark folder. Returns the new folder id.
 */
export async function insertBookmarkFolder(p: {
  scout_wallet: string;
  name: string;
  created_at: number;
}): Promise<number> {
  const sql = `
    INSERT INTO scout_bookmark_folders (scout_wallet, name, created_at)
    VALUES (?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.scout_wallet, p.name, p.created_at]);
    return info.lastId;
  });
}

/**
 * List all bookmark folders for a scout, ordered by creation time (newest first).
 */
export async function getBookmarkFoldersByScout(scoutWallet: string): Promise<ScoutBookmarkFolderRow[]> {
  const sql = `
    SELECT * FROM scout_bookmark_folders
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, () => getDriver().all<ScoutBookmarkFolderRow>(sql, [scoutWallet]));
}

/**
 * Get a bookmark folder by id, ensuring it belongs to the scout.
 */
export async function getBookmarkFolderById(folderId: number, scoutWallet: string): Promise<ScoutBookmarkFolderRow | null> {
  const sql = `
    SELECT * FROM scout_bookmark_folders
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ScoutBookmarkFolderRow>(sql, [folderId, scoutWallet])) ?? null
  );
}

/**
 * Delete a bookmark folder by id, ensuring it belongs to the scout.
 * Returns true when a row was deleted, false when it did not exist.
 */
export async function deleteBookmarkFolder(folderId: number, scoutWallet: string): Promise<boolean> {
  const sql = `DELETE FROM scout_bookmark_folders WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [folderId, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Move bookmarks from a folder to root (set folder_id to NULL) when folder is deleted.
 */
export async function moveBookmarksToRoot(folderId: number, scoutWallet: string): Promise<void> {
  const sql = `UPDATE scout_bookmarks SET folder_id = NULL WHERE folder_id = ? AND scout_wallet = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [folderId, scoutWallet]));
}

/**
 * Count bookmarks in a folder.
 */
export async function countBookmarksInFolder(folderId: number): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM scout_bookmarks WHERE folder_id = ?`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ count: number | string }>(sql, [folderId]);
    return Number(row?.count ?? 0);
  });
}

/**
 * Joined row returned by getBookmarkedPlayersWithDetails().
 * Combines bookmark metadata with the bookmarked player's full profile.
 */
export interface BookmarkedPlayerRow extends PlayerRow {
  bookmarked_at: number;
  bookmark_folder_id: number | null;
  bookmark_note: string | null;
}

/**
 * Fetch all bookmarked players for a scout in a single JOIN query, eliminating
 * the N+1 pattern of calling getPlayerById() once per bookmark row.
 *
 * Returns rows ordered by bookmark creation time (newest first), matching the
 * ordering of getBookmarksByScout(). Bookmarks whose player_id no longer
 * exists in the players table are silently dropped (INNER JOIN semantics).
 *
 * @param scoutWallet  The scout's Stellar wallet address.
 * @param folderId     Optional folder filter. When provided, only bookmarks in
 *                     that folder are returned.
 */
export async function getBookmarkedPlayersWithDetails(
  scoutWallet: string,
  folderId?: number | null,
  opts?: { limit?: number; offset?: number },
): Promise<BookmarkedPlayerRow[]> {
  const limit = opts?.limit;
  const offset = opts?.offset;
  let sql: string;
  let params: (string | number | null)[];

  if (folderId !== undefined) {
    sql = `
      SELECT
        p.*,
        b.created_at AS bookmarked_at,
        b.folder_id  AS bookmark_folder_id,
        b.note       AS bookmark_note
      FROM scout_bookmarks b
      INNER JOIN players p ON p.player_id = b.player_id
      WHERE b.scout_wallet = ? AND b.folder_id = ?
      ORDER BY b.created_at DESC
    `;
    params = [scoutWallet, folderId];
  } else {
    sql = `
      SELECT
        p.*,
        b.created_at AS bookmarked_at,
        b.folder_id  AS bookmark_folder_id,
        b.note       AS bookmark_note
      FROM scout_bookmarks b
      INNER JOIN players p ON p.player_id = b.player_id
      WHERE b.scout_wallet = ?
      ORDER BY b.created_at DESC
    `;
    params = [scoutWallet];
  }

  if (limit !== undefined) {
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset ?? 0);
  }

  return timedQueryAsync(sql, () => getDriver().all<BookmarkedPlayerRow>(sql, params));
}


/**
 * Count bookmarked players for a scout (JOIN variant so orphans excluded,
 * matching getBookmarkedPlayersWithDetails). Used for pagination metadata.
 */
export async function countBookmarkedPlayers(
  scoutWallet: string,
  folderId?: number | null,
): Promise<number> {
  let sql: string;
  let params: (string | number | null)[];

  if (folderId !== undefined) {
    sql = `
      SELECT COUNT(*) AS cnt
      FROM scout_bookmarks b
      INNER JOIN players p ON p.player_id = b.player_id
      WHERE b.scout_wallet = ? AND b.folder_id = ?
    `;
    params = [scoutWallet, folderId];
  } else {
    sql = `
      SELECT COUNT(*) AS cnt
      FROM scout_bookmarks b
      INNER JOIN players p ON p.player_id = b.player_id
      WHERE b.scout_wallet = ?
    `;
    params = [scoutWallet];
  }

  const rows = await timedQueryAsync(sql, () => getDriver().all<{ cnt: number }>(sql, params));
  return Number(rows[0]?.cnt ?? 0);
}
