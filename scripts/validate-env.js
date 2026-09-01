#!/usr/bin/env node
/**
 * Environment variable validation script.
 *
 * Two modes:
 *   1. CI / documentation check (default): verifies every process.env.VAR
 *      referenced in src/ is listed in .env.example, and warns about any
 *      .env.example entries that have no corresponding reference in src/.
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

// Valid DB_DRIVER values; defaults to 'sqlite' when unset.
const VALID_DB_DRIVERS = ['sqlite', 'postgres'];

function validateRuntimeEnv(env = process.env) {
  const errors = [];

  // Validate NODE_ENV
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!VALID_NODE_ENVS.includes(nodeEnv)) {
    errors.push(`NODE_ENV="${nodeEnv}" is invalid. Must be one of: ${VALID_NODE_ENVS.join(', ')}`);
  }

  // Validate required vars
  for (const key of REQUIRED_RUNTIME_VARS) {
    if (!env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  // Validate DB_DRIVER if specified — reject typos so they don't silently fall back to SQLite
  if (env.DB_DRIVER !== undefined) {
    if (!VALID_DB_DRIVERS.includes(env.DB_DRIVER)) {
      errors.push(
        `DB_DRIVER="${env.DB_DRIVER}" is invalid. Must be one of: ${VALID_DB_DRIVERS.join(', ')}. ` +
        `Check for typos — an unrecognised value does NOT fall back to SQLite; it fails fast instead.`
      );
    }
  }

  // Validate PINATA_GATEWAY if specified — must be a valid HTTPS URL, since
  // IPFS content resolution over plain HTTP is both insecure and, on most
  // gateways, unsupported.
  if (env.PINATA_GATEWAY !== undefined && env.PINATA_GATEWAY.trim() !== '') {
    let isValidHttpsUrl = false;
    try {
      isValidHttpsUrl = new URL(env.PINATA_GATEWAY).protocol === 'https:';
    } catch {
      isValidHttpsUrl = false;
    }
    if (!isValidHttpsUrl) {
      errors.push(`PINATA_GATEWAY="${env.PINATA_GATEWAY}" is invalid. Must be a valid HTTPS URL.`);
    }
  }

  // Validate CORS_ALLOWED_ORIGINS if specified
  const corsOriginsVal = env.CORS_ALLOWED_ORIGINS ?? env.ALLOWED_ORIGINS;
  if (corsOriginsVal !== undefined) {
    if (corsOriginsVal.trim() === '') {
      errors.push('CORS_ALLOWED_ORIGINS cannot be empty when specified');
    } else {
      const origins = corsOriginsVal.split(',').map((s) => s.trim());
      for (const origin of origins) {
        if (!origin) {
          errors.push('CORS_ALLOWED_ORIGINS contains empty origin entry');
        } else if (origin !== '*' && !/^https?:\/\//i.test(origin)) {
          errors.push(`Invalid CORS origin format: "${origin}". Origins must be "*" or start with http:// or https://`);
        }
      }
    }
  }

  return errors;
}

/**
 * Check .env.example entries that have no corresponding process.env.VAR
 * reference anywhere in src/. Stale entries are returned as an array of
 * key names. This is a warning-level check — some variables may be
 * intentionally documented ahead of use or read via a dynamic pattern that
 * the static regex cannot detect.
 *
 * @param {string}   examplePath  Absolute path to .env.example
 * @param {string[]} srcFiles     Absolute paths to the .ts source files to scan
 * @returns {string[]}            Array of stale key names (may be empty)
 */
function findStaleExampleKeys(examplePath, srcFiles) {
  const exampleKeys = fs
    .readFileSync(examplePath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0].trim())
    .filter(Boolean);

  // Collect every env key referenced across all source files
  const referencedKeys = new Set();
  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const codeOnly = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const matches = [...codeOnly.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)];
    for (const [, key] of matches) {
      referencedKeys.add(key);
    }
  }

  return exampleKeys.filter((k) => !referencedKeys.has(k));
}

if (require.main === module) {
  // ─── Runtime check ────────────────────────────────────────────────────────────
  if (process.argv.includes('--runtime')) {
    const errors = validateRuntimeEnv();

    if (errors.length) {
      errors.forEach(e => console.error(`[env] ERROR: ${e}`));
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

  const srcDir = path.resolve(__dirname, '../src');
  const srcFiles = fs
    .readdirSync(srcDir, { recursive: true })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.resolve(srcDir, f));

  // ── Forward check: src/ → .env.example (hard failure) ────────────────────
  const undocumented = [];
  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const codeOnly = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const matches = [...codeOnly.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)];
    for (const [, key] of matches) {
      if (!exampleKeys.has(key)) undocumented.push({ key, file });
    }
  }

  if (undocumented.length) {
    console.error('Missing from .env.example:');
    undocumented.forEach(({ key, file }) => console.error(`  ${key}  (${file})`));
    process.exit(1);
  }

  // ── Reverse check: .env.example → src/ (warning only) ────────────────────
  const staleKeys = findStaleExampleKeys(examplePath, srcFiles);
  if (staleKeys.length) {
    console.warn('Warning: the following .env.example entries have no matching process.env reference in src/:');
    staleKeys.forEach((k) => console.warn(`  ${k}`));
    console.warn('These may be stale or read via a dynamic pattern not detected by static analysis.');
  }

  console.log('Environment validation passed ✓');
}

module.exports = {
  REQUIRED_RUNTIME_VARS,
  VALID_NODE_ENVS,
  VALID_DB_DRIVERS,
  validateRuntimeEnv,
  findStaleExampleKeys,
};
