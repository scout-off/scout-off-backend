import { Registry, Gauge, Counter } from 'prom-client';

export const register = new Registry();

export const dbPoolActiveConnections = new Gauge({
  name: 'db_pool_active_connections',
  help: 'Number of active (checked-out) PostgreSQL connections in the pool',
  registers: [register],
});

export const dbPoolIdleConnections = new Gauge({
  name: 'db_pool_idle_connections',
  help: 'Number of idle PostgreSQL connections in the pool',
  registers: [register],
});

export const dbPoolErrorTotal = new Counter({
  name: 'db_pool_error_total',
  help: 'Total number of PostgreSQL pool error events',
  registers: [register],
});
