import { auditSecretAccess } from './audit';
import type { SecretsProvider } from './types';

/**
 * Default secrets provider: reads from `process.env` on every `get`.
 * No remote cache — `refresh` is an audited no-op.
 */
export class EnvSecretsProvider implements SecretsProvider {
  readonly kind = 'env' as const;

  peek(name: string): string | undefined {
    const raw = process.env[name];
    return raw && raw.length > 0 ? raw : undefined;
  }

  get(name: string): string | undefined {
    const value = this.peek(name);
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
