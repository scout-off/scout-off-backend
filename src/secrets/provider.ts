import dotenv from 'dotenv';
import { EnvSecretsProvider } from './envProvider';
import { FileSecretsProvider } from './fileProvider';
import type { SecretsProvider } from './types';

dotenv.config();

function createProvider(): SecretsProvider {
  const kind = process.env.SECRETS_PROVIDER ?? 'env';
  if (kind === 'env') return new EnvSecretsProvider();
  if (kind === 'file') return new FileSecretsProvider();
  throw new Error(`Unsupported SECRETS_PROVIDER "${kind}". Supported providers: env, file`);
}

export const secretsProvider = createProvider();

if (secretsProvider.kind === 'file') {
  secretsProvider.watch?.(() => undefined);
  process.once('exit', () => secretsProvider.close?.());
}

export function getSecret(name: string): string | undefined {
  return secretsProvider.get(name);
}
