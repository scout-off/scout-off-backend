'use strict';

/**
 * tsProject.js
 *
 * Minimal cross-file TypeScript AST resolution used by the docs generator:
 * given an identifier used in a route file (e.g. the `registerSchema` in
 * `validateBody(registerSchema)`), find the `export const registerSchema =
 * ...` declaration it refers to, even when that declaration lives in a
 * different file (typically a controller). Parsing only — nothing is
 * `require()`-d or executed, so this has no dependency on the app booting,
 * the database, or any native module.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const fileCache = new Map(); // absPath -> { sourceFile, scope, imports }

function loadFile(absPath) {
  if (fileCache.has(absPath)) return fileCache.get(absPath);

  const text = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const scope = new Map(); // top-level const NAME -> initializer expression
  const imports = new Map(); // local name -> resolved absolute file path (relative imports only)

  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          scope.set(decl.name.text, decl.initializer);
        }
      }
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause && stmt.moduleSpecifier) {
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteralLike(spec)) continue;
      const modulePath = spec.text;
      if (!modulePath.startsWith('.')) continue; // skip package imports (express, zod, ...)

      const resolved = resolveModulePath(absPath, modulePath);
      if (!resolved) continue;

      const named = stmt.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const spec of named.elements) {
          const localName = spec.name.text;
          const importedName = (spec.propertyName || spec.name).text;
          imports.set(localName, { file: resolved, importedName });
        }
      }
    }
  }

  const entry = { sourceFile, scope, imports };
  fileCache.set(absPath, entry);
  return entry;
}

function resolveModulePath(fromAbsPath, modulePath) {
  const base = path.resolve(path.dirname(fromAbsPath), modulePath);
  const candidates = [`${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve `name` as used inside the file at `absPath` back to the
 * expression it's bound to, following import chains as needed.
 *
 * @returns {{expr: import('typescript').Expression, scope: Map, file: string} | null}
 */
function resolveIdentifier(absPath, name, seenFiles) {
  seenFiles = seenFiles || new Set();
  if (seenFiles.has(`${absPath}::${name}`)) return null;
  seenFiles.add(`${absPath}::${name}`);

  const { scope, imports } = loadFile(absPath);

  if (scope.has(name)) {
    return { expr: scope.get(name), scope, file: absPath };
  }

  const imported = imports.get(name);
  if (imported) {
    return resolveIdentifier(imported.file, imported.importedName, seenFiles);
  }

  return null;
}

module.exports = { loadFile, resolveIdentifier, resolveModulePath };
