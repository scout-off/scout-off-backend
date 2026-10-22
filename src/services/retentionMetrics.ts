// Kept independent of the DB and metrics middleware to avoid import cycles.
const totals = new Map<string, { deleted: number; lastRun: number }>();
export function recordRetentionRun(table: string, deleted: number, completed = true): void {
  const previous = totals.get(table) ?? { deleted: 0, lastRun: 0 };
  totals.set(table, { deleted: previous.deleted + deleted, lastRun: completed ? Date.now() / 1000 : previous.lastRun });
}
export function retentionMetrics(): string[] {
  const lines = [
    '# HELP scout_off_retention_rows_deleted_total Rows deleted by retention since process start',
    '# TYPE scout_off_retention_rows_deleted_total counter',
    '# HELP scout_off_retention_last_run_timestamp_seconds Last successful retention sweep',
    '# TYPE scout_off_retention_last_run_timestamp_seconds gauge',
  ];
  for (const [table, metrics] of totals) {
    lines.push(`scout_off_retention_rows_deleted_total{table="${table}"} ${metrics.deleted}`);
    lines.push(`scout_off_retention_last_run_timestamp_seconds{table="${table}"} ${metrics.lastRun}`);
  }
  return lines;
}
