/**
 * Consolidated test ensuring that all error responses (404, method not allowed,
 * handler errors, malformed JSON) are consistently returned as application/json
 * with the documented error shape: { success: false, error: string, code: string }
 *
 * This test probes several failure modes to protect the invariant that API clients
 * should never receive an HTML error page.
 */

import request from 'supertest';
import app from '../../src/app';
import { ErrorCode } from '../../src/utils/errorCodes';

/**
 * Helper to validate the error response shape.
 * All error responses must have:
 *  - success: false
 *  - error: string (human-readable message)
 *  - code: string (machine-readable ErrorCode)
 *  - correlationId: optional string
 */
function expectValidErrorResponse(body: unknown): asserts body is {
  success: false;
  error: string;
  code: string;
  correlationId?: string;
} {
  expect(body).toBeDefined();
  expect(typeof body === 'object' && body !== null).toBe(true);
  const obj = body as Record<string, unknown>;
  expect(obj.success).toBe(false);
  expect(typeof obj.error).toBe('string');
  expect(obj.error).toBeTruthy();
  expect(typeof obj.code).toBe('string');
  expect(obj.code).toBeTruthy();
  // correlationId is optional
  if (obj.correlationId !== undefined) {
    expect(typeof obj.correlationId).toBe('string');
  }
}

describe('Error Response Consistency — application/json invariant', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Failure Mode 1: Unknown Route (404)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Unknown path (404 catch-all)', () => {
    it('returns application/json for GET /nonexistent', async () => {
      const res = await request(app).get('/nonexistent');
      expect(res.status).toBe(404);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('returns application/json for POST /api/nonexistent', async () => {
      const res = await request(app)
        .post('/api/nonexistent')
        .send({ data: 'test' });
      expect(res.status).toBe(404);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('returns application/json for PUT /some/deep/nonexistent/path', async () => {
      const res = await request(app).put('/some/deep/nonexistent/path');
      expect(res.status).toBe(404);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('returns application/json for DELETE with nonexistent path', async () => {
      const res = await request(app).delete('/api/nonexistent/resource');
      expect(res.status).toBe(404);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Failure Mode 2: Method Not Allowed
  // (e.g., GET on a POST-only endpoint, or POST on a GET-only endpoint)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Method not allowed / wrong HTTP verb', () => {
    it('returns application/json for GET /api/players/register (POST-only)', async () => {
      const res = await request(app).get('/api/players/register');
      // Route defines .all(methodNotAllowed(['POST'])) → 405 for a wrong verb
      expect(res.status).toBe(405);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
    });

    it('returns application/json for PATCH /api/players/register (POST-only)', async () => {
      const res = await request(app)
        .patch('/api/players/register')
        .send({});
      expect(res.status).toBe(405);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Failure Mode 3: Handler Throwing an Error
  // (Caught by error middleware, which converts to JSON)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Handler throws an error', () => {
    it('returns application/json when middleware throws ZodError (validation)', async () => {
      // POST /auth/token with an empty body triggers validateBody's Zod schema.
      // This route has no auth guard ahead of validateBody, so the request
      // actually reaches the validation layer (unlike the role-gated routes).
      const res = await request(app)
        .post('/auth/token')
        .send({});
      // Missing required fields → ZodError → 400
      expect(res.status).toBe(400);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('returns application/json when thrown error is caught by errorHandler', async () => {
      // A handler that unconditionally throws will trigger the error middleware
      // For now, we can rely on an existing scenario that throws (e.g., auth failure)
      // hitting an endpoint that requires auth without providing it.

      // GET /api/scouts/:wallet/subscription requires auth
      const res = await request(app).get('/api/scouts/G' + 'A'.repeat(55) + '/subscription');
      // No auth token → 401 UNAUTHORIZED
      expect(res.status).toBe(401);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Failure Mode 4: Malformed JSON Body
  // ─────────────────────────────────────────────────────────────────────────

  describe('Malformed JSON request body', () => {
    it('returns application/json for invalid JSON with Content-Type: application/json', async () => {
      const res = await request(app)
        .post('/api/players/register')
        .set('Content-Type', 'application/json')
        .send('{not valid json]');

      // body-parser.json() error → errorHandler catches it
      expect(res.status).toBe(400);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.MALFORMED_JSON);
      expect(res.body.error).toContain('Malformed');
    });

    it('returns application/json when body is incomplete/truncated JSON', async () => {
      const res = await request(app)
        .post('/api/players/register')
        .set('Content-Type', 'application/json')
        .send('{"wallet":"GABC...","position"');

      expect(res.status).toBe(400);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.MALFORMED_JSON);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Failure Mode 5: Payload Too Large
  // ─────────────────────────────────────────────────────────────────────────

  describe('Payload size limits', () => {
    it('returns application/json when payload exceeds size limit', async () => {
      // /api/players/register is an upload path (10mb limit); exceed it so the
      // body parser rejects the request with 413 before it reaches any route.
      const largePayload = JSON.stringify({
        wallet: 'G' + 'A'.repeat(55),
        position: 'x'.repeat(1024 * 1024 * 6), // ~6MB
        region: 'y'.repeat(1024 * 1024 * 6), // ~6MB → ~12MB total
      });

      const res = await request(app)
        .post('/api/players/register')
        .set('Content-Type', 'application/json')
        .send(largePayload);

      expect(res.status).toBe(413);
      expect(res.type).toBe('application/json');
      expectValidErrorResponse(res.body);
      expect(res.body.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Summary: All error modes produce application/json
  // ─────────────────────────────────────────────────────────────────────────

  describe('Cross-failure-mode invariant', () => {
    const testCases = [
      {
        name: 'Unknown path',
        request: () => request(app).get('/does/not/exist'),
      },
      {
        name: 'Malformed JSON',
        request: () =>
          request(app)
            .post('/api/players/register')
            .set('Content-Type', 'application/json')
            .send('{invalid json'),
      },
      {
        name: 'Validation error',
        request: () =>
          request(app)
            .post('/api/players/register')
            .set('Authorization', 'Bearer token')
            .send({ position: 'striker' }), // missing wallet
      },
    ];

    testCases.forEach(({ name, request: req }) => {
      it(`${name} — response is always application/json`, async () => {
        const res = await req();
        expect(res.type).toMatch(/application\/json/i);
        expect(res.body).toBeDefined();
        expectValidErrorResponse(res.body);
        expect(res.body.success).toBe(false);
        // Never return HTML
        expect(typeof res.body).toBe('object');
        expect((res.text as string).includes('<html')).toBe(false);
        expect((res.text as string).includes('<body')).toBe(false);
      });

      it(`${name} — response contains error code`, async () => {
        const res = await req();
        expect(res.body.code).toBeDefined();
        expect(typeof res.body.code).toBe('string');
        // code should be a valid ErrorCode value
        const validCodes = Object.values(ErrorCode);
        expect(validCodes).toContain(res.body.code);
      });

      it(`${name} — response contains human-readable error message`, async () => {
        const res = await req();
        expect(res.body.error).toBeDefined();
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
      });
    });
  });
});
