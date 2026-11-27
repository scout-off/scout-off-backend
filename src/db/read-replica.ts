/** Explicit opt-in, request-scoped reads on monitored PostgreSQL replicas.
 * Never routes transactions, writes, indexer jobs or reads after a signed write marker.
 */
import config from '../config';
import { PostgresDriver } from './postgres-driver';
import type { DbDriver, DbTxHandle } from './driver';
import { canReadReplica } from '../middleware/readYourWrites';

interface ReplicaState { driver: PostgresDriver; healthy: boolean; lagSeconds: number; checkedAt: number }
const states: ReplicaState[] = [];
let nextReplica = 0;
let probeTimer: NodeJS.Timeout | null = null;
export function getReplicaHealth(): {configured: boolean; healthy: boolean; lagSeconds: number | null} {
  if (states.length === 0) return {configured: false, healthy: false, lagSeconds: null};
  const healthy=states.filter(x=>x.healthy && Date.now() - x.checkedAt < 15000);
  return {configured: true, healthy: healthy.length>0, lagSeconds: healthy.length ? Math.min(...healthy.map(x=>x.lagSeconds)) : null};
}
export function chooseReadDriver(primary: DbDriver): DbDriver {
  if (!canReadReplica()) return primary;
  const usable = states.filter(s => s.healthy && Date.now()-s.checkedAt < 15000);
  if (!usable.length) return primary;
  const state=usable[(nextReplica++) % usable.length];
  // Only read methods ever touch a replica. A mistaken mutation against this
  // handle still goes to the primary, and transaction callbacks remain atomic.
  return {
    all: <T>(sql: string, params?: unknown[]) => state.driver.all<T>(sql, params),
    get: <T>(sql: string, params?: unknown[]) => state.driver.get<T>(sql, params),
    value: <T>(sql: string, params?: unknown[]) => state.driver.value<T>(sql, params),
    run: (sql: string, params?: unknown[]) => primary.run(sql, params),
    exec: (sql: string) => primary.exec(sql),
    lockForWrite: (key: string) => primary.lockForWrite(key),
    transaction: <T>(fn: (tx: DbTxHandle) => Promise<T>) => primary.transaction(fn),
    close: () => Promise.resolve(), // Lifecycle is owned by stopReadReplicas().
  };
}
export async function probeReplicas(): Promise<void> {
  const threshold=config.databaseReplicaMaxLagSeconds;
  await Promise.all(states.map(async s => {
    try {
      const result=await s.driver.get<{is_standby: boolean; lag_seconds: number | string | null}>(
        'SELECT pg_is_in_recovery() AS is_standby, EXTRACT(EPOCH FROM (clock_timestamp() - pg_last_xact_replay_timestamp())) AS lag_seconds',
      );
      const lag=Number(result?.lag_seconds);
      s.lagSeconds=lag;
      s.healthy = result?.is_standby === true && result.lag_seconds !== null && Number.isFinite(lag) && lag >= 0 && lag <= threshold;
    } catch {
      s.healthy=false;
      s.lagSeconds=Number.POSITIVE_INFINITY;
    }
    s.checkedAt=Date.now();
  }));
}
export async function startReadReplicas(): Promise<void> {
  if (config.dbDriver !== 'postgres' || states.length>0 || config.databaseReadUrls.length===0) return;
  for (const url of config.databaseReadUrls) {
    const driver=new PostgresDriver(url,config.databaseSsl,config.databasePoolSize,{
      statementTimeoutMs:config.databaseStatementTimeoutMs,
      queryTimeoutMs:config.databaseQueryTimeoutMs,
      idleInTransactionSessionTimeoutMs:config.databaseIdleTransactionTimeoutMs,
    });
    states.push({driver,healthy:false,lagSeconds:Number.POSITIVE_INFINITY,checkedAt:0});
  }
  await probeReplicas(); // Offline replicas never block primary database startup.
  probeTimer=setInterval(() => { void probeReplicas(); },5000);
  probeTimer.unref();
}
export async function stopReadReplicas(): Promise<void> {
  if (probeTimer) clearInterval(probeTimer);
  probeTimer=null;
  await Promise.all(states.splice(0).map(s=>s.driver.close()));
}
