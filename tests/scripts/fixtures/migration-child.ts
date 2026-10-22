import { migrateSqliteToPostgres } from '../../../scripts/migrate-sqlite-to-postgres';

void migrateSqliteToPostgres({
  sqlitePath: process.env.MIGRATION_SOURCE!,
  databaseUrl: process.env.MIGRATION_TARGET!,
  batchSize: 1,
  onBatch: async (table, copied) => {
    if (table !== 'events' || copied !== 1) return;
    process.send?.({ type: 'committed' });
    // Parent kills the process after an acknowledged commit, before the next batch.
    await new Promise<void>(() => undefined);
  },
}).catch(error => {
  process.send?.({ type: 'error', message: String(error) });
  process.exitCode = 1;
});
