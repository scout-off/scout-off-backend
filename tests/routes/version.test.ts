import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../../src/app';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

describe('GET /version', () => {
  it('returns package, process, and environment version information', async () => {
    const res = await request(app).get('/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: pkg.version,
      commit: expect.any(String),
      node: process.version,
      environment: process.env.NODE_ENV ?? 'development',
      startedAt: expect.any(String),
      uptimeSeconds: expect.any(Number),
    });
    expect(new Date(res.body.startedAt).toISOString()).toBe(res.body.startedAt);
    expect(Number.isInteger(res.body.uptimeSeconds)).toBe(true);
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('responds with Cache-Control: no-store', async () => {
    const res = await request(app).get('/version');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('requires no authentication', async () => {
    const res = await request(app).get('/version');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
