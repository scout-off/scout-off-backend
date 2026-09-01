/**
 * Audit trail for secrets-provider access (#1115).
 *
 * IMPORTANT: never include secret values in audit payloads. Only the secret
 * name, action, provider kind, and whether a value was found are recorded.
 *
 * Uses console directly to avoid a circular import with `logger` → `config`
 * → `secrets` → `logger`.
 */

export type SecretsAuditAction = 'get' | 'refresh' | 'watch' | 'apply';

export interface SecretsAuditEvent {
  action: SecretsAuditAction;
  /** Logical secret name, or `*` for bulk refresh. */
  name: string;
  provider: string;
  found: boolean;
  /** Optional detail (e.g. error class) — never a secret value. */
  detail?: string;
}

export function auditSecretAccess(event: SecretsAuditEvent): void {
  const payload = {
    ...event,
    ts: new Date().toISOString(),
  };
  console.info('[secrets-audit]', JSON.stringify(payload));
}
