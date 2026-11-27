/**
 * Tests for scripts/sync-client-version.js (#1875).
 *
 * The script copies the version from the root package.json (falling back to
 * the OpenAPI `info.version`) into clients/typescript/package.json, preserving
 * two-space indentation and a trailing newline, and is a no-op when the
 * versions already match. Fixtures live in a temp directory.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// The script is plain CommonJS; require it directly so the exported helpers
// can be exercised against temp fixtures without spawning a process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveVersion, syncClientVersion } = require('../../scripts/sync-client-version');

const CLIENT_PACKAGE = path.join('clients', 'typescript', 'package.json');

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSpec(root: string, version: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'openapi.yaml'),
    `openapi: 3.0.0\ninfo:\n  title: Fixture\n  version: ${version}\npaths: {}\n`,
  );
}

function readClientPackage(root: string): { raw: string; parsed: Record<string, unknown> } {
  const raw = fs.readFileSync(path.join(root, CLIENT_PACKAGE), 'utf8');
  return { raw, parsed: JSON.parse(raw) };
}

describe('sync-client-version', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-client-version-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('copies the version from the root package.json', () => {
    writeJson(path.join(root, 'package.json'), { name: 'root', version: '2.3.4' });
    writeSpec(root, '9.9.9');
    writeJson(path.join(root, CLIENT_PACKAGE), { name: 'client', version: '0.0.1' });

    const result = syncClientVersion(root);

    expect(result).toEqual({ version: '2.3.4', changed: true });
    expect(readClientPackage(root).parsed.version).toBe('2.3.4');
  });

  it('falls back to the OpenAPI info.version when the root package has none', () => {
    writeJson(path.join(root, 'package.json'), { name: 'root' });
    writeSpec(root, '4.5.6');
    writeJson(path.join(root, CLIENT_PACKAGE), { name: 'client', version: '0.0.1' });

    expect(resolveVersion(root)).toBe('4.5.6');
    expect(syncClientVersion(root)).toEqual({ version: '4.5.6', changed: true });
    expect(readClientPackage(root).parsed.version).toBe('4.5.6');
  });

  it('preserves two-space indentation and the trailing newline', () => {
    writeJson(path.join(root, 'package.json'), { name: 'root', version: '1.2.3' });
    writeSpec(root, '1.2.3');
    writeJson(path.join(root, CLIENT_PACKAGE), {
      name: 'client',
      version: '0.0.1',
      dependencies: { 'openapi-fetch': '^0.14.1' },
    });

    syncClientVersion(root);

    const { raw } = readClientPackage(root);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "name": "client",');
    expect(raw).toContain('\n    "openapi-fetch": "^0.14.1"');
    expect(raw).not.toContain('\t');
  });

  it('is a no-op when the versions already match', () => {
    writeJson(path.join(root, 'package.json'), { name: 'root', version: '1.0.0' });
    writeSpec(root, '1.0.0');
    writeJson(path.join(root, CLIENT_PACKAGE), { name: 'client', version: '1.0.0' });

    const clientPath = path.join(root, CLIENT_PACKAGE);
    const before = fs.readFileSync(clientPath, 'utf8');
    const beforeStat = fs.statSync(clientPath).mtimeMs;

    const result = syncClientVersion(root);

    expect(result).toEqual({ version: '1.0.0', changed: false });
    expect(fs.readFileSync(clientPath, 'utf8')).toBe(before);
    expect(fs.statSync(clientPath).mtimeMs).toBe(beforeStat);
  });
});
