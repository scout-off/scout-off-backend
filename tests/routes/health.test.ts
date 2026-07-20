/**
 * Tests for the readiness probe endpoints (/ready and /health/readiness).
 * Both delegates to the shared checkReadiness() helper, so they must return
 * identical responses for the same service states.
 */

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn(),
}));

// Partially mock the db module so individual tests can control getDb and checkDbHealth.
jest.mock('../../src/db', () => {
  const actual = jest.requireActual<typeof import('../../src/db')>('../../src/db');
  return {
    ...actual,
    getDb: jest.fn(actual.getDb),
    checkDbHealth: jest.fn(actual.checkDbHealth),
  };
});

import request from 'supertest';
import app from '../../src/app';
import * as ipfsService from '../../src/services/ipfs';
import * as dbModule from '../../src/db';

const mockCheckHealth = ipfsService.checkHealth as jest.Mock;
const mockGetDb = dbModule.getDb as jest.Mock;
const mockCheckDbHealth = dbModule.checkDbHealth as jest.Mock;

// ─── /ready ──────────────────────────────────────────────────────────────────

const READINESS_PATHS = ['/ready', '/health/readiness'];

describe.each(READINESS_PATHS)('%s', (path) => {
  afterEach(() => {
    mockCheckHealth.mockReset();
    mockGetDb.mockReset();
    mockCheckDbHealth.mockReset();
    // Restore to the real implementation between tests
    mockGetDb.mockImplementation(
      jest.requireActual<typeof import('../../src/db')>('../../src/db').getDb,
    );
    mockCheckDbHealth.mockImplementation(
      jest.requireActual<typeof import('../../src/db')>('../../src/db').checkDbHealth,
    );
  });

  it('returns 200 and includes db:ok when all dependencies are healthy', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.ipfs).toBe('ok');
    expect(res.body.services.db).toBe('ok');
  });

  it('includes db field in the services object', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get('/ready');
    expect(res.body.services).toHaveProperty('db');
    expect(['ok', 'unavailable']).toContain(res.body.services.db);
  });

  it('returns 503 with ipfs:unavailable when IPFS is unreachable', async () => {
    mockCheckHealth.mockRejectedValueOnce(new Error('IPFS connection refused'));
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.ipfs).toBe('unavailable');
  });

  it('returns 503 with db:unavailable when the database probe throws', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    // Simulate a locked or corrupted DB
    mockCheckDbHealth.mockReturnValueOnce({ healthy: false, error: 'SQLITE_BUSY: database is locked' });
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.db).toBe('unavailable');
  });
});

// ─── /health ─────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  afterEach(() => {
    mockGetDb.mockReset();
    mockCheckDbHealth.mockReset();
    mockGetDb.mockImplementation(
      jest.requireActual<typeof import('../../src/db')>('../../src/db').getDb,
    );
    mockCheckDbHealth.mockImplementation(
      jest.requireActual<typeof import('../../src/db')>('../../src/db').checkDbHealth,
    );
  });

  it('returns 200 and includes db field in healthStatus', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.healthStatus).toHaveProperty('db');
    expect(['ok', 'error']).toContain(res.body.healthStatus.db);
  });

  it('includes db:ok when the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.body.healthStatus.db).toBe('ok');
  });

  it('reports db:error in healthStatus but still returns 200 when the DB probe fails', async () => {
    // /health is a liveness probe — it always returns 200.
    // A DB failure is surfaced in healthStatus.db without changing the HTTP status.
    mockCheckDbHealth.mockReturnValueOnce({ healthy: false, error: 'SQLITE_BUSY: database is locked' });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.healthStatus.db).toBe('error');
  });
});

describe('GET /ready and GET /health/readiness return identical responses', () => {
  it('both return ok when IPFS is healthy', async () => {
    mockCheckHealth.mockResolvedValue(undefined);
    const [a, b] = await Promise.all([
      request(app).get('/ready'),
      request(app).get('/health/readiness'),
    ]);
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('both return degraded when IPFS is down', async () => {
    mockCheckHealth.mockRejectedValue(new Error('down'));
    const [a, b] = await Promise.all([
      request(app).get('/ready'),
      request(app).get('/health/readiness'),
    ]);
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});
