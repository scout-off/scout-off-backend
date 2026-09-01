import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

describe('Malformed JSON body guarding', () => {
  it('returns 400 and correlationId for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/players/register')
      .set('Content-Type', 'application/json')
      .set('x-correlation-id', 'test-malformed-id')
      .send('{"invalid": json'); // Sending raw malformed string

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Malformed JSON payload');
    expect(res.body.correlationId).toBe('test-malformed-id');
  });

  it('returns 400 for valid JSON that fails validation (Zod) and includes correlationId', async () => {
    const token = jwt.sign({ sub: 'G' + 'A'.repeat(55), role: 'player' }, SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .set('x-correlation-id', 'test-zod-id')
      .send({ wallet: 'too-short' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.correlationId).toBe('test-zod-id');
  });

  it('returns 415 when a body is sent without an application/json Content-Type', async () => {
    const token = jwt.sign({ sub: 'G' + 'A'.repeat(55), role: 'player' }, SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .set('x-correlation-id', 'test-no-content-type-id')
      // Raw string body with no prior Content-Type set — the HTTP client defaults
      // to application/x-www-form-urlencoded, the common "forgot to set it" case.
      .send('wallet=abc&position=Midfielder&region=West+Africa');

    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Content-Type must be application/json');
    expect(res.body.correlationId).toBe('test-no-content-type-id');
  });

  it('returns 415 for an incorrect Content-Type header on a JSON-body route', async () => {
    const token = jwt.sign({ sub: 'G' + 'A'.repeat(55), role: 'player' }, SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .set('x-correlation-id', 'test-wrong-content-type-id')
      .send(JSON.stringify({ wallet: 'G' + 'A'.repeat(55), position: 'Midfielder', region: 'West Africa', metadata: {} }));

    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Content-Type must be application/json');
    expect(res.body.correlationId).toBe('test-wrong-content-type-id');
  });
});
