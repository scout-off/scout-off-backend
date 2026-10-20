import request from 'supertest';
import app from '../../src/app';

describe('404 fallback handler', () => {
  it('returns 404 JSON for unknown path', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: 'Not Found',
      code: 'NOT_FOUND',
      path: '/api/does-not-exist',
      correlationId: expect.any(String),
    });
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

  it('echoes the X-Correlation-ID header as correlationId', async () => {
    const res = await request(app)
      .get('/api/nonexistent')
      .set('X-Correlation-ID', 'test-corr-id-123');
    expect(res.status).toBe(404);
    expect(res.body.correlationId).toBe('test-corr-id-123');
  });

  it('includes an auto-generated correlationId when no header is sent', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(typeof res.body.correlationId).toBe('string');
    expect(res.body.correlationId.length).toBeGreaterThan(0);
  });

  it('known routes still work normally', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
