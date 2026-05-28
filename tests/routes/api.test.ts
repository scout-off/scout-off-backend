import request from 'supertest';
import app from '../../src/index';

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/players', () => {
  it('returns paginated list', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rejects invalid minTier with 400', async () => {
    const res = await request(app).get('/api/players?minTier=99');
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/challenge', () => {
  it('returns challenge XDR for a valid Stellar account', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const account = Keypair.random().publicKey();
    const res = await request(app).get(`/auth/challenge?account=${account}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe('string');
    expect(typeof res.body.networkPassphrase).toBe('string');
  });

  it('returns 400 for missing account', async () => {
    const res = await request(app).get('/auth/challenge');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid Stellar key', async () => {
    const res = await request(app).get('/auth/challenge?account=NOTAVALIDKEY');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /auth/token', () => {
  it('returns JWT after client signs the challenge', async () => {
    const { Keypair, Transaction, Networks } = await import('@stellar/stellar-sdk');
    const clientKeypair = Keypair.random();
    const challengeRes = await request(app).get(
      `/auth/challenge?account=${clientKeypair.publicKey()}`
    );
    const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
    tx.sign(clientKeypair);

    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: tx.toXDR() });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');
    expect(res.body.account).toBe(clientKeypair.publicKey());
  });

  it('returns JWT with validator role when role is specified', async () => {
    const { Keypair, Transaction, Networks } = await import('@stellar/stellar-sdk');
    const clientKeypair = Keypair.random();
    const challengeRes = await request(app).get(
      `/auth/challenge?account=${clientKeypair.publicKey()}`
    );
    const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
    tx.sign(clientKeypair);

    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: tx.toXDR(), role: 'validator' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');
  });

  it('returns 401 for unsigned challenge', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const clientKeypair = Keypair.random();
    const challengeRes = await request(app).get(
      `/auth/challenge?account=${clientKeypair.publicKey()}`
    );

    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: challengeRes.body.challenge });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for missing transaction field', async () => {
    const res = await request(app).post('/auth/token').send({});
    expect(res.status).toBe(400);
  });
});

async function getValidatorToken(): Promise<string> {
  const { Keypair, Transaction, Networks } = await import('@stellar/stellar-sdk');
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'validator' });
  return tokenRes.body.token;
}

async function getPlayerToken(): Promise<string> {
  const { Keypair, Transaction, Networks } = await import('@stellar/stellar-sdk');
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'player' });
  return tokenRes.body.token;
}

describe('GET /api/validators/milestones/pending', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/validators/milestones/pending');
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-validator role', async () => {
    const token = await getPlayerToken();
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns pending milestones for authenticated validator', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('accepts optional region and playerId filters', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=europe&playerId=player-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/validators/milestone', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post('/api/validators/milestone').send({
      playerId: 'player-1',
      milestoneType: 'identity',
      evidenceUri: 'ipfs://QmTest',
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-validator role', async () => {
    const token = await getPlayerToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'ipfs://QmTest' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid request body', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: '', milestoneType: 'unknown' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when evidenceUri is missing', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity' });
    expect(res.status).toBe(400);
  });
});

async function getAdminToken(): Promise<string> {
  const { Keypair, Transaction, Networks } = await import('@stellar/stellar-sdk');
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'admin' });
  return tokenRes.body.token;
}

describe('GET /api/admin/events', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/admin/events');
    expect(res.status).toBe(401);
  });

  it('returns all indexed events for authenticated admin', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('filters events by type query param', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?type=player_registered')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    res.body.data.forEach((e: any) => expect(e.type).toBe('player_registered'));
  });
});

describe('GET /api/admin/fees', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/admin/fees');
    expect(res.status).toBe(401);
  });

  it('returns fee withdrawal history for authenticated admin', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/fees')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Each entry is a full event envelope with ledger and txHash for accounting
    res.body.data.forEach((e: any) => {
      expect(e).toHaveProperty('type', 'fees_withdrawn');
      expect(e).toHaveProperty('ledger');
      expect(e).toHaveProperty('txHash');
      expect(e).toHaveProperty('payload');
    });
  });
});

describe('Error handler middleware', () => {
  it('returns 400 with details array on validation error', async () => {
    const res = await request(app).get('/api/players?minTier=99');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Validation error');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0]).toHaveProperty('path');
    expect(res.body.details[0]).toHaveProperty('message');
  });
});

describe('GET /api/players/:playerId/milestones', () => {
  it('returns milestone history for a player', async () => {
    const res = await request(app).get('/api/players/player-1/milestones');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns empty array for unknown player (no milestones)', async () => {
    const res = await request(app).get('/api/players/nonexistent-player/milestones');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});
