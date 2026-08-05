import request from 'supertest';
import app from '../../src/app';

/**
 * Tests for the 405 Method Not Allowed handler.
 *
 * Acceptance criteria (#827):
 *  - POST /api/players/:id  → 405 with Allow: GET, PUT
 *  - DELETE /api/auth/token → 405 with Allow: POST
 *  - Unknown paths still return 404
 *  - Response body: { error: 'Method Not Allowed', allowedMethods: string[] }
 */
describe('405 Method Not Allowed', () => {
  // ── Acceptance criteria ──────────────────────────────────────────────────

  it('POST /api/players/:id returns 405 with Allow: GET, PUT (acceptance criteria)', async () => {
    const res = await request(app).post('/api/players/some-player-id');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toEqual(expect.arrayContaining(['GET', 'PUT']));
    const allowHeader = res.headers['allow'] as string;
    expect(allowHeader).toMatch(/GET/);
    expect(allowHeader).toMatch(/PUT/);
  });

  it('DELETE /api/auth/token returns 405 with Allow: POST (acceptance criteria)', async () => {
    const res = await request(app).delete('/auth/token');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('POST');
    expect(res.headers['allow']).toMatch(/POST/);
  });

  it('completely unknown paths still return 404, not 405', async () => {
    const res = await request(app).delete('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not Found', path: '/api/does-not-exist' });
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('response body includes error and allowedMethods fields', async () => {
    const res = await request(app).delete('/api/players');
    expect(res.status).toBe(405);
    expect(res.body).toMatchObject({
      error: 'Method Not Allowed',
      allowedMethods: expect.any(Array),
    });
    expect(Array.isArray(res.body.allowedMethods)).toBe(true);
    expect(res.body.allowedMethods.length).toBeGreaterThan(0);
  });

  it('Allow header matches the allowedMethods array in the response body', async () => {
    const res = await request(app).delete('/api/players');
    expect(res.status).toBe(405);
    const headerMethods = (res.headers['allow'] as string).split(', ').filter(Boolean);
    expect(headerMethods).toEqual(expect.arrayContaining(res.body.allowedMethods));
    expect(res.body.allowedMethods).toEqual(expect.arrayContaining(headerMethods));
  });

  // ── Player routes ─────────────────────────────────────────────────────────

  it('DELETE /api/players returns 405 (only GET is allowed)', async () => {
    const res = await request(app).delete('/api/players');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('GET');
    expect(res.headers['allow']).toMatch(/GET/);
  });

  it('PATCH /api/players returns 405', async () => {
    const res = await request(app).patch('/api/players');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
  });

  it('GET /api/players is still allowed (not 405)', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).not.toBe(405);
  });

  it('DELETE /api/players/:id returns 405 with Allow containing GET and PUT', async () => {
    const res = await request(app).delete('/api/players/some-player-id');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toEqual(expect.arrayContaining(['GET', 'PUT']));
    const allowHeader = res.headers['allow'] as string;
    expect(allowHeader).toMatch(/GET/);
    expect(allowHeader).toMatch(/PUT/);
  });

  it('PATCH /api/players/:id/milestones returns 405', async () => {
    const res = await request(app).patch('/api/players/some-player-id/milestones');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('GET');
  });

  // ── Auth routes ────────────────────────────────────────────────────────────

  it('PATCH /auth/challenge returns 405 with Allow: GET', async () => {
    const res = await request(app).patch('/auth/challenge');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('GET');
    expect(res.headers['allow']).toMatch(/GET/);
  });

  it('GET /auth/token returns 405 with Allow: POST', async () => {
    const res = await request(app).get('/auth/token');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('POST');
    expect(res.headers['allow']).toMatch(/POST/);
  });

  // ── Admin routes ──────────────────────────────────────────────────────────

  it('DELETE /api/admin/fees returns 405 with Allow containing GET and POST', async () => {
    const res = await request(app).delete('/api/admin/fees');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toEqual(expect.arrayContaining(['GET', 'POST']));
    const allowHeader = res.headers['allow'] as string;
    expect(allowHeader).toMatch(/GET/);
    expect(allowHeader).toMatch(/POST/);
  });

  it('DELETE /api/admin/stats returns 405 (only GET is allowed)', async () => {
    const res = await request(app).delete('/api/admin/stats');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('GET');
  });

  // ── Validator routes ──────────────────────────────────────────────────────

  it('DELETE /api/validators/milestone returns 405 (only POST is allowed)', async () => {
    const res = await request(app).delete('/api/validators/milestone');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('POST');
  });

  // ── Scout routes ──────────────────────────────────────────────────────────

  it('DELETE /api/scouts/:wallet/subscription returns 405 (only GET is allowed)', async () => {
    const res = await request(app).delete('/api/scouts/GSCOUT123/subscription');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('GET');
  });

  // ── Health / misc routes that should still work ───────────────────────────

  it('known routes still work normally (GET /health)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('api/v1 prefix also returns 405 for unsupported methods', async () => {
    const res = await request(app).delete('/api/v1/players');
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('Method Not Allowed');
    expect(res.body.allowedMethods).toContain('GET');
  });
});
