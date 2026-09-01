/**
 * Pluggable secrets provider (#1115).
 *
 * Long-lived secrets are resolved through this interface instead of reading
 * `process.env` ad hoc. The default implementation is env-var based; Vault /
 * cloud KMS providers cache remote values and can refresh without a restart.
 */

/** Logical secret names the backend understands. */
export const SECRET_NAMES = [
  'JWT_SECRET',
  'JWT_SECRET_PREVIOUS',
  'SEP10_SERVER_SECRET',
  'SEP10_SERVER_SECRET_PREVIOUS',
  'API_KEY_LOOKUP_SECRET',
  'API_KEY_LOOKUP_SECRET_PREVIOUS',
  'WEBHOOK_SECRET_ENCRYPTION_KEY',
  'WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS',
  'PLATFORM_SECRET_KEY',
  'PLATFORM_SECRET',
  'PINATA_API_KEY',
  'PINATA_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Rotation class for operators (see docs/secrets-rotation.md).
 *
 * - `hot` — value can be refreshed in-place via provider.refresh(); brief
 *   inconsistency across instances is acceptable.
 * - `dual-window` — current + previous accepted during a grace window;
 *   new material is issued/signed with current only.
 * - `migration-required` — rotating requires a data migration or re-encryption
 *   step (tooling/docs) before the old value can be discarded.
 */
export type RotationClass = 'hot' | 'dual-window' | 'migration-required';

export const SECRET_ROTATION_CLASS: Readonly<Record<SecretName, RotationClass>> = {
  JWT_SECRET: 'dual-window',
  JWT_SECRET_PREVIOUS: 'dual-window',
  SEP10_SERVER_SECRET: 'dual-window',
  SEP10_SERVER_SECRET_PREVIOUS: 'dual-window',
  API_KEY_LOOKUP_SECRET: 'dual-window',
  API_KEY_LOOKUP_SECRET_PREVIOUS: 'dual-window',
  WEBHOOK_SECRET_ENCRYPTION_KEY: 'migration-required',
  WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS: 'migration-required',
  PLATFORM_SECRET_KEY: 'hot',
  PLATFORM_SECRET: 'hot',
  PINATA_API_KEY: 'hot',
  PINATA_SECRET: 'hot',
};

export interface SecretsProvider {
  /** Provider kind selected by `SECRETS_PROVIDER` (env | vault | kms). */
  readonly kind: 'env' | 'vault' | 'kms';

  /**
   * Resolve a secret by name. Never logs the value.
   * Access is audited (name + found boolean only).
   */
  get(name: string): string | undefined;

  /**
   * Refresh cached secrets from the backing store. Env provider is a no-op
   * (values are always read live from process.env). Vault/KMS re-fetch.
   */
  refresh?(name?: string): Promise<void>;

  /**
   * Subscribe to secret changes (provider-pushed or post-refresh).
   * Returns an unsubscribe function. Optional — env provider may omit.
   */
  watch?(onChange: (name: string, value: string | undefined) => void): () => void;
}

export type SecretsProviderKind = SecretsProvider['kind'];
