import { Request, Response, NextFunction } from 'express';
import { correlationId } from '../../src/middleware/correlationId';
import { getCorrelationId, requestContext } from '../../src/utils/requestContext';
import config from '../../src/config';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers, method: 'GET', path: '/test' } as unknown as Request;
}

function makeRes(): { headers: Record<string, string>; setHeader: jest.Mock } {
  const headers: Record<string, string> = {};
  return { headers, setHeader: jest.fn((k, v) => { headers[k] = v; }) };
}

describe('correlationId middleware', () => {
  it('generates a UUID when no header is present', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    correlationId(req as Request, res as unknown as Response, next);
    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['X-Correlation-ID']).toBe(req.correlationId);
    expect(next).toHaveBeenCalled();
  });

  it('uses incoming X-Correlation-ID header when provided', () => {
    const req = makeReq({ 'x-correlation-id': 'my-custom-id' });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    correlationId(req as Request, res as unknown as Response, next);
    expect(req.correlationId).toBe('my-custom-id');
    expect(res.headers['X-Correlation-ID']).toBe('my-custom-id');
  });

  describe('AsyncLocalStorage context propagation', () => {
    it('makes correlationId available via getCorrelationId() inside next()', (done) => {
      const req = makeReq({ 'x-correlation-id': 'test-cid-123' });
      const res = makeRes();

      const next: NextFunction = () => {
        // Simulates code running downstream in the same async chain.
        expect(getCorrelationId()).toBe('test-cid-123');
        done();
      };

      correlationId(req as Request, res as unknown as Response, next);
    });

    it('propagates correlationId through async continuations', (done) => {
      const req = makeReq({ 'x-correlation-id': 'async-cid-456' });
      const res = makeRes();

      const next: NextFunction = () => {
        // Simulate an async DB/IPFS/webhook call downstream.
        Promise.resolve().then(() => {
          expect(getCorrelationId()).toBe('async-cid-456');
          done();
        });
      };

      correlationId(req as Request, res as unknown as Response, next);
    });

    it('isolates context between concurrent requests', (done) => {
      const req1 = makeReq({ 'x-correlation-id': 'req-aaa' });
      const req2 = makeReq({ 'x-correlation-id': 'req-bbb' });
      const res1 = makeRes();
      const res2 = makeRes();

      let completedCount = 0;

      const next1: NextFunction = () => {
        // Yield to event loop so req2 middleware can run, then check isolation.
        setImmediate(() => {
          expect(getCorrelationId()).toBe('req-aaa');
          if (++completedCount === 2) done();
        });
      };

      const next2: NextFunction = () => {
        setImmediate(() => {
          expect(getCorrelationId()).toBe('req-bbb');
          if (++completedCount === 2) done();
        });
      };

      correlationId(req1 as Request, res1 as unknown as Response, next1);
      correlationId(req2 as Request, res2 as unknown as Response, next2);
    });

    it('returns undefined for getCorrelationId() outside a request context', () => {
      // No requestContext.run() wrapping this call — simulates a background job.
      expect(getCorrelationId()).toBeUndefined();
    });

    it('returns undefined after the request context exits', (done) => {
      const req = makeReq({ 'x-correlation-id': 'scoped-cid' });
      const res = makeRes();
      let capturedInsideId: string | undefined;

      const next: NextFunction = () => {
        capturedInsideId = getCorrelationId();
      };

      correlationId(req as Request, res as unknown as Response, next);

      // After the synchronous run() call completes, the store is gone.
      setImmediate(() => {
        expect(capturedInsideId).toBe('scoped-cid');
        expect(getCorrelationId()).toBeUndefined();
        done();
      });
    });
  });
});

describe('requestContext store (direct)', () => {
  it('getCorrelationId() returns the value set in requestContext.run()', (done) => {
    requestContext.run({ correlationId: 'direct-test' }, () => {
      expect(getCorrelationId()).toBe('direct-test');
      done();
    });
  });
});

describe('logger correlationId injection', () => {
  it('prepends correlationId to log messages inside a request context', () => {
    // config.logLevel defaults to 'warn' under NODE_ENV=test (to keep test
    // output quiet), which makes logger.info() a no-op. Temporarily lower it
    // so we can observe info-level output for this assertion — this test is
    // about the correlationId-injection formatting, not level filtering.
    const originalLevel = config.logLevel;
    config.logLevel = 'debug';
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      requestContext.run({ correlationId: 'logger-cid' }, () => {
        const { logger } = require('../../src/utils/logger');
        logger.info('[ipfs] pin completed');
      });
      expect(spy).toHaveBeenCalledWith(
        '[info]',
        '[cid=logger-cid] [ipfs] pin completed',
      );
    } finally {
      spy.mockRestore();
      config.logLevel = originalLevel;
    }
  });

  it('does not inject correlationId in log messages outside a request context', () => {
    const originalLevel = config.logLevel;
    config.logLevel = 'debug';
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // Ensure we are outside any requestContext by running directly.
      const { logger } = require('../../src/utils/logger');
      logger.info('[indexer] background job tick');
      expect(spy).toHaveBeenCalledWith('[info]', '[indexer] background job tick');
    } finally {
      spy.mockRestore();
      config.logLevel = originalLevel;
    }
  });
});
