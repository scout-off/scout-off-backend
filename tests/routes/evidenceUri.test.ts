import request from 'supertest';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { isValidMetadataUri as isValidEvidenceUri } from '../../src/controllers/validatorController';

// Real-world CID fixtures
const VALID_CID_V0  = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const VALID_CID_V1  = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

async function getValidatorToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'validator' });
  return tokenRes.body.token;
}

// ---------------------------------------------------------------------------
// Unit: re-exported helper
// ---------------------------------------------------------------------------
describe('isValidEvidenceUri helper (re-exported from validatorController)', () => {
  it('accepts a bare CIDv0', () => {
    expect(isValidEvidenceUri(VALID_CID_V0)).toBe(true);
  });

  it('accepts a bare CIDv1 (bafy)', () => {
    expect(isValidEvidenceUri(VALID_CID_V1)).toBe(true);
  });

  it('accepts an HTTPS URL', () => {
    expect(isValidEvidenceUri('https://example.com/evidence.json')).toBe(true);
  });

  it('rejects ipfs:// URI (scheme form)', () => {
    expect(isValidEvidenceUri(`ipfs://${VALID_CID_V0}`)).toBe(false);
  });

  it('rejects http:// URI', () => {
    expect(isValidEvidenceUri('http://example.com/evidence')).toBe(false);
  });

  it('rejects a plain string', () => {
    expect(isValidEvidenceUri('not-a-uri')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidEvidenceUri('')).toBe(false);
  });

  it('rejects bare scheme prefixes with no content', () => {
    expect(isValidEvidenceUri('https://')).toBe(false);
    expect(isValidEvidenceUri('ipfs://')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: POST /api/validators/milestone
// ---------------------------------------------------------------------------
describe('POST /api/validators/milestone — evidenceUri validation', () => {
  it('returns 400 for http:// URI', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'http://example.com/evidence' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.details?.[0]?.message).toBe('metadata_uri must be a valid IPFS CID (v0 or v1) or an HTTPS URL');
  });

  it('returns 400 for a plain string URI', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'not-a-uri' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for empty evidenceUri', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: '' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an ipfs:// scheme URI (bare CID required)', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: `ipfs://${VALID_CID_V0}` });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.details?.[0]?.message).toBe('metadata_uri must be a valid IPFS CID (v0 or v1) or an HTTPS URL');
  });

  it('accepts a bare CIDv0 as evidenceUri', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: VALID_CID_V0 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('accepts a bare CIDv1 as evidenceUri', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: VALID_CID_V1 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('accepts an HTTPS URL as evidenceUri', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'https://evidence.example.com/doc.json' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});
