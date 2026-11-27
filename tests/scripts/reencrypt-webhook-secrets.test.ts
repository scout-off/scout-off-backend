/**
 * Tests for scripts/reencrypt-webhook-secrets.js (#1876).
 *
 * Each test seeds a temp SQLite DB with webhook_subscriptions rows, then runs
 * the script as a child process with WEBHOOK_SECRET_ENCRYPTION_KEY=key B and
 * asserts the stored values are re-encrypted under B, decrypt back to the
 * original plaintext, and that a second run is a no-op (idempotency).
 *
 * Corrupt-row behaviour (documented + tested): the script only checks the
 * `v1:`/`v2:` prefix via isEncryptedWebhookSecret(). A row whose secret is
 * plaintext gets encrypted; a row that merely *looks* encrypted (has the
 * prefix) but is truncated/garbage is treated as already encrypted and left
 * untouched — the script never decrypts, so it cannot detect corruption and
 * exits 0. Such rows must be repaired out-of-band (see docs/secrets-rotation.md).
 *
 * Requires `npm run build` (the script loads dist/), matching scripts/backfill.js.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(__dirname, '../../scripts/reencrypt-webhook-secrets.js');
const DIST_CIPHER = path.resolve(__dirname, '../../dist/utils/webhookSecretCipher');

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

interface CipherModule {
  encryptWebhookSecret(plaintext: string): string;
  decryptWebhookSecret(stored: string): string;
  isEncryptedWebhookSecret(value: string): boolean;
}

/** Load the compiled cipher with a specific key, bypassing the module cache. */
function loadCipher(key: string): CipherModule {
  const previous = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = key;
  try {
    delete require.cache[require.resolve(DIST_CIPHER)];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(DIST_CIPHER) as CipherModule;
  } finally {
    if (previous === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = previous;
  }
}

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reencrypt-webhook-'));
  return path.join(dir, 'test.db');
}

/** Seed rows via the real initDb()/migrations, then close the connection. */
async function seed(dbPath: string, secrets: string[]): Promise<void> {
  process.env.DB_PATH = dbPath;
  process.env.DB_DRIVER = 'sqlite';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbModule = require('../../src/db') as typeof import('../../src/db');
  await dbModule.initDb();
  const db = dbModule.getDb();
  db.prepare('DELETE FROM webhook_subscriptions').run();
  const insert = db.prepare(
    'INSERT INTO webhook_subscriptions (url, secret, scout_wallet, event_types, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  secrets.forEach((secret, i) => {
    insert.run(`https://example.test/hook/${i}`, secret, null, null, new Date().toISOString());
  });
  dbModule.closeDb();
}

function readSecrets(dbPath: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new BetterSqlite3(dbPath);
  try {
    return (db.prepare('SELECT secret FROM webhook_subscriptions ORDER BY id ASC').all() as {
      secret: string;
    }[]).map((row) => row.secret);
  } finally {
    db.close();
  }
}

function runScript(dbPath: string, key: string): string {
  return execFileSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      DB_DRIVER: 'sqlite',
      WEBHOOK_SECRET_ENCRYPTION_KEY: key,
      WEBHOOK_SECRET_ENCRYPTION_KEYS: '',
      WEBHOOK_SECRET_ENCRYPTION_ACTIVE_KEY_ID: '',
      WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS: '',
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
  });
}

describe('scripts/reencrypt-webhook-secrets.js', () => {
  const plaintexts = ['whsec_alpha', 'whsec_beta', 'whsec_gamma'];
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    const cipherA = loadCipher(KEY_A);
    await seed(dbPath, plaintexts.map((p) => cipherA.encryptWebhookSecret(p)));
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('re-encrypts secrets from key A to key B and they decrypt under B', () => {
    const before = readSecrets(dbPath);
    expect(before.every((s) => loadCipher(KEY_A).isEncryptedWebhookSecret(s))).toBe(true);

    const output = runScript(dbPath, KEY_B);
    expect(output).toContain(`Re-encrypted ${plaintexts.length} plaintext webhook subscription secret(s).`);

    const after = readSecrets(dbPath);
    const cipherB = loadCipher(KEY_B);
    expect(after).not.toEqual(before);
    expect(after.map((s) => cipherB.decryptWebhookSecret(s))).toEqual(plaintexts);
  });

  it('is idempotent: a second run leaves rows unchanged', () => {
    runScript(dbPath, KEY_B);
    const afterFirst = readSecrets(dbPath);

    const output = runScript(dbPath, KEY_B);
    expect(output).toContain('Re-encrypted 0 plaintext webhook subscription secret(s).');
    expect(output).toContain(`${plaintexts.length} row(s) were already encrypted and left unchanged.`);
    expect(readSecrets(dbPath)).toEqual(afterFirst);
  });

  it('leaves corrupt (prefix-only) rows untouched and still exits 0', () => {
    const corrupt = 'v1:deadbeef:not-a-real-tag:not-real-ciphertext';
    const cipherA = loadCipher(KEY_A);
    const valid = cipherA.encryptWebhookSecret('whsec_valid');
    // Re-seed with one corrupt row alongside a valid one.
    fs.rmSync(dbPath, { force: true });
    return seed(dbPath, [corrupt, valid]).then(() => {
      const output = runScript(dbPath, KEY_B);
      expect(output).toContain('Re-encrypted 0 plaintext webhook subscription secret(s).');
      expect(output).toContain('2 row(s) were already encrypted and left unchanged.');

      const after = readSecrets(dbPath);
      // Corrupt row is preserved verbatim — the script never decrypts, so it
      // cannot detect or repair corruption; that is documented behaviour.
      expect(after[0]).toBe(corrupt);
      expect(loadCipher(KEY_B).decryptWebhookSecret(after[1])).toBe('whsec_valid');
    });
  });

  it('exits non-zero when WEBHOOK_SECRET_ENCRYPTION_KEY is missing', () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], {
        env: { ...process.env, DB_PATH: dbPath, DB_DRIVER: 'sqlite', WEBHOOK_SECRET_ENCRYPTION_KEY: '' },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
