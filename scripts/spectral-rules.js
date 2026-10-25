/**
 * Custom Spectral rules for ScoutOff OpenAPI validation.
 * These extend the base spectral:oas ruleset with project-specific checks.
 */

/**
 * Validate that operations requiring authentication declare the security requirement.
 * Looks for operations that touch protected resources (e.g., /scouts/{wallet}, /admin/*)
 * and ensures they declare a security requirement.
 *
 * This is a heuristic: any operation with a path containing 'scouts' or 'admin'
 * is assumed to be protected unless otherwise marked.
 */
export const authorizedOperations = () => {
  return (targetVal, _opts, paths) => {
    const path = paths.path[paths.path.length - 1] || "";
    const method = paths.path[paths.path.length - 2] || "";

    // Check if this operation touches a protected resource
    const isProtectedPath = /\/(scouts|admin)/.test(path);

    if (!isProtectedPath) {
      // Not a protected path — no security requirement needed
      return [];
    }

    // Protected path — check if security is declared
    const security = targetVal.security;
    if (!security || (Array.isArray(security) && security.length === 0)) {
      return [
        {
          message: `Operation ${method.toUpperCase()} ${path} accesses a protected resource but does not declare a security requirement`,
          path: [...paths.path, 'security'],
        },
      ];
    }

    return [];
  };
};
