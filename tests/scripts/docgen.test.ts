/**
 * Unit tests for the static route-documentation generator (#1047).
 *
 * These exercise the pure building blocks — the Zod-to-JSON-Schema AST
 * converter, the JSDoc tag parser, and the middleware-to-security deriver —
 * in isolation from real route files, so a regression in the parsing logic
 * itself is caught here rather than only showing up as a subtly wrong
 * generated spec.
 */

import ts from 'typescript';

// Plain CommonJS modules; require them directly.
/* eslint-disable @typescript-eslint/no-var-requires */
const { convertZodExpression } = require('../../scripts/lib/docgen/zodSchema');
const { docFor } = require('../../scripts/lib/docgen/jsdocTags');
const { deriveSecurity } = require('../../scripts/lib/docgen/security');
/* eslint-enable @typescript-eslint/no-var-requires */

function parseExpression(source: string): { expr: ts.Expression; scope: Map<string, ts.Expression> } {
  const wrapped = `${source}\n`;
  const sourceFile = ts.createSourceFile('fixture.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scope = new Map<string, ts.Expression>();
  let last: ts.Expression | undefined;

  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          scope.set(decl.name.text, decl.initializer);
          last = decl.initializer;
        }
      }
    }
  }

  if (!last) throw new Error('fixture must declare at least one const');
  return { expr: last, scope };
}

