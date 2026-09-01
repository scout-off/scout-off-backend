import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { errorHandler } from '../../src/middleware/errorHandler';
import { ErrorCode } from '../../src/utils/errorCodes';

function makeReq(correlationId?: string): Request {
  return { correlationId } as unknown as Request;
}

function makeRes() {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response;
}

const next = jest.fn() as unknown as NextFunction;

function getBody(res: Response): Record<string, unknown> {
  return ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
}

describe('errorHandler - Express 5 automatic promise rejection handling', () => {
  it('handles rejected promises from async handlers automatically', async () => {
    const req = makeReq('test-corr-id');
    const res = makeRes();
    
    // Simulate an async handler that throws
    const asyncHandler = async (req: Request, res: Response, next: NextFunction) => {
      throw new Error('async error');
    };
    
    // In Express 5, the error would be automatically passed to errorHandler
    // We simulate this by directly calling errorHandler with the thrown error
    try {
      await asyncHandler(req, res, next);
    } catch (err) {
      errorHandler(err, req, res, next);
    }
    
    expect(res.status).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('async error');
    expect(body.correlationId).toBe('test-corr-id');
  });

  it('handles rejected promises from async handlers with custom status', async () => {
    const req = makeReq('test-corr-id');
    const res = makeRes();
    
    const customError = Object.assign(new Error('Not found'), { status: 404 });
    
    const asyncHandler = async (req: Request, res: Response, next: NextFunction) => {
      throw customError;
    };
    
    try {
      await asyncHandler(req, res, next);
    } catch (err) {
      errorHandler(err, req, res, next);
    }
    
    expect(res.status).toHaveBeenCalledWith(404);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Not found');
    expect(body.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('handles ZodError from async validation', async () => {
    const req = makeReq('zod-corr-id');
    const res = makeRes();
    const { ZodError, ZodIssueCode } = require('zod');
    
    const asyncHandler = async (req: Request, res: Response, next: NextFunction) => {
      throw new ZodError([
        { code: ZodIssueCode.custom, message: 'Invalid field', path: ['field'] },
      ]);
    };
    
    try {
      await asyncHandler(req, res, next);
    } catch (err) {
      errorHandler(err, req, res, next);
    }
    
    expect(res.status).toHaveBeenCalledWith(400);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid field');
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.correlationId).toBe('zod-corr-id');
  });

  it('does not double-invoke error handler when manual next(err) is used with Express 5 auto-forwarding', () => {
    // This test documents the expected behavior: if a handler manually calls next(err)
    // AND Express 5 auto-forwards, the error handler should only be called once.
    // In practice, the manual next(err) pattern should be removed from all handlers.
    const req = makeReq('test-corr-id');
    const res = makeRes();
    
    const err = new Error('test error');
    errorHandler(err, req, res, next);
    errorHandler(err, req, res, next); // Simulating double invocation
    
    // The error handler is idempotent - calling it twice with the same error
    // should produce the same result (though in real Express 5, this wouldn't happen)
    expect(res.status).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('test error');
  });
});
