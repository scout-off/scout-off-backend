import fs from 'fs';
import path from 'path';

describe('Metrics documentation completeness', () => {
  const metricsSource = fs.readFileSync(path.join(__dirname, '../src/middleware/metrics.ts'), 'utf-8');
  const metricsDoc = fs.readFileSync(path.join(__dirname, '../docs/metrics.md'), 'utf-8');

  const exported = [...metricsSource.matchAll(/# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*)/g)].map((m) => m[1]);

  it('finds the exported metric families', () => {
    expect(exported.length).toBeGreaterThan(0);
  });

  it.each(exported)('documents %s in docs/metrics.md', (name) => {
    expect(metricsDoc).toContain(`\`${name}\``);
  });
});
