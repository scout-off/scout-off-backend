import { auditSecretAccess } from './audit';
import type { SecretsProvider } from './types';

/**
 * Default secrets provider: reads from `process.env` on every `get`.
 * No remote cache — `refresh` is an audited no-op.
 */
export class EnvSecretsProvider implements SecretsProvider {
  readonly kind = 'env' as const;

  get(name: string): string | undefined {
    const raw = process.env[name];
    const value = raw && raw.length > 0 ? raw : undefined;
    auditSecretAccess({
      action: 'get',
      name,
      provider: this.kind,
      found: value !== undefined,
    });
    return value;
  }

  async refresh(name?: string): Promise<void> {
    auditSecretAccess({
      action: 'refresh',
      name: name ?? '*',
      provider: this.kind,
      found: true,
      detail: 'noop-env',
    });
  }
}
