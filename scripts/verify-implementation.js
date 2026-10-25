#!/usr/bin/env node

/**
 * Verify that all files for the four backend improvements are in place.
 * 
 * Usage: node scripts/verify-implementation.js
 * 
 * Exit codes:
 *   0 = All files present
 *   1 = One or more files missing
 */

const fs = require('fs');
const path = require('path');

const requiredFiles = [
  // Core implementation
  '.spectral.yaml',
  'scripts/lint-openapi.js',
  'scripts/spectral-rules.js',
  'src/middleware/requestSignal.ts',
  'src/utils/withTimeout.ts',
  'src/services/inMemoryCacheStore.unified.ts',
  'src/config.apiDocs.ts',
  'src/middleware/docs.guard.ts',
  'tests/services/cacheStore.contract.ts',
  
  // Documentation
  'IMPLEMENTATION_PLAN.md',
  'CHANGES.md',
  '.env.additions.md',
  'FILES_CREATED.md',
];

const exampleFiles = [
  'src/controllers/exportController.example.ts',
  'src/routes/docs.example.ts',
  'src/services/safeFetch.example.ts',
  'src/services/stellar.example.ts',
  'src/types/index.ts.patch',
];

const rootDir = path.join(__dirname, '..');

function checkFile(filePath) {
  const fullPath = path.join(rootDir, filePath);
  return fs.existsSync(fullPath);
}

function formatPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

console.log('\n📋 Verifying Backend Improvements Implementation Files\n');

console.log('✓ CORE IMPLEMENTATION FILES (required):');
let allCorePresent = true;
for (const file of requiredFiles) {
  const exists = checkFile(file);
  const status = exists ? '✓' : '✗';
  console.log(`  ${status} ${formatPath(file)}`);
  if (!exists) allCorePresent = false;
}

console.log('\n📚 EXAMPLE/REFERENCE FILES (optional but helpful):');
for (const file of exampleFiles) {
  const exists = checkFile(file);
  const status = exists ? '✓' : '✗';
  console.log(`  ${status} ${formatPath(file)}`);
}

console.log('\n📋 IMPLEMENTATION CHECKLIST:\n');

const checklist = [
  { item: 'OpenAPI linting setup', cmd: 'Check .spectral.yaml and scripts/lint-openapi.js' },
  { item: 'Request signal utilities', cmd: 'Check src/middleware/requestSignal.ts' },
  { item: 'Cache consolidation', cmd: 'Check src/services/inMemoryCacheStore.unified.ts' },
  { item: 'API docs visibility', cmd: 'Check src/config.apiDocs.ts and src/middleware/docs.guard.ts' },
  { item: 'Contract tests', cmd: 'Check tests/services/cacheStore.contract.ts' },
];

for (const { item, cmd } of checklist) {
  console.log(`  □ ${item}`);
  console.log(`    → ${cmd}`);
}

console.log('\n📖 NEXT STEPS:\n');
console.log('  1. Read FILES_CREATED.md for complete inventory');
console.log('  2. Read IMPLEMENTATION_PLAN.md for detailed tasks');
console.log('  3. Read CHANGES.md for integration instructions');
console.log('  4. Follow the integration order in FILES_CREATED.md');
console.log('  5. Use example files as reference during integration');
console.log('  6. Run tests after each phase\n');

if (allCorePresent) {
  console.log('✅ All core implementation files are present!\n');
  process.exit(0);
} else {
  console.log('❌ Some core files are missing. Check the inventory above.\n');
  process.exit(1);
}
