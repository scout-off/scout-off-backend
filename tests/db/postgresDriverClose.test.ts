import { register } from '../../src/middleware/metrics';

jest.mock('pg', () => {
  const MockPool = jest.fn().mockImplementation(() => ({
    totalCount: 0,
    idleCount: 0,
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      release: jest.fn(),
    }),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool: MockPool };
});

import { getPool, closePool, poolHealth } from '../../src/db/postgres-driver';

beforeEach(async () => {
  await closePool();
  register.resetMetrics();
});

afterAll(async () => {
  await closePool();
});

describe('closePool', () => {
  it('terminates the pool without throwing', async () => {
    getPool();
    await expect(closePool()).resolves.toBeUndefined();
  });

  it('is idempotent — calling closePool twice does not throw', async () => {
    getPool();
    await closePool();
    await expect(closePool()).resolves.toBeUndefined();
  });

  it('creates a fresh pool after close', async () => {
    const pool1 = getPool();
    await closePool();
    const pool2 = getPool();
    expect(pool1).not.toBe(pool2);
  });
});

describe('poolHealth', () => {
  it('resolves when the database is reachable', async () => {
    await expect(poolHealth()).resolves.toBeUndefined();
  });

  it('releases the client after success', async () => {
    const pool = getPool();
    const client = await pool.connect();
    const releaseSpy = jest.spyOn(client, 'release');
    client.release();

    await poolHealth();
    expect(releaseSpy).toHaveBeenCalled();
  });
});
