/**
 * API documentation visibility mode configuration.
 * Controls whether the OpenAPI spec and Swagger UI are served, and under what conditions.
 *
 * Modes:
 *   public    — API docs are publicly accessible at /api/docs, /api/docs/ui, etc.
 *              Suitable for developer-facing APIs where transparency is desired.
 *   admin     — API docs are behind admin authentication (requireRole('admin')).
 *              Recommended default for production deployments.
 *   disabled  — API docs endpoints return 404. Useful for air-gapped or highly secured deployments.
 *
 * Environment variable: API_DOCS_MODE (defaults per NODE_ENV; see defaults below)
 * Environment variable: API_DOCS_HIDE_ADMIN (boolean; only in public mode; hides /admin/* paths)
 */

type ApiDocsMode = 'public' | 'admin' | 'disabled';

const VALID_MODES: ReadonlySet<string> = new Set(['public', 'admin', 'disabled']);

const DEFAULT_MODE_BY_ENV: Record<string, ApiDocsMode> = {
  development: 'public',
  test: 'public',
  staging: 'admin',
  production: 'admin',
};

function getApiDocsMode(): ApiDocsMode {
  const raw = process.env.API_DOCS_MODE?.trim().toLowerCase();

  if (!raw) {
    const nodeEnv = process.env.NODE_ENV || 'development';
    return DEFAULT_MODE_BY_ENV[nodeEnv] || 'public';
  }

  if (!VALID_MODES.has(raw)) {
    throw new Error(
      `Invalid API_DOCS_MODE: "${raw}". Must be one of: ${[...VALID_MODES].join(', ')}.`
    );
  }

  return raw as ApiDocsMode;
}

function getHideAdminPaths(): boolean {
  const raw = process.env.API_DOCS_HIDE_ADMIN?.trim().toLowerCase();
  if (!raw) return false;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export const apiDocsConfig = {
  mode: getApiDocsMode(),
  hideAdminPaths: getHideAdminPaths(),
};
