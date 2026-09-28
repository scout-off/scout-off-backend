#!/usr/bin/env node
/**
 * One-off migration script (#1328).
 *
 * Encrypts scout_player_notes.note_text and scout_player_notes_v2.content rows
 * still stored as plaintext. Idempotent — rows already prefixed with `v1:` are
 * skipped.
 *
 * Usage:
 *   NOTES_ENCRYPTION_KEY=<hex key> node scripts/migrate-encrypt-notes.js
 */

require('dotenv').config();

if (!process.env.CONTRACT_ID) process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'migrate-encrypt-notes-script';

if (!process.env.NOTES_ENCRYPTION_KEY) {
  console.error('Error: NOTES_ENCRYPTION_KEY must be set to encrypt scout notes.');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

const { initDb, getDb } = require('../dist/db');
const { encryptField, isEncryptedField } = require('../dist/utils/fieldCipher');

async function main() {
  await initDb();
  const db = getDb();

  const v1Rows = db.prepare('SELECT scout_wallet, player_id, note_text FROM scout_player_notes').all();
  const updateV1 = db.prepare(
    'UPDATE scout_player_notes SET note_text = ? WHERE scout_wallet = ? AND player_id = ?',
  );

  let migratedV1 = 0;
  let alreadyV1 = 0;
  for (const row of v1Rows) {
    if (isEncryptedField(row.note_text)) {
      alreadyV1 += 1;
      continue;
    }
    updateV1.run(encryptField(row.note_text, { purpose: 'notes' }), row.scout_wallet, row.player_id);
    migratedV1 += 1;
  }

  const v2Rows = db.prepare('SELECT id, content FROM scout_player_notes_v2').all();
  const updateV2 = db.prepare('UPDATE scout_player_notes_v2 SET content = ? WHERE id = ?');

  let migratedV2 = 0;
  let alreadyV2 = 0;
  for (const row of v2Rows) {
    if (isEncryptedField(row.content)) {
      alreadyV2 += 1;
      continue;
    }
    updateV2.run(encryptField(row.content, { purpose: 'notes' }), row.id);
    migratedV2 += 1;
  }

  console.log(`Encrypted ${migratedV1} scout_player_notes row(s); ${alreadyV1} already encrypted.`);
  console.log(`Encrypted ${migratedV2} scout_player_notes_v2 row(s); ${alreadyV2} already encrypted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
