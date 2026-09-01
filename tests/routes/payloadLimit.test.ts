import request from 'supertest';
import app from '../../src/app';

describe('JSON Payload Size Limit', () => {
  it('accepts valid payloads within the global limit', async () => {
    const validPayload = {
      wallet: 'G'.repeat(56),
      position: 'striker',
      region: 'europe',
      metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    };

    const res = await request(app)
      .post('/api/players/register')
      .send(validPayload);

    // Should not return 413
    expect(res.status).not.toBe(413);
  });

  it('accepts a 5 MB body on /api/players/register (upload limit 10 MB)', async () => {
    const payload = {
      wallet: 'G'.repeat(56),
      data: 'x'.repeat(5 * 1024 * 1024),
    };

    const res = await request(app)
      .post('/api/players/register')
      .send(payload);

    expect(res.status).not.toBe(413);
  });

  it('rejects a 2 KB body on /auth/token (auth limit 1 KB)', async () => {
    const oversizedPayload = {
      data: 'x'.repeat(2 * 1024),
    };

    const res = await request(app)
      .post('/auth/token')
      .set('Content-Type', 'application/json')
      .send(oversizedPayload);

    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('Payload too large');
  });

  it('rejects a 1.5 MB body on a standard endpoint (global limit 1 MB)', async () => {
    const largePayload = {
      data: 'x'.repeat(1.5 * 1024 * 1024),
    };

    const res = await request(app)
      .post('/api/players')
      .set('Content-Type', 'application/json')
      .send(largePayload);

    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error');
  });

  it('returns appropriate error shape for oversized payloads', async () => {
    const largePayload = {
      data: 'x'.repeat(1.5 * 1024 * 1024),
    };

    const res = await request(app)
      .post('/api/players')
      .set('Content-Type', 'application/json')
      .send(largePayload);

    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body).toHaveProperty('success', false);
  });
});