describe('zodSchema.convertZodExpression', () => {
  it('converts primitive types with constraints', () => {
    const { expr, scope } = parseExpression(`const s = z.string().min(1).max(56);`);
    const { schema } = convertZodExpression(expr, scope);
    expect(schema).toEqual({ type: 'string', minLength: 1, maxLength: 56 });
  });

  it('marks .optional() and .default() fields as not required inside z.object', () => {
    const { expr, scope } = parseExpression(`
      const s = z.object({
        required: z.string(),
        opt: z.string().optional(),
        withDefault: z.number().default(5),
      });
    `);
    const { schema } = convertZodExpression(expr, scope);
    expect(schema.required).toEqual(['required']);
    expect(schema.properties.withDefault.default).toBe(5);
  });

  it('converts z.enum to a string enum', () => {
    const { expr, scope } = parseExpression(`const s = z.enum(['a', 'b', 'c']);`);
    const { schema } = convertZodExpression(expr, scope);
    expect(schema).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
  });

  it('converts z.union to oneOf', () => {
    const { expr, scope } = parseExpression(`const s = z.union([z.string(), z.number()]);`);
    const { schema } = convertZodExpression(expr, scope);
    expect(schema.oneOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('resolves a cross-referenced local identifier', () => {
    const { expr, scope } = parseExpression(`
      const base = z.object({ a: z.string() });
      const s = base.extend({ b: z.number() });
    `);
    const { schema } = convertZodExpression(expr, scope);
    expect(Object.keys(schema.properties).sort()).toEqual(['a', 'b']);
    expect(schema.required.sort()).toEqual(['a', 'b']);
  });

  it('applies .int() to switch a number schema to integer', () => {
    const { expr, scope } = parseExpression(`const s = z.coerce.number().int().min(1).max(100).default(20);`);
    const { schema } = convertZodExpression(expr, scope);
    expect(schema).toEqual({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
  });

  it('flags a genuinely unmapped construct instead of guessing', () => {
    const { expr, scope } = parseExpression(`const s = z.string().someMadeUpMethod();`);
    const { unmapped } = convertZodExpression(expr, scope);
    expect(unmapped).toContain('someMadeUpMethod');
  });
});

describe('jsdocTags.docFor', () => {
  it('derives a summary from the first sentence when no @summary tag is present', () => {
    const comment = `/**\n * Fetch a single player profile. Deactivated profiles return 404.\n *\n * @response 200 ok\n */`;
    const doc = docFor(comment, 'GET');
    expect(doc.summary).toBe('Fetch a single player profile.');
    expect(doc.responses).toEqual([{ status: '200', description: 'ok' }]);
  });

  it('does not truncate a summary mid-sentence when the first source line wraps without punctuation', () => {
    const comment = [
      '/**',
      ' * Pay-to-contact XLM micro-fee flow: the idempotency middleware is',
      ' * configured with a request fingerprint so replaying is rejected.',
      ' *',
      ' * @response 200 ok',
      ' */',
    ].join('\n');
    const doc = docFor(comment, 'POST');
    expect(doc.summary).toBe(
      'Pay-to-contact XLM micro-fee flow: the idempotency middleware is configured with a request fingerprint so replaying is rejected.',
    );
  });

  it('splits a shared multi-method comment block by METHOD /path header', () => {
    const comment = [
      '/**',
      ' * GET /api/things/:id',
      ' *',
      ' * Fetch a thing.',
      ' *',
      ' * @response 200 ok',
      ' *',
      ' * PUT /api/things/:id',
      ' *',
      ' * Update a thing.',
      ' *',
      ' * @response 200 updated',
      ' * @response 404 not found',
      ' */',
    ].join('\n');

    const getDoc = docFor(comment, 'GET');
    expect(getDoc.summary).toBe('Fetch a thing.');
    expect(getDoc.responses).toEqual([{ status: '200', description: 'ok' }]);

    const putDoc = docFor(comment, 'PUT');
    expect(putDoc.summary).toBe('Update a thing.');
    expect(putDoc.responses).toEqual([
      { status: '200', description: 'updated' },
      { status: '404', description: 'not found' },
    ]);
  });

  it('returns an empty doc (no summary, no responses) for a missing comment', () => {
    const doc = docFor(null, 'GET');
    expect(doc.summary).toBeUndefined();
    expect(doc.responses).toEqual([]);
  });

  it('parses @param, @query, and @auth as supplementary metadata', () => {
    const comment = [
      '/**',
      ' * Do a thing.',
      ' *',
      ' * @param id {string} - The id',
      ' * @query verbose {boolean} - Include extra fields',
      ' * @auth Bearer (admin role required)',
      ' * @response 200 ok',
      ' */',
    ].join('\n');
    const doc = docFor(comment, 'GET');
    expect(doc.params).toEqual([{ name: 'id', type: 'string', description: 'The id' }]);
    expect(doc.query).toEqual([{ name: 'verbose', type: 'boolean', description: 'Include extra fields' }]);
    expect(doc.authNote).toBe('Bearer (admin role required)');
  });
});

describe('security.deriveSecurity', () => {
  it('produces an empty security requirement when no auth middleware is present', () => {
    const { security, extensions } = deriveSecurity([{ kind: 'other', raw: 'someMiddleware' }]);
    expect(security).toEqual([]);
    expect(extensions).toEqual({});
  });

  it('derives an optional-bearer requirement from optionalAuth', () => {
    const { security } = deriveSecurity([{ kind: 'authOptional', raw: 'optionalAuth' }]);
    expect(security).toEqual([{}, { bearerAuth: [] }]);
  });

  it('derives a required-bearer requirement with role from requireRole(...)', () => {
    const { security, extensions } = deriveSecurity([{ kind: 'role', role: 'admin', raw: "requireRole('admin')" }]);
    expect(security).toEqual([{ bearerAuth: [] }]);
    expect(extensions['x-required-role']).toEqual(['admin']);
  });

  it('offers both bearer and API-key auth when a scope is present', () => {
    const { security, extensions } = deriveSecurity([
      { kind: 'role', role: 'scout', raw: "requireRole('scout')" },
      { kind: 'apiKeyScope', scope: 'write:notes', raw: "requireApiKeyScope('write:notes')" },
    ]);
    expect(security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: ['write:notes'] }]);
    expect(extensions['x-api-key-scope']).toBe('write:notes');
  });

  it('flags an owner check and never lets a comment override the derived requirement', () => {
    const { extensions } = deriveSecurity([
      { kind: 'role', role: 'player', raw: "requireRole('player')" },
      { kind: 'ownerCheck', raw: 'requireOwner' },
    ]);
    expect(extensions['x-owner-only']).toBe(true);
    expect(extensions['x-required-role']).toEqual(['player']);
  });

  it('extracts a role from inline custom middleware as a best-effort fallback', () => {
    const { security, extensions } = deriveSecurity([
      { kind: 'authOptional', raw: 'optionalAuth' },
      {
        kind: 'custom',
        raw: "(req, res, next) => { if (req.role === 'admin') return next(); return requireRole('player')(req, res, next); }",
      },
    ]);
    expect(security).toEqual([{ bearerAuth: [] }]);
    expect(extensions['x-required-role']).toEqual(['player']);
    expect(extensions['x-auth-note']).toContain('custom inline logic');
  });
});
