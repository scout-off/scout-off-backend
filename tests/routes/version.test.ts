import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../../src/app';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

describe('GET /version', () => {
  it('returns the package version, commit, Node.js version, and environment', async () => {
    const res = await request(app).get('/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: pkg.version,
      commit: expect.any(String),
      node: process.version,
      environment: process.env.NODE_ENV ?? 'development',
    });
  });

  it('requires no authentication', async () => {
    const res = await request(app).get('/version');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
