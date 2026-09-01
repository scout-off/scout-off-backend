import request from 'supertest';
import app from '../../src/app';
import allowlist from '../../src/config/apiVersioning';

const V1_PREFIXES = ['/api', '/api/v1'];
const V2_PREFIX = '/api/v2';

// Representative route paths (root paths or a small, stable subpath).
const ROUTES = [
  '/docs',
  '/players',
  '/scouts',
  '/validators',
  '/admin',
  '/events/stream',
];

function isAllowlisted(path: string): boolean {
  return allowlist.includes(path);
}

describe('API v1/v2 parity', () => {
  it('has the same mounted route set unless explicitly allowlisted', async () => {
    const missingInV2: string[] = [];
    const missingInV1: string[] = [];

    for (const routePath of ROUTES) {
      // Check presence in v1 (either /api or /api/v1)
      let presentInV1 = false;
      for (const prefix of V1_PREFIXES) {
        const res = await request(app).get(`${prefix}${routePath}`);
        if (res.status !== 404) {
          presentInV1 = true;
          break;
        }
      }

      // Check presence in v2
      const resV2 = await request(app).get(`${V2_PREFIX}${routePath}`);
      const presentInV2 = resV2.status !== 404;

      if (presentInV1 && !presentInV2 && !isAllowlisted(routePath)) {
        missingInV2.push(routePath);
      }
      if (presentInV2 && !presentInV1 && !isAllowlisted(routePath)) {
        missingInV1.push(routePath);
      }
    }

    if (missingInV2.length > 0 || missingInV1.length > 0) {
      const parts: string[] = [];
      if (missingInV2.length > 0) parts.push(`Missing in v2: ${missingInV2.join(', ')}`);
      if (missingInV1.length > 0) parts.push(`Missing in v1: ${missingInV1.join(', ')}`);
      throw new Error(`API version parity violation. ${parts.join(' | ')}`);
    }
  });

  it('permits deliberate v2-only divergence (demo route)', async () => {
    const demoPath = '/versioning/demo';
    // v2 should have it
    const r2 = await request(app).get(`${V2_PREFIX}${demoPath}`);
    expect(r2.status).not.toBe(404);
    // v1 should either not have it or be allowlisted
    const r1 = await request(app).get(`/api${demoPath}`);
    if (r1.status !== 404) {
      // If v1 unexpectedly has it, ensure it's not on allowlist.
      expect(isAllowlisted(demoPath)).toBe(true);
    }
  });
});
