'use strict';

/**
 * zodSchema.js
 *
 * Converts a Zod validator expression, as it appears in a controller source
 * file, into an OpenAPI-compatible JSON Schema object — WITHOUT executing
 * any code. This is pure TypeScript AST analysis: we never `require()` the
 * controller (which would pull in the DB layer and other runtime
 * dependencies), so this stays fast, hermetic, and safe to run in CI with
 * nothing more than the `typescript` package already used to build the app.
 *
 * This is the mechanism that lets request-body/query documentation be
 * derived from the actual runtime validator instead of hand-written and
 * liable to drift from it: scripts/generate-openapi-json.js resolves the
 * schema identifier passed to validateBody()/validateQuery() back to its
 * `z.object({...})` (etc.) declaration and runs it through this converter.
 *
 * Coverage is scoped to the Zod call patterns actually used in this
 * codebase (see the `.min/.max/.optional/.default/.enum/...` survey in the
 * accompanying PR description) — not a general-purpose Zod-to-JSON-Schema
 * library. Anything unrecognised degrades to an empty schema (`{}`, i.e.
 * "any") with an `x-unmapped` marker rather than guessing, so an
 * unsupported construct fails visibly instead of documenting the wrong
 * shape.
 */

const ts = require('typescript');

/**
 * @param {import('typescript').Expression} expr
 * @param {Map<string, import('typescript').Expression>} scope local `const NAME = <expr>` bindings in the file
 * @param {Set<string>} [seen] identifier names currently being resolved (cycle guard)
 * @returns {{schema: object, required: boolean, description?: string}}
 */
function convertZodExpression(expr, scope, seen) {
  seen = seen || new Set();
  const result = convert(expr, scope, seen, { required: true });
  return result;
}

function convert(expr, scope, seen, state) {
  if (ts.isParenthesizedExpression(expr)) {
    return convert(expr.expression, scope, seen, state);
  }

  // Identifier referencing a local schema const, e.g. `baseRegistrationSchema`
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (seen.has(name)) {
      return { schema: {}, unmapped: `circular reference to ${name}` };
    }
    const target = scope.get(name);
    if (!target) {
      return { schema: {}, unmapped: `unresolved identifier ${name}` };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return convert(target, scope, nextSeen, state);
  }

  if (ts.isCallExpression(expr)) {
    return convertCall(expr, scope, seen, state);
  }

  return { schema: {}, unmapped: `unsupported expression kind ${ts.SyntaxKind[expr.kind]}` };
}

function convertCall(callExpr, scope, seen, state) {
  const callee = callExpr.expression;

  // Chained method call: <base>.<method>(...)
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text;
    const baseExpr = callee.expression;

    // z.coerce.number() — the `.coerce` hop just marks the eventual base
    // type as string-coercible on input; doesn't change the OpenAPI shape.
    if (ts.isPropertyAccessExpression(baseExpr) && baseExpr.name.text === 'coerce') {
      return applyZodBase(methodName, callExpr.arguments, scope, seen, state);
    }

    // Base namespace call: z.string(...), z.object(...), etc.
    if (ts.isIdentifier(baseExpr) && baseExpr.text === 'z') {
      return applyZodBase(methodName, callExpr.arguments, scope, seen, state);
    }

    // Modifier chained onto a prior schema expression: <expr>.optional(), .min(n), ...
    const base = convert(baseExpr, scope, seen, state);
    return applyModifier(methodName, callExpr.arguments, base, state, scope, seen);
  }

  return { schema: {}, unmapped: 'unsupported call target' };
}

function literalValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

function applyZodBase(name, args, scope, seen, state) {
  switch (name) {
    case 'string':
      return { schema: { type: 'string' } };
    case 'number':
      return { schema: { type: 'number' } };
    case 'boolean':
      return { schema: { type: 'boolean' } };
    case 'unknown':
    case 'any':
      return { schema: {} };
    case 'literal': {
      const v = literalValue(args[0]);
      const t = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
      return { schema: { type: t, enum: [v] } };
    }
    case 'enum': {
      const arr = args[0];
      const values = ts.isArrayLiteralExpression(arr)
        ? arr.elements.map(literalValue).filter((v) => v !== undefined)
        : [];
      return { schema: { type: 'string', enum: values } };
    }
    case 'array': {
      const inner = convert(args[0], scope, seen, { required: true });
      return { schema: { type: 'array', items: inner.schema } };
    }
    case 'record': {
      const inner = convert(args[0], scope, seen, { required: true });
      return { schema: { type: 'object', additionalProperties: inner.schema } };
    }
    case 'union': {
      const arr = args[0];
      const options = ts.isArrayLiteralExpression(arr) ? arr.elements : [];
      const schemas = options.map((o) => convert(o, scope, seen, { required: true }).schema);
      return { schema: { oneOf: schemas } };
    }
    case 'object': {
      const shape = args[0];
      return { schema: convertObjectShape(shape, scope, seen) };
    }
    default:
      return { schema: {}, unmapped: `unsupported base call z.${name}()` };
  }
}

