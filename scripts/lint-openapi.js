#!/usr/bin/env node

/**
 * Run Spectral linting on the OpenAPI spec with the project ruleset.
 * Exit with non-zero if there are errors, allowing CI to fail the build.
 *
 * Usage:
 *   npm run lint:openapi
 *   npm run lint:openapi -- --fix  (not yet supported by Spectral)
 */

const { execSync } = require('child_process');
const path = require('path');

const specPath = path.join(__dirname, '..', 'src', 'openapi.yaml');
const rulesetPath = path.join(__dirname, '..', '.spectral.yaml');

try {
  // Run spectral with the project ruleset
  // Exit code: 0 = no violations, 1 = warnings only, 2 = errors
  execSync(
    `spectral lint "${specPath}" --ruleset "${rulesetPath}"`,
    { stdio: 'inherit', shell: true }
  );
  console.log('\n✓ OpenAPI spec passed Spectral linting');
  process.exit(0);
} catch (err) {
  // Spectral exits with code 2 for errors, 1 for warnings
  if (err.status === 2) {
    console.error('\n✗ OpenAPI spec has linting errors');
    process.exit(2);
  } else if (err.status === 1) {
    console.warn('\n⚠ OpenAPI spec has linting warnings');
    process.exit(0); // Warnings don't fail the build; adjust as needed
  } else {
    throw err;
  }
}
