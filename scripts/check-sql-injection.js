const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '../src/db');
let found = false;

// Line-comment marker that suppresses a match on the line immediately below it.
// Only use this for interpolation of pre-built query fragments (WHERE/ORDER BY
// clauses, column names, driver-specific SQL snippets) that are themselves
// assembled from hardcoded strings and `?` placeholders — never for raw
// values, which must always be passed as query parameters.
const SUPPRESS_MARKER = 'sql-injection-check-ignore';

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  // Look for backticks containing SELECT, INSERT, UPDATE, or DELETE followed by string interpolation ${
  const sqlInterpolationRegex = /`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*\$\{.*?\}[^`]*`/g;

  let match;
  while ((match = sqlInterpolationRegex.exec(content)) !== null) {
    const matchStartLine = content.slice(0, match.index).split('\n').length; // 1-indexed
    const precedingLine = lines[matchStartLine - 2] || ''; // line immediately above the match
    if (precedingLine.includes(SUPPRESS_MARKER)) {
      continue;
    }
    console.error(`[FAIL] SQL string interpolation found in ${filePath}:\n${match[0]}\n`);
    found = true;
  }
}

fs.readdirSync(dbDir).forEach(file => {
  if (file.endsWith('.ts')) {
    scanFile(path.join(dbDir, file));
  }
});

if (found) {
  process.exit(1);
} else {
  console.log('[PASS] No SQL string interpolation detected.');
}
