import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import config from '../../src/config';
import { sanitizeEndpointUrl } from '../../src/controllers/healthDependenciesController';
import axios from 'axios';
import * as dbModule from '../../src/db';
import * as redisModule from '../../src/services/redis';
import * as stellarModule from '../../src/services/stellar';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../../src/services/stellar', () => {
  const actual = jest.requireActual('../../src/services/stellar');
  return {
    ...actual,
    stellarHealth: jest.fn().mockResolvedValue(true),
    server: {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 123456 }),
      getNetwork: jest.fn().mockResolvedValue({ protocolVersion: 20, passphrase: 'Test SDF Network ; July 2015' }),
    },
  };
});

function generateToken(role: string, sub = 'GADMINADDRESS1234567890') {
  return jwt.sign({ sub, role }, config.jwtSecret, { expiresIn: '1h' });
}

describe('GET /health/dependencies', () => {
  const adminToken = generateToken('admin');
  const scoutToken = generateToken('scout');

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations for external calls
    mockedAxios.get.mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes(config.horizonUrl)) {
        return {
          status: 200,
          data: { horizon_version: '2.30.0', stellar_core_version: '20.1.0' },
          headers: {},
        } as any;
      }
      return { status: 200, data: {}, headers: {} } as any;
    });

    mockedAxios.head.mockImplementation(async () => {
      return {
        status: 200,
        headers: { server: 'nginx/1.22.1' },
      } as any;
    });
  });

  describe('Security & Access Control', () => {
    it('returns 401 when request is unauthenticated', async () => {
      const res = await request(app).get('/health/dependencies');
      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('returns 403 when authenticated as a non-admin role (e.g. scout)', async () => {
      const res = await request(app)
        .get('/health/dependencies')
        .set('Authorization', `Bearer ${scoutToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient permissions');
    });

    it('allows access when authenticated as admin', async () => {
      const res = await request(app)
        .get('/health/dependencies')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Response Data & Structure', () => {
    it('returns health metrics for all 5 dependencies (stellar, horizon, ipfs, redis, db)', async () => {
      const res = await request(app)
        .get('/health/dependencies')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies).toBeDefined();

      const { stellar, horizon, ipfs, redis, db } = res.body.dependencies;

      // Verify Stellar RPC structure
      expect(stellar).toBeDefined();
      expect(stellar.endpoint).toBeDefined();
      expect(['ok', 'disabled']).toContain(stellar.status);
      expect(stellar.latencyMs === null || typeof stellar.latencyMs === 'number').toBe(true);

      // Verify Horizon structure
      expect(horizon).toBeDefined();
      expect(horizon.endpoint).toBeDefined();
      expect(horizon.version).toBe('2.30.0');
      expect(horizon.status).toBe('ok');
      expect(typeof horizon.latencyMs).toBe('number');

      // Verify IPFS structure
      expect(ipfs).toBeDefined();
      expect(ipfs.endpoint).toBeDefined();
      expect(ipfs.version).toBe('nginx/1.22.1');
      expect(ipfs.status).toBe('ok');
      expect(typeof ipfs.latencyMs).toBe('number');

      // Verify Redis structure (disabled if redisUrl unset in test env)
      expect(redis).toBeDefined();
      expect(redis.endpoint).toBeDefined();
      expect(['ok', 'disabled']).toContain(redis.status);
      expect(redis.latencyMs === null || typeof redis.latencyMs === 'number').toBe(true);

      // Verify DB structure
      expect(db).toBeDefined();
      expect(db.endpoint).toBeDefined();
      expect(db.status).toBe('ok');
      expect(typeof db.latencyMs).toBe('number');
      expect(db.version).toMatch(/SQLite|PostgreSQL|unknown/);
    });

    it('returns stellar ok and latency when stellarHealthCheckEnabled is true', async () => {
      const origEnabled = config.stellarHealthCheckEnabled;
      config.stellarHealthCheckEnabled = true;
      try {
        const res = await request(app)
          .get('/health/dependencies')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body.dependencies.stellar).toBeDefined();
        expect(res.body.dependencies.stellar.endpoint).toBeDefined();
        expect(typeof res.body.dependencies.stellar.latencyMs).toBe('number');
      } finally {
        config.stellarHealthCheckEnabled = origEnabled;
      }
    });

    it('reports status degraded when one dependency fails', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Horizon connection refused'));

      const res = await request(app)
        .get('/health/dependencies')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.dependencies.horizon.status).toBe('error');
      expect(res.body.dependencies.horizon.error).toBe('Horizon connection refused');
      expect(res.body.dependencies.horizon.version).toBeNull();
      expect(typeof res.body.dependencies.horizon.latencyMs).toBe('number');
    });
  });

  describe('sanitizeEndpointUrl helper', () => {
    it('strips credentials from Redis connection URLs', () => {
      const sanitized = sanitizeEndpointUrl('redis://:secretpassword@127.0.0.1:6379/0');
      expect(sanitized).not.toContain('secretpassword');
      expect(sanitized).toContain('***');
    });

    it('strips credentials from PostgreSQL connection URLs', () => {
      const sanitized = sanitizeEndpointUrl('postgres://admin:topsecret@localhost:5432/scoutdb');
      expect(sanitized).not.toContain('topsecret');
      expect(sanitized).not.toContain('admin');
      expect(sanitized).toContain('***');
    });

    it('preserves clean URLs without credentials', () => {
      const sanitized = sanitizeEndpointUrl('https://horizon-testnet.stellar.org');
      expect(sanitized).toContain('https://horizon-testnet.stellar.org');
    });

    it('handles empty input gracefully', () => {
      expect(sanitizeEndpointUrl('')).toBe('');
    });
  });
});
