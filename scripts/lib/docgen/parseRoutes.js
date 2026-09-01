'use strict';

/**
 * parseRoutes.js
 *
 * Statically extracts every route registered in an Express router source
 * file (src/routes/*.ts) — method, path, middleware chain, and the leading
 * JSDoc comment — without executing any code. Two call shapes are
 * supported, both used throughout this codebase:
 *
 *   router.route('/path').get(mw1, mw2, handler).post(...).all(...)
 *   router.get('/path', mw1, mw2, handler)
 *
 * `.all(methodNotAllowed([...]))` is the 405 catch-all and is not treated
 * as a documented operation. `router.use(singleMiddleware)` at the top of a
 * file is treated as applying to every route below it in that file (used
 * by src/routes/admin.ts for its IP allowlist gate).
 */

const fs = require('fs');
const ts = require('typescript');
const { resolveIdentifier } = require('./tsProject');
const { convertZodExpression } = require('./zodSchema');
const { docFor } = require('./jsdocTags');
const { deriveSecurity } = require('./security');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function parseRouteFile(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const routerVarName = findRouterVarName(sourceFile) || 'router';
  const globalMiddleware = findGlobalMiddleware(sourceFile, routerVarName);

  const routes = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expr = statement.expression;
    if (!ts.isCallExpression(expr)) continue;

    const chain = unwrapChain(expr, routerVarName);
    if (!chain) continue;

    const rawComment = getLeadingJSDoc(sourceFile, text, statement);
    const subPath = literalText(chain.pathArg) || '';

    for (const call of chain.calls) {
      if (!HTTP_METHODS.has(call.method)) continue; // skip .all()/.use()

      const args = call.args;
      const middlewareArgs = args.slice(0, -1);
      const handlerArg = args[args.length - 1];

      const middleware = globalMiddleware.concat(
        middlewareArgs.map((a) => classifyMiddleware(a, sourceFile, absPath)),
      );

      const requestBody = extractSchema(middleware, 'validateBody', absPath);
      const queryParams = extractQueryParams(middleware, absPath);

      routes.push({
        method: call.method.toUpperCase(),
        subPath,
        fullSourcePath: absPath,
        handlerName: ts.isIdentifier(handlerArg) ? handlerArg.text : undefined,
        middleware,
        requestBody,
        queryParams,
        doc: docFor(rawComment, call.method.toUpperCase()),
        ...deriveSecurity(middleware),
      });
    }
  }

  return routes;
}

function findRouterVarName(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isCallExpression(decl.initializer) &&
        ts.isIdentifier(decl.initializer.expression) &&
        decl.initializer.expression.text === 'Router'
      ) {
        return decl.name.text;
      }
    }
  }
  return null;
}

/** `router.use(singleMiddleware)` — applies to every route below it in the file. */
function findGlobalMiddleware(sourceFile, routerVarName) {
  const result = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
    const call = stmt.expression;
    const callee = call.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === routerVarName &&
      callee.name.text === 'use' &&
      call.arguments.length === 1
    ) {
      result.push(classifyMiddleware(call.arguments[0], sourceFile, sourceFile.fileName));
    }
  }
  return result;
}

/**
 * Unwind a `router.route(path).verb(...).verb(...)` or `router.verb(path, ...)`
 * expression into `{ pathArg, calls: [{method, args}] }` in source order.
 */
function unwrapChain(node, routerVarName) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;

  const methodName = callee.name.text;
  const objectExpr = callee.expression;

  // Direct call: router.get(path, ...args)
  if (ts.isIdentifier(objectExpr) && objectExpr.text === routerVarName) {
    if (!HTTP_METHODS.has(methodName)) return null;
    const [pathArg, ...rest] = node.arguments;
    return { pathArg, calls: [{ method: methodName, args: rest }] };
  }

  // Chained call: <...>.verb(...)
  if (ts.isCallExpression(objectExpr)) {
    const objCallee = objectExpr.expression;
    if (
      ts.isPropertyAccessExpression(objCallee) &&
      ts.isIdentifier(objCallee.expression) &&
      objCallee.expression.text === routerVarName &&
      objCallee.name.text === 'route'
    ) {
      // objectExpr is router.route(path) — the base of the chain
      return { pathArg: objectExpr.arguments[0], calls: [{ method: methodName, args: node.arguments }] };
    }

    const inner = unwrapChain(objectExpr, routerVarName);
    if (inner) {
      inner.calls.push({ method: methodName, args: node.arguments });
      return inner;
    }
  }

  return null;
}