function convertObjectShape(shapeNode, scope, seen) {
  const properties = {};
  const required = [];

  if (shapeNode && ts.isObjectLiteralExpression(shapeNode)) {
    for (const prop of shapeNode.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propName(prop.name);
      if (key === undefined) continue;
      const value = convert(prop.initializer, scope, seen, { required: true });
      properties[key] = value.schema;
      if (value.unmapped) {
        properties[key]['x-unmapped'] = value.unmapped;
      }
      if (value.description) {
        properties[key].description = value.description;
      }
      if (value.required !== false) {
        required.push(key);
      }
    }
  }

  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

function propName(nameNode) {
  if (ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isStringLiteralLike(nameNode)) return nameNode.text;
  return undefined;
}

function applyModifier(methodName, args, base, state, scope, seen) {
  const schema = Object.assign({}, base.schema);
  let required = base.required !== false;
  let description = base.description;
  let unmapped = base.unmapped;

  switch (methodName) {
    case 'optional':
    case 'nullish':
      required = false;
      break;
    case 'nullable':
      schema.nullable = true;
      break;
    case 'default': {
      required = false;
      const v = literalValue(args[0]);
      if (v !== undefined) schema.default = v;
      break;
    }
    case 'min': {
      const n = literalValue(args[0]);
      if (typeof n === 'number') {
        if (schema.type === 'string') schema.minLength = n;
        else if (schema.type === 'array') schema.minItems = n;
        else schema.minimum = n;
      }
      break;
    }
    case 'max': {
      const n = literalValue(args[0]);
      if (typeof n === 'number') {
        if (schema.type === 'string') schema.maxLength = n;
        else if (schema.type === 'array') schema.maxItems = n;
        else schema.maximum = n;
      }
      break;
    }
    case 'length': {
      const n = literalValue(args[0]);
      if (typeof n === 'number') {
        schema.minLength = n;
        schema.maxLength = n;
      }
      break;
    }
    case 'int':
      schema.type = 'integer';
      break;
    case 'positive':
      schema.minimum = 0;
      schema.exclusiveMinimum = true;
      break;
    case 'nonnegative':
      schema.minimum = 0;
      break;
    case 'email':
      schema.format = 'email';
      break;
    case 'url':
      schema.format = 'uri';
      break;
    case 'uuid':
      schema.format = 'uuid';
      break;
    case 'regex': {
      const pattern = args[0] && ts.isRegularExpressionLiteral(args[0]) ? args[0].text : undefined;
      if (pattern) schema.pattern = pattern.replace(/^\/|\/[a-z]*$/g, '');
      break;
    }
    case 'trim':
    case 'toLowerCase':
    case 'toUpperCase':
    case 'transform':
    case 'superRefine':
      // Input-shape-neutral: these affect the parsed *output*, not the
      // shape of what a client is expected to send.
      break;
    case 'refine': {
      description = [description, 'Additional validation is applied beyond this schema — see the route handler.']
        .filter(Boolean)
        .join(' ');
      break;
    }
    case 'strict':
      schema.additionalProperties = false;
      break;
    case 'passthrough':
      schema.additionalProperties = true;
      break;
    case 'extend': {
      const shape = args[0];
      if (shape && ts.isObjectLiteralExpression(shape) && schema.type === 'object') {
        const extension = convertObjectShape(shape, scope, seen);
        schema.properties = Object.assign({}, schema.properties, extension.properties);
        const requiredSet = new Set([...(schema.required || []), ...(extension.required || [])]);
        schema.required = Array.from(requiredSet);
        if (schema.required.length === 0) delete schema.required;
      } else {
        unmapped = unmapped || `.${methodName}() with a non-object-literal argument`;
      }
      break;
    }
    default:
      unmapped = unmapped || `unsupported modifier .${methodName}()`;
  }

  return { schema, required, description, unmapped };
}

module.exports = { convertZodExpression };
