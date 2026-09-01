import request from 'supertest';
import app from '../../src/app';

describe('404 fallback handler', () => {
  it('returns 404 JSON for unknown path', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not Found', path: '/api/does-not-exist' });
  });

  it('returns application/json content-type for unknown path', async () => {
    const res = await request(app).get('/unknown/route');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.status).toBe(404);
  });

  it('includes the requested path in the response body', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not Found', path: '/api/nonexistent' });
  });

  it('known routes still work normally', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
