#!/usr/bin/env node
/**
 * One-off backfill CLI script.
 *
 * Resets the indexer's stored last_ledger to the given value so the next
 * poll cycle replays all contract events from that ledger onward.
 *
 * Usage:
 *   node scripts/backfill.js --backfill <fromLedger>
 *
 * Example:
 *   node scripts/backfill.js --backfill 5000000
 */

require('dotenv').config();

const idx = process.argv.indexOf('--backfill');
if (idx === -1 || !process.argv[idx + 1]) {
  console.error('Usage: node scripts/backfill.js --backfill <fromLedger>');
  process.exit(1);
}

const fromLedger = parseInt(process.argv[idx + 1], 10);
if (isNaN(fromLedger) || fromLedger < 0) {
  console.error('Error: fromLedger must be a non-negative integer');
  process.exit(1);
}

// Ensure required env vars are set before requiring config
if (!process.env.CONTRACT_ID) process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
if (!process.env.JWT_SECRET)   process.env.JWT_SECRET  = 'backfill-script';

// Guard: check that the compiled output exists before attempting to require it.
// A raw MODULE_NOT_FOUND error gives no hint that 'npm run build' is the fix.
const distDbPath = require('path').resolve(__dirname, '../dist/db');
const fs = require('fs');
if (!fs.existsSync(distDbPath)) {
  console.error(
    'Error: compiled output not found at dist/db.\n' +
    'Run "npm run build" first, then re-run this script.'
  );
  process.exit(1);
}

const { initDb, getLastLedger, setLastLedger } = require('../dist/db');

initDb();
const previous = getLastLedger();
setLastLedger(fromLedger);
console.log(`Backfill: reset last_ledger from ${previous} to ${fromLedger}`);
console.log('The next indexer poll will replay events from ledger', fromLedger);
