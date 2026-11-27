#!/usr/bin/env node

/**
 * Persisted Operations Generator
 *
 * Scans a directory for GraphQL documents and generates a persisted operations
 * JSON file with SHA-256 hashes.
 *
 * Usage:
 *   node scripts/generate-persisted-ops.js <input-dir> <output-file>
 *
 * Input directory should contain .graphql files with operation definitions.
 * Output is a JSON file: { "hash": "document", ... }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate SHA-256 hash of a GraphQL document.
 */
function getHash(document) {
  return crypto.createHash('sha256').update(document).digest('hex');
}

/**
 * Extract operation name and type from a GraphQL document.
 */
function extractOperationInfo(document) {
  // Match: query/mutation/subscription name(params) { ... }
  const match = document.match(/^(query|mutation|subscription)\s+(\w+)(?:\([^)]*\))?\s*\{/m);
  if (match) {
    return {
      type: match[1],
      name: match[2],
    };
  }
  return null;
}

/**
 * Process a directory of .graphql files and generate persisted operations.
 */
function generatePersistedOperations(inputDir, outputFile) {
  console.log(`[persisted-ops] Scanning ${inputDir} for GraphQL files...`);

  const ops = {};
  let processed = 0;

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.graphql') || entry.name.endsWith('.gql'))
      ) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const hash = getHash(content);
          const info = extractOperationInfo(content);

          ops[hash] = content;
          processed++;

          if (info) {
            console.log(`  ✓ ${info.type} ${info.name} → ${hash.substring(0, 8)}...`);
          } else {
            console.log(`  ✓ File: ${entry.name} → ${hash.substring(0, 8)}...`);
          }
        } catch (err) {
          console.error(`  ✗ Failed to process ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  scanDir(inputDir);

  // Write output file
  fs.writeFileSync(outputFile, JSON.stringify(ops, null, 2));

  console.log(``);
  console.log(`[persisted-ops] Generated ${processed} operation(s) in ${outputFile}`);
  console.log(
    `[persisted-ops] Total hash collisions: ${Object.keys(ops).length - processed} (if any)`,
  );
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node scripts/generate-persisted-ops.js <input-dir> <output-file>');
  console.error('');
  console.error('Example:');
  console.error(
    '  node scripts/generate-persisted-ops.js src/frontend/graphql dist/graphql/persisted-operations.registry.json',
  );
  process.exit(1);
}

const inputDir = args[0];
const outputFile = args[1];

if (!fs.existsSync(inputDir)) {
  console.error(`Error: Input directory not found: ${inputDir}`);
  process.exit(1);
}

// Resolve output path relative to current directory
const resolvedOutput = path.resolve(outputFile);
const outputDir = path.dirname(resolvedOutput);

// Create output directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`[persisted-ops] Created output directory: ${outputDir}`);
}

generatePersistedOperations(inputDir, resolvedOutput);

console.log('');
console.log('[persisted-ops] Done!');
