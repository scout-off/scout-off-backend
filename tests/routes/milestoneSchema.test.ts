import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';

async function getValidatorToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'validator' });
  return tokenRes.body.token;
}

describe('POST /api/validators/milestone schema validation (#29)', () => {
  let token: string;

  beforeAll(async () => {
    token = await getValidatorToken();
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ milestoneType: 'identity', evidenceUri: 'ipfs://abc' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when milestoneType is invalid', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player1', milestoneType: 'invalid_type', evidenceUri: 'ipfs://abc' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when evidenceUri is missing', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player1', milestoneType: 'identity' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('accepts valid body with required fields', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player1', milestoneType: 'performance', evidenceUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('accepts valid body with optional notes and validatorComment', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({
        playerId: 'player1',
        milestoneType: 'trial_offer',
        evidenceUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        notes: 'Exceptional performance',
        validatorComment: 'Approved by coach',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});
