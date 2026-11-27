const ROWS_DELETED = 'scout_off_retention_rows_deleted_total';
const LAST_RUN = 'scout_off_retention_last_run_timestamp_seconds';

// The module keeps process-wide state, so each test loads a fresh copy.
let metrics: typeof import('../../src/services/retentionMetrics');

beforeEach(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  metrics = require('../../src/services/retentionMetrics');
});

function sample(lines: string[], metric: string, table: string): string | undefined {
  return lines.find((line) => line.startsWith(`${metric}{table="${table}"} `));
}

function value(lines: string[], metric: string, table: string): number {
  const line = sample(lines, metric, table);
  if (line === undefined) throw new Error(`missing sample ${metric}{table="${table}"}`);
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('retentionMetrics', () => {
  it('exports HELP and TYPE lines exactly once per metric', () => {
    metrics.recordRetentionRun('profiles', 3);
    metrics.recordRetentionRun('audit_log', 1);
    const lines = metrics.retentionMetrics();

    for (const metric of [ROWS_DELETED, LAST_RUN]) {
      expect(lines.filter((line) => line.startsWith(`# HELP ${metric} `))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith(`# TYPE ${metric} `))).toHaveLength(1);
    }
    expect(lines).toContain(`# TYPE ${ROWS_DELETED} counter`);
    expect(lines).toContain(`# TYPE ${LAST_RUN} gauge`);
  });

  it('emits no samples before any run is recorded', () => {
    const lines = metrics.retentionMetrics();
    expect(lines.filter((line) => !line.startsWith('#'))).toEqual([]);
  });

  it('records a single successful run', () => {
    const before = Date.now() / 1000;
    metrics.recordRetentionRun('profiles', 7);
    const after = Date.now() / 1000;
    const lines = metrics.retentionMetrics();

    expect(value(lines, ROWS_DELETED, 'profiles')).toBe(7);
    const lastRun = value(lines, LAST_RUN, 'profiles');
    expect(lastRun).toBeGreaterThanOrEqual(before);
    expect(lastRun).toBeLessThanOrEqual(after);
  });

  it('accumulates deleted rows across runs for the same table', () => {
    metrics.recordRetentionRun('profiles', 2);
    metrics.recordRetentionRun('profiles', 5);
    metrics.recordRetentionRun('profiles', 1);
    const lines = metrics.retentionMetrics();

    expect(value(lines, ROWS_DELETED, 'profiles')).toBe(8);
    expect(lines.filter((line) => line.startsWith(`${ROWS_DELETED}{`))).toHaveLength(1);
  });

  it('tracks multiple tables independently', () => {
    metrics.recordRetentionRun('profiles', 4);
    metrics.recordRetentionRun('audit_log', 9);
    const lines = metrics.retentionMetrics();

    expect(value(lines, ROWS_DELETED, 'profiles')).toBe(4);
    expect(value(lines, ROWS_DELETED, 'audit_log')).toBe(9);
    expect(lines.filter((line) => line.startsWith(`${ROWS_DELETED}{`))).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith(`${LAST_RUN}{`))).toHaveLength(2);
  });

  it('does not advance the last-run timestamp on a failed run', () => {
    metrics.recordRetentionRun('profiles', 3);
    const successful = value(metrics.retentionMetrics(), LAST_RUN, 'profiles');

    metrics.recordRetentionRun('profiles', 0, false);
    const lines = metrics.retentionMetrics();

    expect(value(lines, LAST_RUN, 'profiles')).toBe(successful);
    expect(value(lines, ROWS_DELETED, 'profiles')).toBe(3);
  });

  it('keeps the last-run timestamp at zero when every run fails', () => {
    metrics.recordRetentionRun('profiles', 0, false);
    const lines = metrics.retentionMetrics();

    expect(value(lines, LAST_RUN, 'profiles')).toBe(0);
    expect(value(lines, ROWS_DELETED, 'profiles')).toBe(0);
  });

  it('escapes quotes, backslashes and newlines in label values', () => {
    metrics.recordRetentionRun('weird"table\\name\nx', 1);
    const lines = metrics.retentionMetrics();

    expect(lines).toContain(`${ROWS_DELETED}{table="weird\\"table\\\\name\\nx"} 1`);
    // The gauge value is a timestamp, so match the escaped label prefix only.
    expect(lines.some((l) => l.startsWith(`${LAST_RUN}{table="weird\\"table\\\\name\\nx"} `))).toBe(
      true,
    );
  });
});
