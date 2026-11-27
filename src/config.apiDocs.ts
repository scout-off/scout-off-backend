/**
 * API docs visibility settings (#1868).
 *
 * Self-contained so it can be evaluated without loading the full config
 * module. Evaluated at import time from API_DOCS_MODE / API_DOCS_HIDE_ADMIN.
 *
 * Note: `src/config.ts` reuses `resolveApiDocsMode` but validates
 * API_DOCS_HIDE_ADMIN strictly at startup; this module is lenient and treats
 * any unrecognised value as `false`.
 */
import envConstants from './config/env-constants.json';

export type ApiDocsMode = 'public' | 'admin' | 'disabled';

export const VALID_API_DOCS_MODES: ReadonlySet<string> = new Set(envConstants.apiDocsModes);

export function resolveApiDocsMode(
  rawMode: string | undefined,
  nodeEnv: string | undefined,
): ApiDocsMode {
  const raw = (rawMode ?? '').trim().toLowerCase();
  if (raw && !VALID_API_DOCS_MODES.has(raw)) {
    throw new Error(
      `Invalid API_DOCS_MODE: "${raw}". Must be one of: ${[...VALID_API_DOCS_MODES].join(', ')}.`,
    );
  }
  if (raw) return raw as ApiDocsMode;
  return nodeEnv === 'production' || nodeEnv === 'staging' ? 'admin' : 'public';
}

function resolveHideAdminPaths(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export const apiDocsConfig: { mode: ApiDocsMode; hideAdminPaths: boolean } = {
  mode: resolveApiDocsMode(process.env.API_DOCS_MODE, process.env.NODE_ENV),
  hideAdminPaths: resolveHideAdminPaths(process.env.API_DOCS_HIDE_ADMIN),
};