function literalText(node) {
  if (node && ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function classifyMiddleware(argExpr, sourceFile, absPath) {
  if (ts.isIdentifier(argExpr)) {
    const name = argExpr.text;
    if (name === 'requireAuth') return { kind: 'authRequired', raw: name };
    if (name === 'optionalAuth') return { kind: 'authOptional', raw: name };
    if (name === 'requireOwner') return { kind: 'ownerCheck', raw: name };
    return { kind: 'other', raw: name };
  }

  if (ts.isCallExpression(argExpr)) {
    const callee = argExpr.expression;
    const calleeName = ts.isIdentifier(callee) ? callee.text : undefined;

    if (calleeName === 'requireRole') {
      return { kind: 'role', role: literalText(argExpr.arguments[0]), raw: argExpr.getText(sourceFile) };
    }
    if (calleeName === 'requireApiKeyScope') {
      return { kind: 'apiKeyScope', scope: literalText(argExpr.arguments[0]), raw: argExpr.getText(sourceFile) };
    }
    if (calleeName === 'requireWalletOwner') {
      return { kind: 'ownerCheck', raw: argExpr.getText(sourceFile) };
    }
    if (calleeName === 'validateBody') {
      const schemaArg = argExpr.arguments[0];
      return {
        kind: 'validateBody',
        schemaName: ts.isIdentifier(schemaArg) ? schemaArg.text : undefined,
        raw: argExpr.getText(sourceFile),
      };
    }
    if (calleeName === 'validateQuery') {
      const schemaArg = argExpr.arguments[0];
      return {
        kind: 'validateQuery',
        schemaName: ts.isIdentifier(schemaArg) ? schemaArg.text : undefined,
        raw: argExpr.getText(sourceFile),
      };
    }
    if (calleeName === 'requireFeatureFlag') {
      return { kind: 'featureFlag', raw: argExpr.getText(sourceFile) };
    }

    return { kind: 'other', raw: argExpr.getText(sourceFile).slice(0, 80) };
  }

  if (ts.isArrowFunction(argExpr) || ts.isFunctionExpression(argExpr)) {
    return { kind: 'custom', raw: argExpr.getText(sourceFile) };
  }

  return { kind: 'other', raw: argExpr.getText(sourceFile).slice(0, 80) };
}

function extractSchema(middleware, kind, routeFileAbsPath) {
  const entry = middleware.find((m) => m.kind === kind);
  if (!entry || !entry.schemaName) return undefined;

  const resolved = resolveIdentifier(routeFileAbsPath, entry.schemaName);
  if (!resolved) return undefined;

  const { schema, unmapped } = convertZodExpression(resolved.expr, resolved.scope);
  return { schema, unmapped, schemaName: entry.schemaName };
}

/**
 * Mechanically enumerate query parameters from a resolved `validateQuery`
 * Zod object schema (authoritative — matches what the server actually
 * accepts) rather than from a hand-written comment.
 */
function extractQueryParams(middleware, routeFileAbsPath) {
  const resolved = extractSchema(middleware, 'validateQuery', routeFileAbsPath);
  if (!resolved || !resolved.schema || resolved.schema.type !== 'object') return [];

  const required = new Set(resolved.schema.required || []);
  return Object.entries(resolved.schema.properties || {}).map(([name, schema]) => ({
    name,
    schema,
    required: required.has(name),
  }));
}

function getLeadingJSDoc(sourceFile, fullText, node) {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) || [];
  const jsdocRanges = ranges.filter((r) => fullText.slice(r.pos, r.pos + 3) === '/**');
  if (jsdocRanges.length === 0) return null;
  const last = jsdocRanges[jsdocRanges.length - 1];
  return fullText.slice(last.pos, last.end);
}

module.exports = { parseRouteFile };
