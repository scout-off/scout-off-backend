jest.mock('pg', () => {
  const MockPool = jest.fn().mockImplementation((_config) => ({
    _config,
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

import { closePool } from '../../src/db/postgres-driver';

beforeEach(async () => {
  await closePool();
});

afterAll(async () => {
  await closePool();
});

function getConfig(sslEnv: string) {
  const prev = process.env.DATABASE_SSL;
  process.env.DATABASE_SSL = sslEnv;

  // Re-import to pick up the new env var
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/config');
  const cfg = mod.default;

  process.env.DATABASE_SSL = prev ?? 'false';
  return cfg;
}

describe('SSL configuration', () => {
  it('DATABASE_SSL=true sets rejectUnauthorized: true', () => {
    const cfg = getConfig('true');
    expect(cfg.databaseSsl).toEqual({ rejectUnauthorized: true });
  });

  it('DATABASE_SSL=no-verify sets rejectUnauthorized: false', () => {
    const cfg = getConfig('no-verify');
    expect(cfg.databaseSsl).toEqual({ rejectUnauthorized: false });
  });

  it('DATABASE_SSL=false disables SSL', () => {
    const cfg = getConfig('false');
    expect(cfg.databaseSsl).toBe(false);
  });

  it('DATABASE_SSL unset defaults to false', () => {
    const cfg = getConfig('');
    expect(cfg.databaseSsl).toBe(false);
  });

  it('Pool receives ssl config from environment', async () => {
    const prev = process.env.DATABASE_SSL;
    process.env.DATABASE_SSL = 'true';
    await closePool();
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getPool: freshGetPool } = require('../../src/db/postgres-driver');
    const pool = freshGetPool();
    expect(pool._config.ssl).toEqual({ rejectUnauthorized: true });
    process.env.DATABASE_SSL = prev ?? 'false';
  });
});
