import { ok, paginated, fail, toIso, normalizeTimestamps, sendSuccess, sendError } from '../../src/utils/response';

// ---------------------------------------------------------------------------
// Minimal mock of Express Response used by sendSuccess / sendError tests.
// ---------------------------------------------------------------------------
function makeMockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(data: unknown) { this.body = data; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    set(name: string, value: string) { this.headers[name] = value; return this; },
  };
  return res;
}

describe('response utils', () => {
  describe('ok', () => {
    it('wraps data in a success envelope', () => {
      const result = ok({ id: 1, name: 'Player One' });
      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Player One' },
      });
    });

    it('merges optional meta fields alongside success/data', () => {
      const result = ok({ id: 1 }, { requestId: 'abc-123' });
      expect(result).toEqual({
        success: true,
        data: { id: 1 },
        requestId: 'abc-123',
      });
    });

    it('supports primitive and array data types', () => {
      expect(ok('hello')).toEqual({ success: true, data: 'hello' });
      expect(ok([1, 2, 3])).toEqual({ success: true, data: [1, 2, 3] });
    });

    it('omits meta spread entirely when meta is not provided', () => {
      const result = ok({ id: 1 });
      expect(Object.keys(result)).toEqual(['success', 'data']);
    });
  });

  describe('paginated', () => {
    it('wraps a list with pagination metadata', () => {
      const items = [{ id: 1 }, { id: 2 }];
      const result = paginated(items, 42, 1, 20);
      expect(result).toEqual({
        success: true,
        data: items,
        total: 42,
        page: 1,
        pageSize: 20,
      });
    });

    it('handles an empty page', () => {
      const result = paginated([], 0, 1, 20);
      expect(result).toEqual({
        success: true,
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });
    });

    it('handles a later page number', () => {
      const items = [{ id: 21 }];
      const result = paginated(items, 21, 3, 10);
      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(21);
    });
  });

  describe('fail', () => {
    it('wraps an error message in a failure envelope', () => {
      const result = fail('Player not found');
      expect(result).toEqual({
        success: false,
        error: 'Player not found',
      });
    });

    it('preserves the exact error string passed in', () => {
      const result = fail('Validation failed: wallet address is required');
      expect(result.error).toBe('Validation failed: wallet address is required');
    });
  });

  describe('toIso', () => {
    it('converts a Unix-second timestamp to an ISO 8601 UTC string', () => {
      // 2024-01-01T00:00:00.000Z in Unix seconds
      expect(toIso(1704067200)).toBe('2024-01-01T00:00:00.000Z');
    });

    it('converts Unix epoch (0) correctly', () => {
      expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    });

    it('produces a string ending in Z (UTC) regardless of local timezone', () => {
      const result = toIso(1700000000);
      expect(result.endsWith('Z')).toBe(true);
    });
  });

  describe('normalizeTimestamps', () => {
    it('converts specified numeric fields to ISO strings', () => {
      const payload = { id: 1, createdAt: 1704067200, name: 'test' };
      const result = normalizeTimestamps(payload, ['createdAt']);
      expect(result).toEqual({
        id: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        name: 'test',
      });
    });

    it('converts multiple fields when present', () => {
      const payload = { createdAt: 1704067200, updatedAt: 1704153600 };
      const result = normalizeTimestamps(payload, ['createdAt', 'updatedAt']);
      expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(result.updatedAt).toBe('2024-01-02T00:00:00.000Z');
    });

    it('leaves non-numeric fields untouched', () => {
      const payload = { createdAt: 'already-a-string', id: 5 };
      const result = normalizeTimestamps(payload, ['createdAt']);
      expect(result.createdAt).toBe('already-a-string');
    });

    it('ignores fields not present in the payload', () => {
      const payload = { id: 1 };
      const result = normalizeTimestamps(payload, ['missingField']);
      expect(result).toEqual({ id: 1 });
    });

    it('does not mutate the original payload object', () => {
      const payload = { createdAt: 1704067200 };
      const result = normalizeTimestamps(payload, ['createdAt']);
      expect(payload.createdAt).toBe(1704067200);
      expect(result).not.toBe(payload);
    });

    it('returns an unchanged shallow copy when fields list is empty', () => {
      const payload = { id: 1, createdAt: 1704067200 };
      const result = normalizeTimestamps(payload, []);
      expect(result).toEqual(payload);
      expect(result).not.toBe(payload);
    });
  });

  // -------------------------------------------------------------------------
  // sendSuccess
  // -------------------------------------------------------------------------
  describe('sendSuccess', () => {
    it('sends a 200 response with success envelope by default', () => {
      const res = makeMockRes();
      sendSuccess(res as never, { id: 42, name: 'Player One' });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { id: 42, name: 'Player One' },
      });
    });

    it('sends a custom status code and merges meta into the envelope', () => {
      const res = makeMockRes();
      sendSuccess(res as never, { id: 1 }, 201, { page: 1 });

      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({
        success: true,
        data: { id: 1 },
        page: 1,
      });
    });

    it('sets Content-Type: application/json header', () => {
      const res = makeMockRes();
      sendSuccess(res as never, { ok: true });

      expect(res.headers['Content-Type']).toBe('application/json');
    });
  });

  // -------------------------------------------------------------------------
  // sendError
  // -------------------------------------------------------------------------
  describe('sendError', () => {
    it('sends a 400 response with the error message', () => {
      const res = makeMockRes();
      sendError(res as never, 'Invalid wallet address', 400);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: 'Invalid wallet address',
      });
    });

    it('defaults to status 500 for internal server errors', () => {
      const res = makeMockRes();
      sendError(res as never, 'Something went wrong');

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: 'Something went wrong',
      });
    });

    it('includes an errors array for validation errors when provided', () => {
      const res = makeMockRes();
      sendError(res as never, 'Validation failed', 422, [
        'wallet is required',
        'position must be one of: GK, DEF, MID, FWD',
      ]);

      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({
        success: false,
        error: 'Validation failed',
        errors: ['wallet is required', 'position must be one of: GK, DEF, MID, FWD'],
      });
    });

    it('sets Content-Type: application/json header', () => {
      const res = makeMockRes();
      sendError(res as never, 'Not found', 404);

      expect(res.headers['Content-Type']).toBe('application/json');
    });
  });
});
