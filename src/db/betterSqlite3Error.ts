/**
 * Build an actionable error when better-sqlite3's native addon fails to load
 * or initialize (wrong Node ABI, missing build, docker layer cache mismatch).
 */
export function createBetterSqlite3LoadError(cause: unknown): Error {
  const nodeVersion = process.version;
  const runtimeAbi = process.versions.modules;
  const requiredNode = '20.x';
  const causeMessage = cause instanceof Error ? cause.message : String(cause);

  // better-sqlite3 / NODE_MODULE_VERSION mismatches often mention the ABI the
  // binary was compiled for — surface it when present.
  const abiMatch = causeMessage.match(/NODE_MODULE_VERSION\s+(\d+)/i);
  const builtForAbi = abiMatch?.[1];

  const abiLine = builtForAbi
    ? `better-sqlite3 native binding was built for Node ABI ${builtForAbi}, but this process is ABI ${runtimeAbi}.`
    : `This process is Node ${nodeVersion} (ABI ${runtimeAbi}); the better-sqlite3 native binding failed to load.`;

  const message = [
    'Failed to load better-sqlite3 native binding.',
    abiLine,
    `Detected Node ${nodeVersion}; this project requires Node ${requiredNode} (see .nvmrc / package.json engines).`,
    'Fix: run `nvm use` (or install the pinned Node version), then `npm rebuild better-sqlite3`.',
    'If that still fails, clear the install and retry: `rm -rf node_modules && npm install`.',
    'See README.md#troubleshooting-local-setup for Docker/CI notes.',
    `Underlying error: ${causeMessage}`,
  ].join(' ');

  const err = new Error(message);
  err.name = 'BetterSqlite3LoadError';
  if (cause instanceof Error && cause.stack) {
    err.stack = `${err.stack}\nCaused by: ${cause.stack}`;
  }
  return err;
}

/** True when an error looks like a native-addon / ABI load failure. */
export function isBetterSqlite3LoadFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /better[_-]?sqlite3/i.test(msg) ||
    /NODE_MODULE_VERSION/i.test(msg) ||
    /was compiled against a different Node\.js version/i.test(msg) ||
    /Cannot find module.*better_sqlite3\.node/i.test(msg) ||
    /ERR_DLOPEN_FAILED/i.test(msg)
  );
}
