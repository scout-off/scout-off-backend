/**
 * Tests for backup-db.sh --help marker-based extraction (issue #715).
 *
 * Verifies that:
 *   1. --help exits with code 0.
 *   2. --help output contains the expected usage content.
 *   3. --help output does NOT contain raw shell code (i.e. the line range
 *      did not drift into non-comment sections).
 *   4. Adding a line to the USAGE block does not break --help (robustness
 *      check that is the entire reason for this change).
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BACKUP_SCRIPT = path.join(REPO_ROOT, 'scripts/backup-db.sh');

const isWindows = process.platform === 'win32';

(isWindows ? describe.skip : describe)('backup-db.sh --help', () => {
  it('exits with code 0', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });

  it('exits with code 0 for -h shorthand', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT, '-h'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });

  it('includes the script description in the output', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const output = result.stdout;
    expect(output).toContain('backup-db.sh');
    expect(output).toContain('ScoutOff SQLite database');
  });

  it('includes environment variable documentation', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const output = result.stdout;
    expect(output).toContain('DB_PATH');
    expect(output).toContain('BACKUP_DEST');
  });

  it('includes the exit codes section', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.stdout).toContain('Exit codes');
  });

  it('does NOT leak raw shell code into the output', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const output = result.stdout;
    // These patterns indicate the extraction drifted outside the comment block
    expect(output).not.toMatch(/^set -/m);
    expect(output).not.toMatch(/^SCRIPT_DIR=/m);
    expect(output).not.toMatch(/^DB_PATH="\$\{/m);
    expect(output).not.toMatch(/^while \[\[/m);
  });

  it('output matches the USAGE block delimited by the markers in the script', () => {
    // Read the script and extract exactly what is between the marker lines —
    // this is what the awk command produces.  The test asserts the two views
    // of the content agree, so if someone edits the markers the test breaks.
    const scriptContent = fs.readFileSync(BACKUP_SCRIPT, 'utf8');
    const lines = scriptContent.split('\n');

    const startIdx = lines.findIndex((l) => l.trim() === '# --- USAGE START ---');
    const endIdx = lines.findIndex((l) => l.trim() === '# --- USAGE END ---');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);

    const expectedLines = lines
      .slice(startIdx + 1, endIdx)
      .map((l) => l.replace(/^# ?/, ''));
    const expected = expectedLines.join('\n').trim();

    const result = spawnSync('bash', [BACKUP_SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const actual = result.stdout.trim();

    expect(actual).toBe(expected);
  });

  it('is robust to new lines added inside the USAGE block (no hardcoded line numbers)', () => {
    // Create a temporary copy of the script with an extra line inserted
    // inside the USAGE block, then verify --help still works and includes
    // the extra line.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-off-help-'));
    try {
      const scriptContent = fs.readFileSync(BACKUP_SCRIPT, 'utf8');
      const extraLine = '# EXTRA_TEST_LINE: added to verify robustness';
      const modified = scriptContent.replace(
        '# --- USAGE END ---',
        `${extraLine}\n# --- USAGE END ---`
      );

      const tmpScript = path.join(tmpDir, 'backup-db.sh');
      fs.writeFileSync(tmpScript, modified, { mode: 0o755 });

      const result = spawnSync('bash', [tmpScript, '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      // The extra line should appear in the output (stripped of the '# ' prefix).
      expect(result.stdout).toContain('EXTRA_TEST_LINE: added to verify robustness');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
