import crypto from 'crypto';
import config from '../../src/config';
import { getDriver, insertScoutPlayerNote } from '../../src/db';
import { decryptField, encryptField, getStoredKeyId } from '../../src/utils/fieldCipher';
import { parseKeyring } from '../../src/utils/keyring';
import { getEncryptionStatus, reencryptBatch } from '../../src/services/fieldReencryptionJob';

const b64 = () => crypto.randomBytes(32).toString('base64');
const RING = { a: b64(), b: b64(), c: b64() };
const ringString = (...ids: Array<keyof typeof RING>) => ids.map((i) => `${i}:${RING[i]}`).join(',');

function useRing(ids: Array<keyof typeof RING>, active: keyof typeof RING) {
  config.notesEncryptionKeys = ringString(...ids);
  config.notesEncryptionActiveKeyId = active;
}

describe('field encryption keyring (#1513)', () => {
  afterEach(() => {
    config.notesEncryptionKeys = '';
    config.notesEncryptionActiveKeyId = '';
    config.webhookSecretEncryptionKeys = '';
    config.webhookSecretEncryptionActiveKeyId = '';
  });

  it('tags new ciphertexts with the active key id and still decrypts v1', () => {
    const v1 = encryptField('legacy', { purpose: 'notes' });
    expect(v1.startsWith('v1:')).toBe(true);

    useRing(['a'], 'a');
    const v2 = encryptField('fresh', { purpose: 'notes' });
    expect(v2.startsWith('v2:a:')).toBe(true);
    expect(getStoredKeyId(v2)).toBe('a');
    expect(decryptField(v2, { purpose: 'notes' })).toBe('fresh');
    expect(decryptField(v1, { purpose: 'notes' })).toBe('legacy');
  });

  it('keeps three keys coexisting and decrypts by key id', () => {
    const blobs = (['a', 'b', 'c'] as const).map((id) => {
      useRing(['a', 'b', 'c'], id);
      return encryptField(`secret-${id}`, { purpose: 'notes' });
    });
    useRing(['a', 'b', 'c'], 'c');
    blobs.forEach((blob, i) => {
      expect(decryptField(blob, { purpose: 'notes' })).toBe(`secret-${'abc'[i]}`);
    });
  });

  it('works for the webhook purpose and fails clearly when the key id is missing', () => {
    config.webhookSecretEncryptionKeys = ringString('a', 'b');
    config.webhookSecretEncryptionActiveKeyId = 'b';
    const blob = encryptField('whsec', { purpose: 'webhook' });
    expect(blob.startsWith('v2:b:')).toBe(true);

    config.webhookSecretEncryptionKeys = ringString('a');
    config.webhookSecretEncryptionActiveKeyId = 'a';
    expect(() => decryptField(blob, { purpose: 'webhook' })).toThrow(/key id "b" is not in the configured keyring/);
  });

  it('fails startup validation when the active key id is not in the keyring', () => {
    expect(() => parseKeyring(ringString('a'), 'zzz', 'K', 'ACTIVE')).toThrow(/"zzz" is not present in K/);
    expect(() => parseKeyring(ringString('a'), '', 'K', 'ACTIVE')).toThrow(/ACTIVE is required/);
    expect(() => parseKeyring(`${ringString('a')},${ringString('a')}`, 'a', 'K', 'ACTIVE')).toThrow(/duplicate/);
    expect(() => parseKeyring('a:c2hvcnQ=', 'a', 'K', 'ACTIVE')).toThrow(/32 bytes/);
    expect(parseKeyring('', '', 'K', 'ACTIVE')).toBeNull();
  });
});

describe('online re-encryption job (#1513)', () => {
  const SCOUT = 'GREENCRYPTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  afterEach(() => {
    config.notesEncryptionKeys = '';
    config.notesEncryptionActiveKeyId = '';
  });

  async function seed(keyId: keyof typeof RING | null, text: string): Promise<number> {
    if (keyId) useRing(['a', 'b'], keyId);
    else config.notesEncryptionKeys = '';
    await insertScoutPlayerNote({
      scout_wallet: SCOUT,
      player_id: 'p-reenc',
      content: text,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const row = await getDriver().get<{ id: number }>(
      'SELECT id FROM scout_player_notes_v2 WHERE scout_wallet = ? ORDER BY id DESC LIMIT 1',
      [SCOUT],
    );
    return row!.id;
  }

  const readRaw = async (id: number) =>
    (await getDriver().get<{ content: string }>('SELECT content FROM scout_player_notes_v2 WHERE id = ?', [id]))!
      .content;

  it('moves every row to the active key and reports per-key counts', async () => {
    const idV1 = await seed(null, 'legacy row');
    const idA = await seed('a', 'key a row');
    const idB = await seed('b', 'key b row');

    useRing(['a', 'b'], 'b');
    const before = await getEncryptionStatus();
    const beforeCounts = before.notes.targets.find((t) => t.table === 'scout_player_notes_v2')!.byKeyId;
    expect(beforeCounts.v1).toBeGreaterThanOrEqual(1);
    expect(beforeCounts.a).toBeGreaterThanOrEqual(1);

    const result = await reencryptBatch(100);
    expect(result.failed).toBe(0);
    expect(result.reencrypted).toBeGreaterThanOrEqual(2);

    for (const id of [idV1, idA, idB]) {
      const raw = await readRaw(id);
      expect(getStoredKeyId(raw)).toBe('b');
    }
    expect(decryptField(await readRaw(idV1), { purpose: 'notes' })).toBe('legacy row');

    const after = await getEncryptionStatus();
    const counts = after.notes.targets.find((t) => t.table === 'scout_player_notes_v2')!.byKeyId;
    expect(counts.a).toBe(0);
    expect(counts.v1).toBe(0);
    expect(after.notes.activeKeyId).toBe('b');
  });

  it('does not clobber a concurrent write (optimistic concurrency)', async () => {
    const id = await seed('a', 'before');
    useRing(['a', 'b'], 'b');

    // Simulate a write landing between the job's SELECT and UPDATE.
    const driver = getDriver();
    const realRun = driver.run.bind(driver);
    const concurrent = encryptField('written concurrently', { purpose: 'notes' });
    const spy = jest.spyOn(driver, 'run').mockImplementationOnce(async (sql, params) => {
      await realRun('UPDATE scout_player_notes_v2 SET content = ? WHERE id = ?', [concurrent, id]);
      return realRun(sql, params);
    });

    const result = await reencryptBatch(1000);
    spy.mockRestore();
    expect(result.conflicts).toBe(1);
    expect(decryptField(await readRaw(id), { purpose: 'notes' })).toBe('written concurrently');

    // The next pass picks the row up again if it is not on the active key.
    await reencryptBatch(1000);
    expect(getStoredKeyId(await readRaw(id))).toBe('b');
  });
});
