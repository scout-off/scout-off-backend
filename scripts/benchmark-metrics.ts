/**
 * Benchmark script for /metrics endpoint performance.
 *
 * Measures how long it takes to scrape /metrics with realistic route cardinality.
 */

import express from 'express';
import http from 'http';
import {
  metricsMiddleware,
  createMetricsHandler,
  resetMetrics,
} from '../src/middleware/metrics';

const PORT = 3000;

async function main() {
  const app = express();
  app.use(metricsMiddleware);

  // Simulate realistic route cardinality (100+ routes)
  const routeCount = 150;
  for (let i = 0; i < routeCount; i++) {
    app.get(`/api/route${i}`, (_req, res) => {
      res.json({ ok: true });
    });
  }

  app.get('/metrics', createMetricsHandler(() => 7));

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`Benchmark server listening on port ${PORT}`);

    // Generate traffic to populate metrics
    console.log(`Generating traffic for ${routeCount} routes...`);
    (async () => {
      for (let i = 0; i < routeCount; i++) {
        try {
          await makeRequest(`GET /api/route${i}`);
        } catch (err) {
          // Ignore errors
        }
      }

      // Warm up
      console.log('Warming up...');
      for (let i = 0; i < 10; i++) {
        try {
          await makeRequest('GET /metrics');
        } catch (err) {
          // Ignore errors
        }
      }

      // Benchmark
      console.log('Benchmarking /metrics endpoint...');
      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        try {
          await makeRequest('GET /metrics');
          const end = Date.now();
          times.push(end - start);
        } catch (err) {
          console.error('Error during benchmark:', err);
        }
      }

      if (times.length === 0) {
        console.error('No successful measurements');
        server.close();
        process.exit(1);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);
      const sorted = [...times].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)]!;
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
      const p99 = sorted[Math.floor(sorted.length * 0.99)]!;

      console.log('\n=== Benchmark Results ===');
      console.log(`Iterations: ${iterations}`);
      console.log(`Route count: ${routeCount}`);
      console.log(`Average: ${avg.toFixed(2)}ms`);
      console.log(`Min: ${min.toFixed(2)}ms`);
      console.log(`Max: ${max.toFixed(2)}ms`);
      console.log(`P50: ${p50.toFixed(2)}ms`);
      console.log(`P95: ${p95.toFixed(2)}ms`);
      console.log(`P99: ${p99.toFixed(2)}ms`);

      // Check if meets the 50ms requirement
      if (p95 < 50) {
        console.log('\n✅ P95 latency is under 50ms requirement');
      } else {
        console.log('\n❌ P95 latency exceeds 50ms requirement');
      }

      server.close();
      process.exit(0);
    })();
  });
}

function makeRequest(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: path.split(' ')[1],
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
