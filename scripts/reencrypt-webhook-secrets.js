#!/usr/bin/env node
/**
 * One-off migration script (#686).
 *
 * Re-encrypts plaintext webhook secrets. Pass --rotate to decrypt and
 * re-encrypt already-encrypted rows under the current key (the previous key
 * must remain configured until the migration completes).
 *
 * Usage:
 *   WEBHOOK_SECRET_ENCRYPTION_KEY=<hex key> node scripts/reencrypt-webhook-secrets.js
 *   SECRETS_PROVIDER=file SECRETS_DIR=/run/secrets node scripts/reencrypt-webhook-secrets.js
 *
 * Requires the project to be built first (`npm run build`), since it loads
 * compiled output from dist/, matching scripts/backfill.js's convention.
 */

require('dotenv').config();

if (!process.env.CONTRACT_ID) process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
if (!process.env.JWT_SECRET)   process.env.JWT_SECRET  = 'reencrypt-webhook-secrets-script';

const { getSecret } = require('../dist/secrets/provider');

if (!getSecret('WEBHOOK_SECRET_ENCRYPTION_KEY')) {
  console.error('Error: WEBHOOK_SECRET_ENCRYPTION_KEY must be set to re-encrypt webhook secrets.');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

const { initDb, getDb } = require('../dist/db');
const {
  decryptWebhookSecret,
  encryptWebhookSecret,
  isEncryptedWebhookSecret,
} = require('../dist/utils/webhookSecretCipher');

initDb();
const db = getDb();
const rows = db.prepare('SELECT id, secret FROM webhook_subscriptions').all();
const rotate = process.argv.includes('--rotate');

if (rows.length === 0) {
  console.log('No webhook_subscriptions rows found. Nothing to migrate.');
  process.exit(0);
}

const update = db.prepare('UPDATE webhook_subscriptions SET secret = ? WHERE id = ?');

let migrated = 0;
let alreadyEncrypted = 0;

for (const row of rows) {
  if (isEncryptedWebhookSecret(row.secret) && !rotate) {
    alreadyEncrypted += 1;
    continue;
  }
  update.run(encryptWebhookSecret(decryptWebhookSecret(row.secret)), row.id);
  migrated += 1;
}

console.log(`Re-encrypted ${migrated} webhook subscription secret(s).`);
console.log(`${alreadyEncrypted} row(s) were already encrypted and left unchanged.`);
