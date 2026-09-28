import {
  upsertScoutNote,
  getScoutNote,
  insertScoutPlayerNote,
  getScoutPlayerNotes,
  getDriver,
} from '../../src/db';
import { isEncryptedField } from '../../src/utils/fieldCipher';

describe('scout note encryption at rest (#1328)', () => {
  const SCOUT = 'GSCOUTNOTESAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const PLAYER = 'player-notes-enc-1';

  it('stores encrypted note_text and returns plaintext on read', async () => {
    const noteText = 'Strong left foot, good pace';
    await upsertScoutNote({
      scout_wallet: SCOUT,
      player_id: PLAYER,
      note_text: noteText,
      updated_at: Date.now(),
    });

    const raw = await getDriver().get<{ note_text: string }>(
      'SELECT note_text FROM scout_player_notes WHERE scout_wallet = ? AND player_id = ?',
      [SCOUT, PLAYER],
    );
    expect(raw).toBeDefined();
    expect(isEncryptedField(raw!.note_text)).toBe(true);
    expect(raw!.note_text).not.toContain(noteText);

    const row = await getScoutNote(SCOUT, PLAYER);
    expect(row?.note_text).toBe(noteText);
  });

  it('stores encrypted v2 content and returns plaintext on read', async () => {
    const content = 'Second observation';
    await insertScoutPlayerNote({
      scout_wallet: SCOUT,
      player_id: PLAYER,
      content,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const raw = await getDriver().get<{ content: string }>(
      'SELECT content FROM scout_player_notes_v2 WHERE scout_wallet = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
      [SCOUT, PLAYER],
    );
    expect(raw).toBeDefined();
    expect(isEncryptedField(raw!.content)).toBe(true);

    const rows = await getScoutPlayerNotes(SCOUT, PLAYER);
    expect(rows.some((r) => r.content === content)).toBe(true);
  });
});
