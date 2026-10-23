#!/usr/bin/env node

/**
 * Check optimized WASM contract sizes against budgets.
 *
 * Reads contracts/wasm-size-budgets.json and verifies each built .wasm file
 * does not exceed its budget. Fails CI if any contract exceeds its limit.
 *
 * Outputs to GitHub step summary with:
 *  - Contract name
 *  - Size in bytes
 *  - Budget in bytes
 *  - Percentage used
 *  - PASS/FAIL indicator
 *
 * Usage:
 *   node scripts/check-contract-wasm-size.js [--base-summary path/to/base-summary.txt]
 *
 * --base-summary: Optional path to a previous step-summary for delta calculation on PRs.
 *                 If provided, the script will print size deltas vs. the base.
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// ─── Configuration ────────────────────────────────────────────────────────────

const WASM_DIR = 'contracts/target/wasm32-unknown-unknown/release';
const BUDGETS_FILE = 'contracts/wasm-size-budgets.json';
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY || '/dev/stdout';
const IS_PR = process.env.GITHUB_EVENT_NAME === 'pull_request';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse size from a line in a previous step-summary.
 * Line format: | `scout_off_register.wasm` | 45000 | 60000 | 75% |
 */
function parseSummaryLine(line) {
  const match = line.match(/`([^`]+)`\s*\|\s*(\d+)/);
  if (match) {
    return { name: match[1], size: parseInt(match[2], 10) };
  }
  return null;
}

/**
 * Load base sizes from a previous summary file (for PR delta calculation).
 */
function loadBaseSizes(baseSummaryPath) {
  if (!fs.existsSync(baseSummaryPath)) {
    console.warn(`[warn] Base summary not found at ${baseSummaryPath}`);
    return {};
  }

  const content = fs.readFileSync(baseSummaryPath, 'utf-8');
  const sizes = {};
  for (const line of content.split('\n')) {
    const parsed = parseSummaryLine(line);
    if (parsed) {
      sizes[parsed.name] = parsed.size;
    }
  }
  return sizes;
}

/**
 * Format bytes as a human-readable size with units.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Return a status indicator (✓ or ✗) based on usage percentage.
 */
function statusIndicator(percentUsed) {
  return percentUsed > 100 ? '✗' : '✓';
}

/**
 * Format delta with sign and highlight.
 */
function formatDelta(current, base) {
  if (base === undefined) return '—';
  const delta = current - base;
  const sign = delta > 0 ? '+' : '';
  const pct = base > 0 ? ((delta / base) * 100).toFixed(1) : '0.0';
  return `${sign}${delta} bytes (${sign}${pct}%)`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // Parse CLI args
  let baseSummaryPath = null;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--base-summary' && i + 1 < process.argv.length) {
      baseSummaryPath = process.argv[++i];
    }
  }

  // Load budgets
  if (!fs.existsSync(BUDGETS_FILE)) {
    console.error(`[error] Budgets file not found: ${BUDGETS_FILE}`);
    process.exit(1);
  }

  let budgets;
  try {
    budgets = JSON.parse(fs.readFileSync(BUDGETS_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[error] Failed to parse ${BUDGETS_FILE}:`, err.message);
    process.exit(1);
  }

  const defaultBudget = budgets._default || 65000;
  delete budgets._default;
  delete budgets._comment;

  // Find WASM files
  let wasmFiles;
  try {
    wasmFiles = glob.sync(path.join(WASM_DIR, '*.wasm')).sort();
  } catch (err) {
    console.error(`[error] Failed to glob WASM files:`, err.message);
    process.exit(1);
  }

  if (wasmFiles.length === 0) {
    console.error(`[error] No optimized WASM contracts found in ${WASM_DIR}`);
    process.exit(1);
  }

  // Load base sizes if provided
  const baseSizes = baseSummaryPath ? loadBaseSizes(baseSummaryPath) : {};

  // Check each WASM file
  const results = [];
  let anyExceeded = false;

  for (const wasmFile of wasmFiles) {
    const fileName = path.basename(wasmFile);
    const fileSize = fs.statSync(wasmFile).size;
    const budget = budgets[fileName] ?? defaultBudget;
    const percentUsed = (fileSize / budget) * 100;
    const exceeded = fileSize > budget;
    const baseSize = baseSizes[fileName];

    if (exceeded) {
      anyExceeded = true;
    }

    results.push({
      fileName,
      fileSize,
      budget,
      percentUsed,
      exceeded,
      baseSize,
    });
  }

  // Write to GitHub step summary
  const summary = [];
  summary.push('### 📦 Soroban Contract WASM Sizes');
  summary.push('');

  if (IS_PR && Object.keys(baseSizes).length > 0) {
    summary.push('| Contract | Size | Budget | Usage | Status | Delta vs Base |');
    summary.push('|---|---:|---:|---:|:---:|---|');
  } else {
    summary.push('| Contract | Size | Budget | Usage | Status |');
    summary.push('|---|---:|---:|---:|:---:|');
  }

  for (const result of results) {
    const {
      fileName, fileSize, budget, percentUsed, exceeded, baseSize,
    } = result;
    const status = statusIndicator(percentUsed);
    const usage = `${percentUsed.toFixed(1)}%`;
    const sizeStr = formatBytes(fileSize);
    const budgetStr = formatBytes(budget);

    if (IS_PR && Object.keys(baseSizes).length > 0) {
      const delta = formatDelta(fileSize, baseSize);
      summary.push(
        `| \`${fileName}\` | ${sizeStr} | ${budgetStr} | ${usage} | ${status} | ${delta} |`
      );
    } else {
      summary.push(
        `| \`${fileName}\` | ${sizeStr} | ${budgetStr} | ${usage} | ${status} |`
      );
    }
  }

  summary.push('');
  summary.push('**Soroban deploy limit:** 65 KB per contract');
  summary.push('');

  if (anyExceeded) {
    summary.push('⚠️ **One or more contracts exceed their budget.** See details above.');
    summary.push('To raise a budget, edit `contracts/wasm-size-budgets.json` and request reviewer approval in your PR.');
  } else {
    summary.push('✓ All contracts within budget.');
  }

  // Write summary
  const summaryText = summary.join('\n');
  if (GITHUB_STEP_SUMMARY === '/dev/stdout') {
    console.log(summaryText);
  } else {
    fs.appendFileSync(GITHUB_STEP_SUMMARY, `${summaryText}\n`);
  }

  // Exit with failure if any exceeded
  if (anyExceeded) {
    console.error('[error] One or more WASM contracts exceed their budget');
    process.exit(1);
  }

  process.exit(0);
}

main();
