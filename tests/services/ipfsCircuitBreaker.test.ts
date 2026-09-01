/**
 * Tests for issue #1142: circuit breaker around IPFS / Pinata calls.
 */
process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = 'test-secret';
process.env.PINATA_API_KEY = 'test-key';
process.env.PINATA_SECRET = 'test-secret-pinata';

import axios from 'axios';
import { ipfsBreaker } from '../../src/services/ipfs';
import { pinJson, pinFile, checkHealth } from '../../src/services/ipfs';
import { CircuitBreakerOpenError } from '../../src/utils/circuitBreaker';

jest.mock('axios');
const mockAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  ipfsBreaker.reset();
  jest.clearAllMocks();
});

describe('CircuitBreaker — unit', () => {
  it('starts closed', () => {
    expect(ipfsBreaker.getState()).toBe('closed');
  });

  it('opens after threshold failures', async () => {
    const breaker = new (await import('../../src/utils/circuitBreaker')).CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      resetTimeoutMs: 60000,
    });
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('open');
  });

  it('fast-fails when open', async () => {
    const breaker = new (await import('../../src/utils/circuitBreaker')).CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 60000,
    });
    await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    );
  });

  it('moves to half-open after resetTimeoutMs', async () => {
    const breaker = new (await import('../../src/utils/circuitBreaker')).CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 0,
    });
    await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    expect(breaker.getState()).toBe('half-open');
  });

  it('closes again after a successful half-open probe', async () => {
    const breaker = new (await import('../../src/utils/circuitBreaker')).CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 0,
    });
    await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    // now half-open — successful probe should close it
    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opens on failure in half-open state', async () => {
    const breaker = new (await import('../../src/utils/circuitBreaker')).CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 0,
    });
    await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    // half-open probe fails → back to open
    await breaker.execute(() => Promise.reject(new Error('still failing'))).catch(() => {});
    expect(breaker.getState()).toBe('open');
  });
});

describe('pinJson — circuit breaker integration', () => {
  it('calls Pinata and returns CID when breaker is closed', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: { IpfsHash: 'QmTestCid' } });
    const cid = await pinJson({ test: 1 });
    expect(cid).toBe('QmTestCid');
  });

  it('propagates Pinata errors and counts failures', async () => {
    mockAxios.post.mockRejectedValue(new Error('Pinata 503'));
    await expect(pinJson({ test: 1 })).rejects.toThrow('Pinata 503');
  });

  it('throws CircuitBreakerOpenError after threshold failures', async () => {
    mockAxios.post.mockRejectedValue(new Error('Pinata down'));
    // exhaust threshold (default 5)
    for (let i = 0; i < 5; i++) {
      await pinJson({}).catch(() => {});
    }
    await expect(pinJson({})).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });
});

describe('pinFile — circuit breaker integration', () => {
  it('throws CircuitBreakerOpenError when breaker is already open', async () => {
    // force open
    mockAxios.post.mockRejectedValue(new Error('Pinata down'));
    for (let i = 0; i < 5; i++) {
      await pinJson({}).catch(() => {});
    }
    await expect(
      pinFile(Buffer.from('data'), 'test.jpg', 'image/jpeg')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });
});

describe('checkHealth — breaker awareness', () => {
  it('reports unavailable immediately when breaker is open', async () => {
    // Force breaker open
    mockAxios.post.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 5; i++) {
      await pinJson({}).catch(() => {});
    }
    await expect(checkHealth()).rejects.toThrow('circuit breaker is open');
  });

  it('calls Pinata test endpoint when breaker is closed', async () => {
    mockAxios.get = jest.fn().mockResolvedValueOnce({ data: { message: 'Congratulations!' } });
    await expect(checkHealth()).resolves.toBeUndefined();
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('testAuthentication'),
      expect.anything()
    );
  });
});
