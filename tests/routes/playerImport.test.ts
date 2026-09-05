/**
 * Tests for POST /api/admin/players/import
 *
 * Covers the acceptance criteria from issue #483:
 *  - Valid entries are registered through the existing single-registration
 *    schema/pin/upsert path
 *  - One invalid row doesn't abort the batch — a per-row result summary is
 *    returned instead of an all-or-nothing response
 *  - Mixed valid/invalid batches work correctly for both JSON and CSV bodies
 *  - Batch size is capped and rejected with a clear error
 *  - Auth guards (401 / 403) are enforced
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { parsePlayerCsvBody, processPlayerImportBatch } from '../../src/controllers/adminPlayerImportController';
import config from '../../src/config';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  invalidatePlayerCache: jest.fn().mockResolvedValue(undefined),
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const ADMIN_WALLET = 'G' + 'M'.repeat(55);

/** Generate a syntactically valid (registerSchema-passing) Stellar-shaped wallet. */
function randomWallet(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let s = 'G';
  for (let i = 0; i < 55; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function validEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    wallet: randomWallet(),
    position: 'striker',
    region: 'europe',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    ...overrides,
  };
}

// ─── Unit tests: parsePlayerCsvBody ────────────────────────────────────────────

describe('parsePlayerCsvBody()', () => {
  it('parses a wallet,position,region,metadataUri row', () => {
    const wallet = randomWallet();
    const result = parsePlayerCsvBody(`${wallet},striker,europe,QmCid1`);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ wallet, position: 'striker', region: 'europe', metadataUri: 'QmCid1' });
  });

  it('skips empty lines and comment lines', () => {
    const wallet = randomWallet();
    const result = parsePlayerCsvBody(`\n# comment\n${wallet},striker,europe,QmCid1\n\n`);
    expect(result).toHaveLength(1);
  });

  it('skips a header row starting with "wallet" (case-insensitive)', () => {
    const wallet = randomWallet();
    const result = parsePlayerCsvBody(`wallet,position,region,metadataUri\n${wallet},striker,europe,QmCid1`);
    expect(result).toHaveLength(1);
    expect(result[0].wallet).toBe(wallet);
  });

  it('handles Windows CRLF line endings', () => {
    const [w1, w2] = [randomWallet(), randomWallet()];
    const result = parsePlayerCsvBody(`${w1},striker,europe,QmCid1\r\n${w2},keeper,asia,QmCid2`);
    expect(result).toHaveLength(2);
  });

  it('returns an empty array for blank input', () => {
    expect(parsePlayerCsvBody('')).toHaveLength(0);
    expect(parsePlayerCsvBody('   ')).toHaveLength(0);
  });
});

// ─── Unit tests: processPlayerImportBatch ──────────────────────────────────────

describe('processPlayerImportBatch()', () => {
  it('registers a valid entry and returns its playerId', async () => {
    const entry = validEntry();
    const results = await processPlayerImportBatch([entry]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].playerId).toEqual(expect.any(String));
    expect(results[0].wallet).toBe(entry.wallet);
  });

  it('reports a schema validation failure without throwing', async () => {
    const results = await processPlayerImportBatch([{ wallet: 'too-short', position: 'striker', region: 'europe', metadataUri: 'QmCid1' }]);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toBeDefined();
  });

  it('processes a mixed batch, isolating the failure to its own row', async () => {
    const good = validEntry();
    const bad = { wallet: 'nope' };
    const results = await processPlayerImportBatch([good, bad]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('error');
  });
});

// ─── Integration tests: POST /api/admin/players/import ───────────────────────

describe('POST /api/admin/players/import — auth guards', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/api/admin/players/import')
      .send({ players: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const token = makeToken(ADMIN_WALLET, 'scout');
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: [validEntry()] });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/players/import — JSON body', () => {
  it('returns 400 when players field is missing', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an empty players array', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: [] });
    expect(res.status).toBe(400);
  });

  it('registers a single valid player and returns its playerId', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const entry = validEntry();
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: [entry] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(res.body.data.results[0].status).toBe('success');
    expect(res.body.data.results[0].playerId).toEqual(expect.any(String));
    expect(res.body.data.results[0].metadataUri).toBe(entry.metadataUri);
  });

  it('pins raw metadata via pinJson when metadataUri is not provided', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const entry = { wallet: randomWallet(), position: 'keeper', region: 'asia', metadata: { height: 190 } };
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: [entry] });
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe('success');
    expect(res.body.data.results[0].metadataUri).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
  });

  it('does not abort the batch when one row fails validation', async () => {
    const good = validEntry();
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: [good, { wallet: 'too-short' }] });
    expect(res.status).toBe(200); // whole request succeeds
    expect(res.body.data.summary.total).toBe(2);
    expect(res.body.data.summary.succeeded).toBe(1);
    expect(res.body.data.summary.failed).toBe(1);
    const failedEntry = res.body.data.results.find((r: { status: string }) => r.status === 'error');
    expect(failedEntry.error).toBeDefined();
  });

  it('rejects a batch larger than the configured maximum', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const oversized = Array.from({ length: config.playerImport.maxBatchSize + 1 }, () => validEntry());
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: oversized });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/maximum/i);
  });
});

describe('POST /api/admin/players/import — CSV body', () => {
  it('returns 400 when CSV body is empty', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send('');
    expect(res.status).toBe(400);
  });

  it('registers players from CSV rows', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const [w1, w2] = [randomWallet(), randomWallet()];
    const csv = `${w1},striker,europe,QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG\n${w2},keeper,asia,QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdH`;
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.succeeded).toBe(2);
  });

  it('skips the CSV header row automatically', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const wallet = randomWallet();
    const csv = `wallet,position,region,metadataUri\n${wallet},striker,europe,QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`;
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(1);
    expect(res.body.data.results[0].wallet).toBe(wallet);
  });

  it('handles mixed valid/invalid rows in CSV', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const wallet = randomWallet();
    const csv = `${wallet},striker,europe,QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG\ntoo-short,keeper,asia,QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdH`;
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.succeeded).toBe(1);
    expect(res.body.data.summary.failed).toBe(1);
  });

  it('also works with Content-Type: text/plain', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const wallet = randomWallet();
    const res = await request(app)
      .post('/api/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .send(`${wallet},striker,europe,QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.succeeded).toBe(1);
  });
});

describe('POST /api/admin/players/import — reachable under both API prefixes', () => {
  it('is also reachable under /api/v1/admin/players/import', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/v1/admin/players/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ players: [validEntry()] });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.succeeded).toBe(1);
  });
});
