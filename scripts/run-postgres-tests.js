#!/usr/bin/env node
/**
 * Run the Jest suite against DB_DRIVER=postgres (#1324).
 *
 * Reads tests/postgres-exclusions.json (path + reason + issue per entry),
 * prints the exclusion count, and forwards --testPathIgnorePatterns to Jest.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const exclusionsPath = path.join(root, 'tests', 'postgres-exclusions.json');

const raw = fs.readFileSync(exclusionsPath, 'utf8');
const { exclusions } = JSON.parse(raw);

if (!Array.isArray(exclusions)) {
  console.error('tests/postgres-exclusions.json must contain an "exclusions" array');
  process.exit(1);
}

console.log(`[test:postgres] ${exclusions.length} suite(s) excluded:`);
for (const entry of exclusions) {
  console.log(`  - ${entry.path}`);
  console.log(`      reason: ${entry.reason}`);
  console.log(`      issue:  ${entry.issue ?? '(none)'}`);
}

const ignoreArgs = ['--testPathIgnorePatterns=/node_modules/'];
for (const entry of exclusions) {
  ignoreArgs.push(`--testPathIgnorePatterns=${entry.path}`);
}

const env = {
  ...process.env,
  DB_DRIVER: process.env.DB_DRIVER || 'postgres',
};

const jestBin = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');
const result = spawnSync(
  process.execPath,
  ['--expose-gc', jestBin, '--runInBand', ...ignoreArgs, ...process.argv.slice(2)],
  { stdio: 'inherit', env, cwd: root },
);

process.exit(result.status ?? 1);
