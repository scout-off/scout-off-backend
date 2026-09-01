jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn(),
  checkHealth: jest.fn(),
}));

import request from 'supertest';

describe('CORS origin allowlist', () => {
  const ALLOWED = 'https://app.scoutoff.io';

  beforeAll(() => {
    jest.setTimeout(15000);
  });

  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    // config.ts requires ADMIN_WALLET in production/staging, PLATFORM_SECRET_KEY
    // in every non-test NODE_ENV, and SEP10_SERVER_SECRET in production; these
    // tests reload config under various NODE_ENV values, so all must be present
    // regardless of which env a given test sets.
    process.env.ADMIN_WALLET = 'GADMINWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.PLATFORM_SECRET_KEY = 'SPLATFORMSECRETKEY1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.SEP10_SERVER_SECRET = 'SAHWESRQAKN33CWRZ5AEZW2QYGD2XHOS4HL6CEEH775SXYFZDTD33TMA';
  });

  afterEach(() => {
    delete process.env.ADMIN_WALLET;
    delete process.env.PLATFORM_SECRET_KEY;
    delete process.env.SEP10_SERVER_SECRET;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.ALLOWED_ORIGINS;
    // NODE_ENV is mutated per-test (production/development) to exercise
    // config.ts's env-conditional branches; it must be restored so later
    // test files in the same --runInBand process see the correct 'test' env.
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('allows requests from an origin allowed via CORS_ALLOWED_ORIGINS', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED;

    const { default: app } = await import('../../src/app');
    const res = await request(app).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('blocks requests from an origin rejected via CORS_ALLOWED_ORIGINS', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED;

    const { default: app } = await import('../../src/app');
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://unauthorized.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests from an allowlisted origin in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = ALLOWED;

    const { default: app } = await import('../../src/app');
    const res = await request(app).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('blocks requests from a non-allowlisted origin in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = ALLOWED;

    const { default: app } = await import('../../src/app');
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows wildcard in development without ALLOWED_ORIGINS set', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.ALLOWED_ORIGINS;

    const { default: app } = await import('../../src/app');
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://anything.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('supports multiple allowlisted origins via CORS_ALLOWED_ORIGINS', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.scoutoff.io,https://staging.scoutoff.io';

    const { default: app } = await import('../../src/app');
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://staging.scoutoff.io');
    expect(res.headers['access-control-allow-origin']).toBe('https://staging.scoutoff.io');
  });

  it('returns CORS headers on preflight OPTIONS request for allowed origin', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED;

    const { default: app } = await import('../../src/app');
    const res = await request(app)
      .options('/health')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('omits CORS header on preflight OPTIONS for disallowed origin', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED;

    const { default: app } = await import('../../src/app');
    const res = await request(app)
      .options('/health')
      .set('Origin', 'https://attacker.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
