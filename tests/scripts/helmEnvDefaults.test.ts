import fs from 'fs';
import path from 'path';

/**
 * #1567 — the chart's default render must leave the application's own defaults
 * unchanged. Every numeric `parseNumericEnv` default in `src/config.ts` that is
 * also present in `helm/scout-off-backend/values.yaml` must match it exactly.
 *
 * Empty values are intentional: the ConfigMap template skips them so the app
 * falls back to `config.ts` (used for computed defaults such as
 * `MIGRATION_CHECKSUM_MODE`, which depend on NODE_ENV).
 */

const ROOT = path.join(__dirname, '../..');

function valuesEnv(): Map<string, string> {
  const source = fs.readFileSync(path.join(ROOT, 'helm/scout-off-backend/values.yaml'), 'utf-8');
  const envBlock = source.split(/^env:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const entries = new Map<string, string>();
  for (const match of envBlock.matchAll(/^ {2}([A-Z][A-Z0-9_]*):\s*"?([^"\n]*)"?$/gm)) {
    entries.set(match[1], match[2].trim());
  }
  return entries;
}

function configNumericDefaults(): Map<string, number> {
  const source = fs.readFileSync(path.join(ROOT, 'src/config.ts'), 'utf-8');
  const defaults = new Map<string, number>();
  for (const match of source.matchAll(
    /parseNumericEnv\(\s*'([A-Z_]+)'\s*,\s*process\.env\.[A-Z_]+[^,]*,\s*([\d_]+)\s*,/g,
  )) {
    defaults.set(match[1], Number(match[2].replace(/_/g, '')));
  }
  return defaults;
}

describe('Helm env defaults match the application defaults (#1567)', () => {
  it('every numeric value in values.yaml equals its config.ts default', () => {
    const values = valuesEnv();
    const defaults = configNumericDefaults();
    const mismatches: string[] = [];

    for (const [name, defaultValue] of defaults) {
      const chartValue = values.get(name);
      if (chartValue === undefined || chartValue === '') continue;
      if (Number(chartValue) !== defaultValue) {
        mismatches.push(`${name}: values.yaml=${chartValue} config.ts=${defaultValue}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('every env key in values.yaml is uppercase and non-empty or deliberately empty', () => {
    const values = valuesEnv();
    expect(values.size).toBeGreaterThan(100);
    for (const key of values.keys()) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
