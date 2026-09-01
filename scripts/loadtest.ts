#!/usr/bin/env npx ts-node
/**
 * scripts/loadtest.ts — Load-testing script
 *
 * Exercises the most latency-sensitive endpoints against a locally-running
 * instance with seeded data. Uses autocannon to measure p50/p95/p99 latency
 * and throughput.
 *
 * Usage:
 *   1. Seed the database first:
 *        npx ts-node --project tsconfig.scripts.json scripts/seed.ts
 *   2. Start the server in one terminal:
 *        npm start
 *   3. In another terminal, run the load test:
 *        npx ts-node --project tsconfig.scripts.json scripts/loadtest.ts
 *
 * The script expects the server at LOADTEST_TARGET (default http://localhost:4000).
 * Set LOADTEST_DURATION_SEC (default 30) and LOADTEST_CONNECTIONS (default 20)
 * to adjust the workload.
 *
 * NOTE: This script is intentionally NOT wired into the standard CI pipeline —
 * it is too slow and resource-intensive for every PR. Run it manually before
 * performance-sensitive releases.
 */

import autocannon from 'autocannon';
import { execSync } from 'child_process';

const TARGET = process.env.LOADTEST_TARGET ?? 'http://localhost:4000';
const DURATION = parseInt(process.env.LOADTEST_DURATION_SEC ?? '30', 10);
const CONNECTIONS = parseInt(process.env.LOADTEST_CONNECTIONS ?? '20', 10);
const PLAYER_ID = process.env.LOADTEST_PLAYER_ID ?? 'seed-player-001';

interface Endpoint {
  title: string;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    title: 'GET /api/players (list/filter)',
    method: 'GET',
    path: '/api/players',
  },
  {
    title: 'GET /api/players/:playerId (detail)',
    method: 'GET',
    path: `/api/players/${PLAYER_ID}`,
  },
  {
    title: 'POST /auth/token (auth exchange)',
    method: 'POST',
    path: '/auth/token',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  },
];

function run(endpoint: Endpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: TARGET,
        connections: CONNECTIONS,
        duration: DURATION,
        requests: [
          {
            method: endpoint.method,
            path: endpoint.path,
            headers: endpoint.headers,
            body: endpoint.body,
          },
        ],
        title: endpoint.title,
      },
      (err) => {
        if (err) return reject(err);
        resolve();
      },
    );

    autocannon.track(instance, {
      renderProgressBar: true,
      renderResultsTable: true,
    });
  });
}

function checkServer(): void {
  try {
    const res = execSync(`curl -so /dev/null -w '%{http_code}' ${TARGET}/health`, {
      timeout: 5000,
      encoding: 'utf8',
    });
    if (res.trim() !== '200') {
      throw new Error(`health endpoint returned ${res}`);
    }
  } catch (err) {
    process.stderr.write(
      `\nERROR: Cannot reach ${TARGET}/health — ensure the server is running.\n`,
    );
    process.stderr.write(
      '  Start it with: npm start\n\n',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  ScoutOff — Load Test');
  console.log(`  Target:    ${TARGET}`);
  console.log(`  Duration:  ${DURATION}s per endpoint`);
  console.log(`  Connections: ${CONNECTIONS}`);
  console.log('══════════════════════════════════════════════════\n');

  checkServer();

  for (const ep of ENDPOINTS) {
    console.log(`\n  ── ${ep.title} ──`);
    await run(ep);
  }

  console.log('\n✅ Load test complete.\n');
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
