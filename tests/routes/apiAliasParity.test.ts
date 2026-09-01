import request from 'supertest';
import app from '../../src/app';

// One representative path per router mounted in the app.ts loop over
// [API_PREFIX, API_V1_PREFIX]. If a new router is added to that loop but a
// path is missing from either prefix, this test catches the drift.
const ROUTES = [
  '/docs',
  '/players',
  '/scouts',
  '/validators',
  '/admin',
  '/events/stream',
];

describe('API /api vs /api/v1 alias parity', () => {
  it.each(ROUTES)('%s responds identically under /api and /api/v1', async (routePath) => {
    const [legacy, v1] = await Promise.all([
      request(app).get(`/api${routePath}`),
      request(app).get(`/api/v1${routePath}`),
    ]);

    expect(v1.status).toBe(legacy.status);
    expect(v1.type).toBe(legacy.type);
  });
});
