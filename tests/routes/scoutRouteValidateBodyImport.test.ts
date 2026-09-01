/**
 * Regression coverage for src/routes/scout.ts wiring `validateBody` correctly.
 *
 * The trial-offer routes call `validateBody(trialOfferSchema)` as route
 * middleware; if that import were ever removed while the call sites remain,
 * requiring the module throws a ReferenceError at load time and every route
 * in the file becomes unreachable. This guards against that regression
 * independently of any single route's happy-path tests.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

describe('src/routes/scout.ts module wiring', () => {
  it('requires without throwing (validateBody is a resolvable import)', () => {
    expect(() => require('../../src/routes/scout')).not.toThrow();
  });

  it('POST /:wallet/trial-offer responds 400 (not a 500 ReferenceError) for an invalid body', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', detailsUri: 'not-a-valid-uri' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /:wallet/trial-offers responds 400 (not a 500 ReferenceError) for an invalid body', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', detailsUri: 'not-a-valid-uri' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
