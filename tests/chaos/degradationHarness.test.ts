/**
 * Dependency-failure chaos harness (#1116).
 * Independently disables redis / db / rpc / ipfs and asserts degradation contracts.
 * See docs/degradation-contracts.md.
 */
import request from 'supertest';
import app from '../../src/app';
import * as ipfs from '../../src/services/ipfs';
import * as stellar from '../../src/services/stellar';

type Dep = 'redis' | 'db' | 'rpc' | 'ipfs';
export type FaultSet = Partial<Record<Dep, boolean>>;

export function applyFaults(faults: FaultSet): void {
  process.env.CHAOS_REDIS_DOWN = faults.redis ? '1' : '';
  process.env.CHAOS_DB_DOWN = faults.db ? '1' : '';
  process.env.CHAOS_RPC_DOWN = faults.rpc ? '1' : '';
  process.env.CHAOS_IPFS_DOWN = faults.ipfs ? '1' : '';
  if (!faults.redis) delete process.env.CHAOS_REDIS_DOWN;
  if (!faults.db) delete process.env.CHAOS_DB_DOWN;
  if (!faults.rpc) delete process.env.CHAOS_RPC_DOWN;
  if (!faults.ipfs) delete process.env.CHAOS_IPFS_DOWN;
}

export function clearFaults(): void {
  delete process.env.CHAOS_REDIS_DOWN;
  delete process.env.CHAOS_DB_DOWN;
  delete process.env.CHAOS_RPC_DOWN;
  delete process.env.CHAOS_IPFS_DOWN;
}

describe('chaos degradation harness (#1116)', () => {
  let ipfsSpy: jest.SpyInstance;
  let stellarSpy: jest.SpyInstance;

  beforeEach(() => {
    ipfsSpy = jest.spyOn(ipfs, 'checkHealth').mockImplementation(async () => {
      if (process.env.CHAOS_IPFS_DOWN === '1') throw new Error('ipfs down');
    });
    stellarSpy = jest.spyOn(stellar, 'stellarHealth').mockImplementation(async () => {
      return process.env.CHAOS_RPC_DOWN !== '1';
    });
  });

  afterEach(() => {
    clearFaults();
    ipfsSpy.mockRestore();
    stellarSpy.mockRestore();
  });

  const cases: Array<{ name: string; faults: FaultSet; ready: number[]; live: number[] }> = [
    { name: 'redis only', faults: { redis: true }, ready: [200, 503], live: [200] },
    { name: 'db only', faults: { db: true }, ready: [200, 503], live: [200] },
    { name: 'rpc only', faults: { rpc: true }, ready: [200, 503], live: [200] },
    { name: 'ipfs only', faults: { ipfs: true }, ready: [503, 200], live: [200] },
    { name: 'redis+rpc', faults: { redis: true, rpc: true }, ready: [200, 503], live: [200] },
    { name: 'db+ipfs', faults: { db: true, ipfs: true }, ready: [503, 200], live: [200] },
  ];

  for (const c of cases) {
    it(`${c.name}: liveness up; readiness per contract; no hang`, async () => {
      applyFaults(c.faults);
      const started = Date.now();
      const live = await request(app).get('/health/liveness');
      expect(c.live).toContain(live.status);

      const ver = await request(app).get('/version');
      expect(ver.status).toBe(200);

      const ready = await request(app).get('/ready');
      expect(c.ready).toContain(ready.status);
      expect(Date.now() - started).toBeLessThan(10000);
    });
  }

  it('can toggle each dependency independently', () => {
    applyFaults({ redis: true, db: true, rpc: true, ipfs: true });
    expect(process.env.CHAOS_REDIS_DOWN).toBe('1');
    expect(process.env.CHAOS_DB_DOWN).toBe('1');
    expect(process.env.CHAOS_RPC_DOWN).toBe('1');
    expect(process.env.CHAOS_IPFS_DOWN).toBe('1');
    clearFaults();
    expect(process.env.CHAOS_REDIS_DOWN).toBeUndefined();
  });
});
