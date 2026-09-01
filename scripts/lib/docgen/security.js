'use strict';

/**
 * security.js
 *
 * Derives an operation's OpenAPI `security` requirement from the *actual*
 * Express middleware chain registered for that route, never from a
 * hand-written comment. This is the structural fix for the drift class
 * this issue calls out: a JSDoc comment can say "admin role required" while
 * the real route has no such check (or vice versa) because nothing forces
 * the comment to match the code. A requirement computed from the real
 * `requireRole(...)` / `optionalAuth` / etc. calls in the route file cannot
 * make that mistake — if the code's auth requirement changes, the next
 * generator run picks up the new requirement automatically.
 */

function deriveSecurity(middleware) {
  const roles = [];
  let authRequired = false;
  let authOptional = false;
  let apiKeyScope = null;
  let ownerCheck = false;
  const notes = [];

  for (const mw of middleware) {
    switch (mw.kind) {
      case 'role':
        authRequired = true;
        if (mw.role) roles.push(mw.role);
        break;
      case 'authRequired':
        authRequired = true;
        break;
      case 'authOptional':
        authOptional = true;
        break;
      case 'apiKeyScope':
        apiKeyScope = mw.scope || null;
        break;
      case 'ownerCheck':
        ownerCheck = true;
        break;
      case 'custom':
        // Inline middleware (e.g. an arrow function bypassing requireRole
        // for admins) can't be statically resolved to a precise
        // requirement. Surface what we can find heuristically and flag it
        // for a human to double check rather than asserting a wrong shape.
        if (/requireRole\(\s*['"]([\w-]+)['"]\s*\)/.test(mw.raw)) {
          authRequired = true;
          const m = mw.raw.match(/requireRole\(\s*['"]([\w-]+)['"]\s*\)/g) || [];
          for (const call of m) {
            const roleMatch = call.match(/['"]([\w-]+)['"]/);
            if (roleMatch) roles.push(roleMatch[1]);
          }
        }
        if (/req\.role\s*===/.test(mw.raw)) {
          notes.push('Authorization includes custom inline logic beyond a single role check — see the route source.');
        }
        break;
      default:
        break;
    }
  }

  let security;
  if (authRequired && apiKeyScope) {
    security = [{ bearerAuth: [] }, { apiKeyAuth: [apiKeyScope] }];
  } else if (authRequired) {
    security = [{ bearerAuth: [] }];
  } else if (authOptional) {
    security = [{}, { bearerAuth: [] }];
  } else {
    security = [];
  }

  const extensions = {};
  const uniqueRoles = Array.from(new Set(roles));
  if (uniqueRoles.length) extensions['x-required-role'] = uniqueRoles;
  if (apiKeyScope) extensions['x-api-key-scope'] = apiKeyScope;
  if (ownerCheck) extensions['x-owner-only'] = true;
  if (notes.length) extensions['x-auth-note'] = notes.join(' ');

  return { security, extensions };
}

module.exports = { deriveSecurity };
