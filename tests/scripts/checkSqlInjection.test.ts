/**
 * Tests for scripts/check-sql-injection.js (#1622).
 *
 * Exercises detection, the allowlist markers and the exit-code contract
 * using temp fixture files, so regressions in the scanner itself are
 * caught here rather than only surfacing as CI failures.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
/* eslint-enable @typescript-eslint/no-var-requires */

const SCRIPT = path.join(__dirname, '../../scripts/check-sql-injection.js');

function writeFixture(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('check-sql-injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-injection-'));
    jest.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flags an interpolated SELECT', () => {
    const checker = require(SCRIPT);
    writeFixture(tmpDir, 'bad.ts', 'const q = `SELECT * FROM users WHERE id=${id}`;\n');
    checker.scanFile(path.join(tmpDir, 'bad.ts'));
    expect(checker.found).toBe(true);
  });

  test('ignores parameterized ? queries', () => {
    const checker = require(SCRIPT);
    writeFixture(tmpDir, 'ok.ts', 'const q = `SELECT * FROM users WHERE id = ?`;\n');
    checker.scanFile(path.join(tmpDir, 'ok.ts'));
    expect(checker.found).toBe(false);
  });

  test('honours the allow comment on the preceding line', () => {
    const checker = require(SCRIPT);
    writeFixture(
      tmpDir,
      'allowed.ts',
      '// sql-injection-ok: column list is a hardcoded constant\n' +
        'const q = `SELECT ${COLUMNS} FROM users`;\n',
    );
    checker.scanFile(path.join(tmpDir, 'allowed.ts'));
    expect(checker.found).toBe(false);
  });

  test('returns a non-zero exit code on findings', () => {
    const src = path.join(tmpDir, 'src');
    fs.mkdirSync(src, { recursive: true });
    writeFixture(
      src,
      'bad.ts',
      'const q = `DELETE FROM sessions WHERE token=${token}`;\n',
    );
    // Exercise the CLI contract in a child process: exit 1 when findings exist.
    const probe = `process.exit(require(${JSON.stringify(
      SCRIPT,
    )}).run(${JSON.stringify(src)}) ? 1 : 0)`;
    expect(() => {
      execFileSync('node', ['-e', probe], { stdio: 'pipe' });
    }).toThrow();
  });

  test('run() returns false for a clean tree', () => {
    const checker = require(SCRIPT);
    writeFixture(tmpDir, 'ok.ts', 'const q = `SELECT * FROM users WHERE id = ?`;\n');
    expect(checker.run(tmpDir)).toBe(false);
  });
});
