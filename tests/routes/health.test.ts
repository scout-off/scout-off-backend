/**
 * Tests for the /ready readiness probe endpoint.
 * The IPFS service is stubbed so no real network calls are made.
 */

// Stub the ipfs service before app is imported so the /ready handler
// uses the mock implementation throughout these tests.
process.env.STELLAR_HEALTH_CHECK = 'false';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn(),
}));

import request from 'supertest';
import app from '../../src/index';
import * as ipfsService from '../../src/services/ipfs';

const mockCheckHealth = ipfsService.checkHealth as jest.Mock;

describe('GET /ready', () => {
  afterEach(() => {
    mockCheckHealth.mockReset();
  });

  it('returns 200 with ipfs:ok when IPFS is reachable', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.ipfs).toBe('ok');
  });

  it('returns 503 with ipfs:unavailable when IPFS is unreachable', async () => {
    mockCheckHealth.mockRejectedValueOnce(new Error('IPFS connection refused'));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.ipfs).toBe('unavailable');
  });
});
