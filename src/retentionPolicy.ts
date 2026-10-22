export type RetentionStrategy = 'delete' | 'aggregate-then-delete' | 'archive-with-checkpoint';
export const retentionTargets = {
  profile_views: { column: 'viewed_at', strategy: 'aggregate-then-delete', clock: 'ms', key: 'id' },
  webhook_deliveries: { column: 'created_at', strategy: 'delete', clock: 'ms', key: 'id' },
  security_event_log: { column: 'created_at', strategy: 'delete', clock: 'ms', key: 'id' },
  webhook_dead_letters: { column: 'created_at', strategy: 'delete', clock: 'iso', key: 'id' },
  idempotency_keys: { column: 'expires_at', strategy: 'delete', clock: 'ms', key: 'key' },
  events: { column: 'created_at', strategy: 'delete', clock: 'ms', key: 'id' },
  audit_log: { column: 'created_at', strategy: 'archive-with-checkpoint', clock: 'iso', key: 'id' },
  data_export_jobs: { column: 'expires_at', strategy: 'delete', clock: 'ms', key: 'id' },
} as const;
export interface RetentionPolicy {
  table: keyof typeof retentionTargets;
  column: string;
  days: number;
  strategy: RetentionStrategy;
}
export const defaultRetentionPolicies: RetentionPolicy[] = [
  { table: 'profile_views', column: 'viewed_at', days: 180, strategy: 'aggregate-then-delete' },
  { table: 'webhook_deliveries', column: 'created_at', days: 30, strategy: 'delete' },
  { table: 'security_event_log', column: 'created_at', days: 90, strategy: 'delete' },
  { table: 'webhook_dead_letters', column: 'created_at', days: 90, strategy: 'delete' },
  { table: 'idempotency_keys', column: 'expires_at', days: 0, strategy: 'delete' },
  { table: 'data_export_jobs', column: 'expires_at', days: 0, strategy: 'delete' },
  { table: 'events', column: 'created_at', days: 365, strategy: 'delete' },
  { table: 'audit_log', column: 'created_at', days: 365, strategy: 'archive-with-checkpoint' },
];

/** Identifiers and strategies are allowlisted; configuration never supplies SQL. */
export function parseRetentionPolicies(raw?: string): RetentionPolicy[] {
  const input: unknown = raw === undefined ? defaultRetentionPolicies : JSON.parse(raw);
  if (!Array.isArray(input)) throw new Error('RETENTION_POLICIES must be a JSON array');
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid retention policy');
    const p = item as RetentionPolicy;
    if (!Object.prototype.hasOwnProperty.call(retentionTargets, p.table)) throw new Error(`Unsupported retention table: ${p.table}`);
    const target = retentionTargets[p.table];
    if (p.column !== target.column || p.strategy !== target.strategy || !Number.isSafeInteger(p.days) || p.days < 0 || p.days > 36500) {
      throw new Error(`Invalid retention column, strategy or days for ${p.table}`);
    }
    if ((p.table === 'profile_views' || p.table === 'audit_log') && p.days < 1) throw new Error(`${p.table} retention must be at least one day`);
    if (seen.has(p.table)) throw new Error(`Duplicate retention table: ${p.table}`);
    seen.add(p.table);
    return { table: p.table, column: p.column, days: p.days, strategy: p.strategy };
  });
}
