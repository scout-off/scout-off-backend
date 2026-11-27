/**
 * Audit trail for secrets-provider access (#1115).
 *
 * IMPORTANT: never include secret values in audit payloads. Only the secret
 * name, action, provider kind, and whether a value was found are recorded.
 *
 * Emitted through the shared logger so audit lines carry the standard level
 * prefix, redaction and correlation ID.
 */

import { logger } from '../utils/logger';
import { getCorrelationId } from '../utils/requestContext';

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
  const payload: Record<string, unknown> = {
    event: 'secrets_audit',
    action: event.action,
    name: event.name,
    provider: event.provider,
    found: event.found,
  };
  if (event.detail !== undefined) payload.detail = event.detail;
  const correlationId = getCorrelationId();
  if (correlationId) payload.correlationId = correlationId;
  logger.info(payload);
}
