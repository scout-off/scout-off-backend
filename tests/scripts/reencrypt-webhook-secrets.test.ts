/**
 * Tests for scripts/reencrypt-webhook-secrets.js (#1876).
 *
 * Behaviour under test (see the script header and docs/secrets-rotation.md):
 *   - plaintext rows are encrypted under WEBHOOK_SECRET_ENCRYPTION_KEY;
 *   - already-encrypted rows (`v1:`/`v2:` prefix) are left unchanged unless
 *     `--rotate` is passed, in which case they are decrypted (current key, then
 *     WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS) and re-encrypted under the current key;
 *   - without `--rotate` the script never decrypts, so a row that merely has the
 *     prefix but is corrupt is left untouched and the script exits 0.
 *
 * The cipher resolves its key from the loaded config, so every encrypt/decrypt
 * and the schema setup run in a child process with an explicit environment.
 *
 * Requires `npm run build` (the script loads dist/), matching scripts/backfill.js.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/reencrypt-webhook-secrets.js');

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

function childEnv(dbPath: string, key: string, previousKey = ''): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    DB_DRIVER: 'sqlite',
    WEBHOOK_SECRET_ENCRYPTION_KEY: key,
    WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS: previousKey,
    WEBHOOK_SECRET_ENCRYPTION_KEYS: '',
    WEBHOOK_SECRET_ENCRYPTION_ACTIVE_KEY_ID: '',
    CONTRACT_ID:
      process.env.CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    JWT_SECRET: process.env.JWT_SECRET ?? 'reencrypt-webhook-secrets-test-secret-value',
    LOG_LEVEL: 'error',
  };
}

/** Run a snippet against dist/ in a child process and parse the JSON it prints last. */
function runNode<T>(code: string, env: NodeJS.ProcessEnv, input: unknown): T {
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...env, TEST_INPUT: JSON.stringify(input) },
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as T;
}

function encrypt(key: string, values: string[]): string[] {
  return runNode<string[]>(
    `const c = require('./dist/utils/webhookSecretCipher');
     console.log(JSON.stringify(JSON.parse(process.env.TEST_INPUT).map(c.encryptWebhookSecret)));`,
    childEnv(':memory:', key),
    values,
  );
}

function decrypt(key: string, values: string[]): string[] {
  return runNode<string[]>(
    `const c = require('./dist/utils/webhookSecretCipher');
     console.log(JSON.stringify(JSON.parse(process.env.TEST_INPUT).map(c.decryptWebhookSecret)));`,
    childEnv(':memory:', key),
    values,
  );
}

/** Create the schema via the real initDb()/migrations, then insert rows. */
function seed(dbPath: string, secrets: string[]): void {
  runNode<number>(
    `const db = require('./dist/db');
     db.initDb().then(() => {
     const conn = db.getDb();
     conn.prepare('DELETE FROM webhook_subscriptions').run();
     const insert = conn.prepare(
       'INSERT INTO webhook_subscriptions (url, secret, scout_wallet, event_types, created_at) VALUES (?, ?, ?, ?, ?)'
     );
     const secrets = JSON.parse(process.env.TEST_INPUT);
     secrets.forEach((s, i) => insert.run('https://example.test/hook/' + i, s, null, null, new Date().toISOString()));
     db.closeDb();
     console.log(JSON.stringify(secrets.length));
     });`,
    childEnv(dbPath, KEY_A),
    secrets,
  );
}

function readSecrets(dbPath: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    return (
      db.prepare('SELECT secret FROM webhook_subscriptions ORDER BY id ASC').all() as {
        secret: string;
      }[]
    ).map((row) => row.secret);
  } finally {
    db.close();
  }
}

function runScript(dbPath: string, key: string, args: string[] = [], previousKey = ''): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: childEnv(dbPath, key, previousKey),
    encoding: 'utf8',
  });
}

describe('scripts/reencrypt-webhook-secrets.js', () => {
  const plaintexts = ['whsec_alpha', 'whsec_beta', 'whsec_gamma'];
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reencrypt-webhook-')), 'test.db');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('encrypts plaintext secrets under the configured key', () => {
    seed(dbPath, plaintexts);

    const output = runScript(dbPath, KEY_B);
    expect(output).toContain(`Re-encrypted ${plaintexts.length} webhook subscription secret(s).`);
    expect(output).toContain('0 row(s) were already encrypted and left unchanged.');

    const after = readSecrets(dbPath);
    expect(after).not.toEqual(plaintexts);
    expect(decrypt(KEY_B, after)).toEqual(plaintexts);
  });

  it('is idempotent: a second run leaves rows unchanged', () => {
    seed(dbPath, plaintexts);
    runScript(dbPath, KEY_B);
    const afterFirst = readSecrets(dbPath);

    const output = runScript(dbPath, KEY_B);
    expect(output).toContain('Re-encrypted 0 webhook subscription secret(s).');
    expect(output).toContain(
      `${plaintexts.length} row(s) were already encrypted and left unchanged.`,
    );
    expect(readSecrets(dbPath)).toEqual(afterFirst);
  });

  it('with --rotate, re-encrypts key-A rows under key B (previous key = A)', () => {
    seed(dbPath, encrypt(KEY_A, plaintexts));
    const before = readSecrets(dbPath);

    const output = runScript(dbPath, KEY_B, ['--rotate'], KEY_A);
    expect(output).toContain(`Re-encrypted ${plaintexts.length} webhook subscription secret(s).`);

    const after = readSecrets(dbPath);
    expect(after).not.toEqual(before);
    // Decryptable with key B alone — no previous key configured.
    expect(decrypt(KEY_B, after)).toEqual(plaintexts);
  });

  it('leaves corrupt (prefix-only) rows untouched without --rotate and exits 0', () => {
    const corrupt = 'v1:deadbeef:not-a-real-tag:not-real-ciphertext';
    const [valid] = encrypt(KEY_A, ['whsec_valid']);
    seed(dbPath, [corrupt, valid]);

    const output = runScript(dbPath, KEY_B);
    expect(output).toContain('Re-encrypted 0 webhook subscription secret(s).');
    expect(output).toContain('2 row(s) were already encrypted and left unchanged.');
    expect(readSecrets(dbPath)).toEqual([corrupt, valid]);
  });

  it('exits non-zero when WEBHOOK_SECRET_ENCRYPTION_KEY is missing', () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        env: childEnv(dbPath, ''),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
