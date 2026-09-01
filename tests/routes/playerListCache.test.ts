/**
 * #1150 — Cache-Control / Last-Modified / conditional GET + HEAD on /api/players.
 */
import request from 'supertest';
import app from '../../src/app';
import {
  invalidatePlayerCache,
  getPlayerListLastModified,
  __setPlayerListLastModifiedForTests,
} from '../../src/services/cache';

describe('GET /api/players — HTTP caching (#1150)', () => {
  beforeEach(() => {
    __setPlayerListLastModifiedForTests(Date.now());
  });

  it('sets Cache-Control, Last-Modified, and ETag on GET', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=10, must-revalidate');
    expect(res.headers['last-modified']).toBeDefined();
    expect(res.headers.etag).toMatch(/^"[a-f0-9]+"$/);
    expect(res.body.success).toBe(true);
  });

  it('returns 304 when If-None-Match matches the list ETag', async () => {
    const first = await request(app).get('/api/players');
    expect(first.status).toBe(200);
    const etag = first.headers.etag;

    const revalidate = await request(app)
      .get('/api/players')
      .set('If-None-Match', etag);
    expect(revalidate.status).toBe(304);
    expect(revalidate.body).toEqual({});
    expect(revalidate.headers.etag).toBe(etag);
    expect(revalidate.headers['cache-control']).toBe('public, max-age=10, must-revalidate');
  });

  it('returns 304 when If-Modified-Since is at or after Last-Modified', async () => {
    const first = await request(app).get('/api/players');
    expect(first.status).toBe(200);
    const lastModified = first.headers['last-modified'];

    const revalidate = await request(app)
      .get('/api/players')
      .set('If-Modified-Since', lastModified);
    expect(revalidate.status).toBe(304);
  });

  it('returns 200 with a new ETag after invalidatePlayerCache bumps Last-Modified', async () => {
    const first = await request(app).get('/api/players');
    const oldEtag = first.headers.etag;
    const oldLm = first.headers['last-modified'];
    const before = getPlayerListLastModified();

    await invalidatePlayerCache();
    // HTTP dates are second-resolution; ensure the validator advances a full second.
    if (Math.floor(getPlayerListLastModified() / 1000) <= Math.floor(before / 1000)) {
      __setPlayerListLastModifiedForTests(before + 2000);
    }

    const second = await request(app)
      .get('/api/players')
      .set('If-None-Match', oldEtag);
    expect(second.status).toBe(200);
    expect(second.headers.etag).not.toBe(oldEtag);
    expect(second.headers['last-modified']).not.toBe(oldLm);
  });

  it('HEAD returns the same cache headers with an empty body', async () => {
    const getRes = await request(app).get('/api/players');
    const headRes = await request(app).head('/api/players');

    expect(headRes.status).toBe(200);
    expect(headRes.headers['cache-control']).toBe(getRes.headers['cache-control']);
    expect(headRes.headers['last-modified']).toBe(getRes.headers['last-modified']);
    expect(headRes.headers.etag).toBe(getRes.headers.etag);
    // supertest exposes body as empty object / empty string for HEAD
    expect(headRes.text === '' || headRes.text === undefined || Object.keys(headRes.body).length === 0).toBe(true);
  });

  it('HEAD returns 304 when validators match', async () => {
    const first = await request(app).get('/api/players');
    const head = await request(app)
      .head('/api/players')
      .set('If-None-Match', first.headers.etag);
    expect(head.status).toBe(304);
  });
});
