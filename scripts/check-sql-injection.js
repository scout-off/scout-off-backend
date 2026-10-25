const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');
let found = false;

// Line-comment markers that suppress a match on the line immediately below it.
// Only use these for interpolation of pre-built query fragments (WHERE/ORDER BY
// clauses, column names, driver-specific SQL snippets) that are themselves
// assembled from hardcoded strings and `?` placeholders — never for raw
// values, which must always be passed as query parameters.
const SUPPRESS_MARKERS = ['sql-injection-check-ignore', 'sql-injection-ok'];

function isSuppressed(precedingLine) {
  return SUPPRESS_MARKERS.some(marker => precedingLine.includes(marker));
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  // Look for backticks containing SQL keywords followed by string interpolation ${
  const sqlInterpolationRegex = /`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)[^`]*\$\{.*?\}[^`]*`/g;

  let match;
  while ((match = sqlInterpolationRegex.exec(content)) !== null) {
    const matchStartLine = content.slice(0, match.index).split('\n').length; // 1-indexed
    const precedingLine = lines[matchStartLine - 2] || ''; // line immediately above the match
    if (isSuppressed(precedingLine)) {
      continue;
    }
    console.error(`[FAIL] SQL string interpolation found in ${filePath}:\n${match[0]}\n`);
    found = true;
  }
}

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The frontend bundle is client-side code and out of scope for SQL checks.
      if (entry.name === 'frontend') continue;
      scanDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      scanFile(fullPath);
    }
  }
}

function run(rootDir = srcDir) {
  found = false;
  scanDir(rootDir);
  return found;
}

if (require.main === module) {
  if (run()) {
    process.exit(1);
  } else {
    console.log('[PASS] No SQL string interpolation detected.');
  }
}

module.exports = { scanFile, scanDir, run, SUPPRESS_MARKERS, get found() { return found; } };
