import { Request, Response, NextFunction } from 'express';

// Mock @opentelemetry/api so tests run without a real SDK
jest.mock('@opentelemetry/api', () => {
  const makeSpan = (valid: boolean) => ({
    spanContext: () => ({
      traceId: valid ? 'abc123def456abc123def456abc12345' : '00000000000000000000000000000000',
      spanId: valid ? 'abc123def456abc1' : '0000000000000000',
      traceFlags: valid ? 1 : 0,
    }),
  });

  return {
    trace: { getActiveSpan: jest.fn(() => makeSpan(true)) },
    isSpanContextValid: jest.fn((ctx) => ctx.traceFlags === 1),
  };
});

import { AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import { trace, isSpanContextValid } from '@opentelemetry/api';
import { traceId, propagateTraceParent } from '../../src/middleware/traceId';

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
  };
}

describe('traceId middleware (#344)', () => {
  const next = jest.fn() as unknown as NextFunction;

  afterEach(() => jest.clearAllMocks());

  it('sets X-Trace-Id header when active span context is valid', () => {
    const res = makeRes();
    traceId({} as Request, res as unknown as Response, next);
    expect(res.headers['X-Trace-Id']).toBe('abc123def456abc123def456abc12345');
    expect(next).toHaveBeenCalled();
  });

  it('omits X-Trace-Id when span context is invalid (all-zeros)', () => {
    (trace.getActiveSpan as jest.Mock).mockReturnValueOnce({
      spanContext: () => ({
        traceId: '00000000000000000000000000000000',
        spanId: '0000000000000000',
        traceFlags: 0,
      }),
    });
    (isSpanContextValid as jest.Mock).mockReturnValueOnce(false);

    const res = makeRes();
    traceId({} as Request, res as unknown as Response, next);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('omits X-Trace-Id when no active span exists', () => {
    (trace.getActiveSpan as jest.Mock).mockReturnValueOnce(undefined);
    const res = makeRes();
    traceId({} as Request, res as unknown as Response, next);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('propagateTraceParent (#344 outgoing propagation)', () => {
  function makeRequestConfig(): InternalAxiosRequestConfig {
    return { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  }

  it('sets a valid W3C traceparent header when the active span is valid', () => {
    const config = propagateTraceParent(makeRequestConfig());
    expect(config.headers.get('traceparent')).toBe(
      '00-abc123def456abc123def456abc12345-abc123def456abc1-01',
    );
  });

  it('leaves the request untouched when span context is invalid', () => {
    (trace.getActiveSpan as jest.Mock).mockReturnValueOnce({
      spanContext: () => ({
        traceId: '00000000000000000000000000000000',
        spanId: '0000000000000000',
        traceFlags: 0,
      }),
    });
    (isSpanContextValid as jest.Mock).mockReturnValueOnce(false);

    const config = propagateTraceParent(makeRequestConfig());
    expect(config.headers.get('traceparent')).toBeFalsy();
  });

  it('leaves the request untouched when no active span exists', () => {
    (trace.getActiveSpan as jest.Mock).mockReturnValueOnce(undefined);
    const config = propagateTraceParent(makeRequestConfig());
    expect(config.headers.get('traceparent')).toBeFalsy();
  });
});
