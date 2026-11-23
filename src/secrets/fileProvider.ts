import { watch as watchDirectory, FSWatcher, readFileSync } from 'fs';
import path from 'path';
import { auditSecretAccess } from './audit';
import { SECRET_NAMES, SecretsProvider, SecretName } from './types';

const KNOWN_SECRETS = new Set<string>(SECRET_NAMES);
const DEFAULT_REFRESH_INTERVAL_MS = 1000;

/**
 * Reads Kubernetes/Docker mounted secret files named after their environment
 * variables. Directory watching plus polling handles projected-volume symlink
 * swaps as well as regular file updates.
 */
export class FileSecretsProvider implements SecretsProvider {
  readonly kind = 'file' as const;
  private readonly values = new Map<SecretName, string | undefined>();
  private readonly subscribers = new Set<(name: string, value: string | undefined) => void>();
  private watcher: FSWatcher | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly directory: string = process.env.SECRETS_DIR ?? '/run/secrets',
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  ) {}

  get(name: string): string | undefined {
    const secretName = this.validateName(name);
    const value = this.read(secretName);
    this.apply(secretName, value);
    auditSecretAccess({
      action: 'get',
      name,
      provider: this.kind,
      found: value !== undefined,
    });
    return value;
  }

  async refresh(name?: string): Promise<void> {
    const names = name === undefined ? SECRET_NAMES : [this.validateName(name)];
    for (const secretName of names) {
      const value = this.read(secretName);
      this.apply(secretName, value);
      auditSecretAccess({
        action: 'refresh',
        name: secretName,
        provider: this.kind,
        found: value !== undefined,
      });
    }
  }

  private refreshChangedValues(): void {
    for (const name of SECRET_NAMES) this.apply(name, this.read(name));
  }

  watch(onChange: (name: string, value: string | undefined) => void): () => void {
    for (const name of SECRET_NAMES) this.values.set(name, this.read(name));
    this.subscribers.add(onChange);
    this.startWatching();
    auditSecretAccess({
      action: 'watch',
      name: '*',
      provider: this.kind,
      found: true,
    });
    return () => this.subscribers.delete(onChange);
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.subscribers.clear();
  }

  private validateName(name: string): SecretName {
    if (!KNOWN_SECRETS.has(name)) {
      throw new Error(`Unknown secret name: ${name}`);
    }
    return name as SecretName;
  }

  private read(name: SecretName): string | undefined {
    try {
      return readFileSync(path.join(this.directory, name), 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private apply(name: SecretName, value: string | undefined): void {
    if (this.values.has(name) && this.values.get(name) === value) return;
    const previouslyKnown = this.values.has(name);
    this.values.set(name, value);
    if (!previouslyKnown) return;

    auditSecretAccess({
      action: 'apply',
      name,
      provider: this.kind,
      found: value !== undefined,
    });
    for (const subscriber of this.subscribers) subscriber(name, value);
  }

  private startWatching(): void {
    if (this.watcher) return;
    this.watcher = watchDirectory(this.directory, () => {
      try {
        this.refreshChangedValues();
      } catch (err) {
        this.reportRefreshError(err);
      }
    });
    this.refreshTimer = setInterval(() => {
      try {
        this.refreshChangedValues();
      } catch (err) {
        this.reportRefreshError(err);
      }
    }, this.refreshIntervalMs);
    this.refreshTimer.unref();
  }

  private reportRefreshError(err: unknown): void {
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    auditSecretAccess({
      action: 'refresh',
      name: '*',
      provider: this.kind,
      found: false,
      detail: errorName,
    });
    console.error(`[secrets] file provider refresh failed (${errorName})`);
  }
}
