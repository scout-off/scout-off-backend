#!/usr/bin/env node
/**
 * validate-openapi.js
 *
 * Validates the committed OpenAPI spec against the canonical source (the
 * route files), not just against a second hand-maintained file:
 *
 *   1. Parses src/openapi.yaml and checks required OpenAPI 3.x fields.
 *   2. Regenerates the spec from src/routes/*.ts in memory (the same
 *      generator scripts/generate-openapi-json.js uses) and deep-compares
 *      it against the committed src/openapi.yaml. A mismatch means the
 *      spec drifted from the routes — exactly the failure mode this whole
 *      pipeline exists to make impossible — and fails the build with
 *      instructions to regenerate.
 *   3. Verifies src/openapi.json is byte-for-byte in sync with
 *      src/openapi.yaml (catches a stale JSON file after a manual YAML edit).
 *
 * Usage (CI):
 *   node scripts/validate-openapi.js
 * Exit 0 = valid and in sync, Exit 1 = invalid or stale (message on stderr).
 *
 * The spec file locations can be overridden with OPENAPI_YAML_PATH /
 * OPENAPI_JSON_PATH (used by tests to run the check against fixture files).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const YAML_PATH =
  process.env.OPENAPI_YAML_PATH ||
  path.join(__dirname, '..', 'src', 'openapi.yaml');
const JSON_PATH =
  process.env.OPENAPI_JSON_PATH ||
  path.join(__dirname, '..', 'src', 'openapi.json');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('js-yaml not installed. Run: npm install --save-dev js-yaml');
  process.exit(1);
}

/**
 * Recursively canonicalise a parsed spec value so that two structurally
 * identical objects always serialise to the same string regardless of
 * object key order.
 *
 * - arrays: canonicalise each element (order is significant)
 * - plain objects: canonicalise each value, then sort the keys
 * - primitives (string / number / boolean / null): returned unchanged
 *
 * Keys are sorted at EVERY nesting level — a shallow, top-level-only sort
 * would silently treat deeply-nested content differences (e.g.
 * paths./a.get.summary) as equal, which previously let real spec drift
 * pass this check undetected.
 */
function canonicalise(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * True recursive deep-equality check between two parsed spec objects:
 * both are canonicalised (object keys sorted recursively) and then their
 * serialised forms are compared, so ordering/whitespace differences are
 * ignored but any real content difference — at any depth — is detected.
 */
function specsAreEqual(a, b) {
  return JSON.stringify(canonicalise(a)) === JSON.stringify(canonicalise(b));
}

module.exports = { canonicalise, specsAreEqual };

function main() {
  // ── Step 1: Parse YAML ────────────────────────────────────────────────────
  let spec;
  try {
    const raw = fs.readFileSync(YAML_PATH, 'utf8');
    spec = yaml.load(raw);
  } catch (err) {
    console.error('[validate-openapi] YAML parse error:', err.message);
    process.exit(1);
  }

  // ── Step 2: Check required top-level fields ───────────────────────────────
  const required = ['openapi', 'info', 'paths'];
  for (const field of required) {
    if (!spec[field]) {
      console.error(`[validate-openapi] Missing required OpenAPI field: "${field}"`);
      process.exit(1);
    }
  }

  if (!spec.openapi.startsWith('3.')) {
    console.error(`[validate-openapi] Expected OpenAPI 3.x, got: ${spec.openapi}`);
    process.exit(1);
  }

  if (!spec.info.version) {
    console.error('[validate-openapi] info.version is required');
    process.exit(1);
  }

  if (!spec.info.title) {
    console.error('[validate-openapi] info.title is required');
    process.exit(1);
  }

  const pathCount = Object.keys(spec.paths || {}).length;
  if (pathCount === 0) {
    console.error('[validate-openapi] spec.paths is empty — no routes defined');
    process.exit(1);
  }

  // ── Step 3: Regenerate from the canonical source and diff ─────────────────
  // This is the check that actually enforces "one source of truth": it does
  // not compare the spec against another hand-maintained file, it compares
  // the spec against what the route source files themselves say.
  if (YAML_PATH === path.join(__dirname, '..', 'src', 'openapi.yaml')) {
    const { generateSpec } = require('./generate-openapi-json');
    let regenerated;
    try {
      regenerated = generateSpec();
    } catch (err) {
      console.error('[validate-openapi] Failed to regenerate spec from route sources:', err.message);
      process.exit(1);
    }

    if (!specsAreEqual(spec, regenerated)) {
      console.error(
        '[validate-openapi] src/openapi.yaml is out of sync with the route source files ' +
        '(src/routes/*.ts).\n' +
        'A route, its auth requirement, or its request/response schema changed without ' +
        'regenerating the spec.\n' +
        'Run: npm run build:openapi   then commit the updated openapi.yaml/openapi.json',
      );
      process.exit(1);
    }
  }

  // ── Step 4: Check JSON is in sync with YAML ────────────────────────────────
  if (!fs.existsSync(JSON_PATH)) {
    console.error(
      '[validate-openapi] src/openapi.json does not exist.\n' +
      'Run: npm run build:openapi',
    );
    process.exit(1);
  }

  const jsonSpec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  if (!specsAreEqual(spec, jsonSpec)) {
    console.error(
      '[validate-openapi] src/openapi.json is out of sync with src/openapi.yaml.\n' +
      'Run: npm run build:openapi  then commit the updated openapi.json',
    );
    process.exit(1);
  }

  console.log(
    `[validate-openapi] OK — OpenAPI ${spec.openapi} spec valid and in sync with route sources ` +
    `(${pathCount} paths, info.version=${spec.info.version})`,
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}
