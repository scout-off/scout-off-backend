#!/usr/bin/env node
/**
 * Key rotation script for scout note encryption (#1328).
 *
 * Re-encrypts every encrypted note row with NOTES_ENCRYPTION_KEY (primary).
 * Rows encrypted under NOTES_ENCRYPTION_KEY_PREVIOUS are decrypted via the
 * dual-key ring and rewritten with the new primary key.
 *
 * Plaintext legacy rows are encrypted in place (same as migrate-encrypt-notes).
 *
 * Usage:
 *   NOTES_ENCRYPTION_KEY=<new-key> \
 *   NOTES_ENCRYPTION_KEY_PREVIOUS=<old-key> \
 *   node scripts/reencrypt-notes.js
 */

require('dotenv').config();

if (!process.env.CONTRACT_ID) process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'reencrypt-notes-script';

if (!process.env.NOTES_ENCRYPTION_KEY) {
  console.error('Error: NOTES_ENCRYPTION_KEY must be set.');
  console.error('When rotating, set NOTES_ENCRYPTION_KEY_PREVIOUS to the prior key.');
  process.exit(1);
}

const { initDb, getDb } = require('../dist/db');
const {
  encryptField,
  decryptField,
  isEncryptedField,
} = require('../dist/utils/fieldCipher');

async function reencryptStored(stored) {
  const plaintext = decryptField(stored, { purpose: 'notes' });
  const encrypted = encryptField(plaintext, { purpose: 'notes' });
  return { plaintext, encrypted, changed: encrypted !== stored };
}

async function main() {
  await initDb();
  const db = getDb();

  const v1Rows = db.prepare('SELECT scout_wallet, player_id, note_text FROM scout_player_notes').all();
  const updateV1 = db.prepare(
    'UPDATE scout_player_notes SET note_text = ? WHERE scout_wallet = ? AND player_id = ?',
  );

  let rotatedV1 = 0;
  let unchangedV1 = 0;
  for (const row of v1Rows) {
    const { encrypted, changed } = await reencryptStored(row.note_text);
    if (changed) {
      updateV1.run(encrypted, row.scout_wallet, row.player_id);
      rotatedV1 += 1;
    } else {
      unchangedV1 += 1;
    }
  }

  const v2Rows = db.prepare('SELECT id, content FROM scout_player_notes_v2').all();
  const updateV2 = db.prepare('UPDATE scout_player_notes_v2 SET content = ? WHERE id = ?');

  let rotatedV2 = 0;
  let unchangedV2 = 0;
  for (const row of v2Rows) {
    const { encrypted, changed } = await reencryptStored(row.content);
    if (changed) {
      updateV2.run(encrypted, row.id);
      rotatedV2 += 1;
    } else {
      unchangedV2 += 1;
    }
  }

  console.log(`Re-encrypted ${rotatedV1} scout_player_notes row(s); ${unchangedV1} unchanged.`);
  console.log(`Re-encrypted ${rotatedV2} scout_player_notes_v2 row(s); ${unchangedV2} unchanged.`);

  if (!process.env.NOTES_ENCRYPTION_KEY_PREVIOUS) {
    console.warn(
      'Note: NOTES_ENCRYPTION_KEY_PREVIOUS was not set — only rows already under the primary key were processed.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
