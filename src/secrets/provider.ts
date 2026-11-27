import { EnvSecretsProvider } from './envProvider';
import { FileSecretsProvider } from './fileProvider';
import type { SecretsProvider } from './types';

// No dotenv.config() here: src/config.ts owns .env loading and deliberately
// skips it in production/staging unless DOTENV_ENABLED=true.

function createProvider(): SecretsProvider {
  const kind = process.env.SECRETS_PROVIDER ?? 'env';
  if (kind === 'env') return new EnvSecretsProvider();
  if (kind === 'file') return new FileSecretsProvider();
  throw new Error(`Unsupported SECRETS_PROVIDER "${kind}". Supported providers: env, file`);
}

export const secretsProvider = createProvider();

if (secretsProvider.kind === 'file') {
  // Deferred: watch() emits an audit event through the logger, and this module
  // is first imported while src/config.ts (which the logger depends on) is
  // still evaluating.
  queueMicrotask(() => secretsProvider.watch?.(() => undefined));
  process.once('exit', () => secretsProvider.close?.());
}

export function getSecret(name: string): string | undefined {
  return secretsProvider.get(name);
}

/** Read a secret without a per-read audit event (see SecretsProvider.peek). */
export function readSecret(name: string): string | undefined {
  return secretsProvider.peek(name);
}
