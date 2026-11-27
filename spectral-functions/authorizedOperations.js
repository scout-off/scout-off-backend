'use strict';

/**
 * Spectral custom function: every HTTP operation must explicitly declare a
 * `security` array (an empty array marks an intentionally public endpoint).
 */
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

module.exports = (operation, _opts, context) => {
  const method = context.path[context.path.length - 1];
  if (!HTTP_METHODS.has(String(method))) return [];
  if (operation && Array.isArray(operation.security)) return [];
  return [{ message: 'Operation must declare `security` (use [] for public endpoints).' }];
};
