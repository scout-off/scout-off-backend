#!/usr/bin/env node
/**
 * Environment variable validation script.
 *
 * Two modes:
 *   1. CI / documentation check (default): verifies every process.env.VAR
 *      referenced in src/ is listed in .env.example.
 *   2. Runtime startup check (--runtime): verifies required vars are set in
 *      the current process environment and validates NODE_ENV.
 *
 * Usage:
 *   node scripts/validate-env.js            # CI documentation check
 *   node scripts/validate-env.js --runtime  # called by src/config.ts on startup
 */
const fs = require('fs');
const path = require('path');

// ─── Required vars that must be present at runtime ───────────────────────────
const REQUIRED_RUNTIME_VARS = ['CONTRACT_ID', 'JWT_SECRET'];

// Valid NODE_ENV values; defaults to 'development' when unset.
const VALID_NODE_ENVS = ['development', 'test', 'production'];

// ─── Runtime check ────────────────────────────────────────────────────────────
if (process.argv.includes('--runtime')) {
  const errors = [];

  // Validate NODE_ENV
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (!VALID_NODE_ENVS.includes(nodeEnv)) {
    errors.push(`NODE_ENV="${nodeEnv}" is invalid. Must be one of: ${VALID_NODE_ENVS.join(', ')}`);
  }

  // Validate required vars
  for (const key of REQUIRED_RUNTIME_VARS) {
    if (!process.env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  if (errors.length) {
    errors.forEach((e) => console.error(`[env] ERROR: ${e}`));
    process.exit(1);
  }

  console.log('[env] All required environment variables are set ✓');
  process.exit(0);
}

// ─── CI / documentation check ────────────────────────────────────────────────
const examplePath = path.resolve(__dirname, '../.env.example');
const exampleKeys = new Set(
  fs
    .readFileSync(examplePath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0].trim())
);

const srcFiles = fs
  .readdirSync(path.resolve(__dirname, '../src'), { recursive: true })
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.resolve(__dirname, '../src', f));

const missing = [];
for (const file of srcFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const matches = [...content.matchAll(/process\.env\.([A-Z_]+)/g)];
  for (const [, key] of matches) {
    if (!exampleKeys.has(key)) missing.push({ key, file });
  }
}

if (missing.length) {
  console.error('Missing from .env.example:');
  missing.forEach(({ key, file }) => console.error(`  ${key}  (${file})`));
  process.exit(1);
}

console.log('All env vars documented in .env.example ✓');
