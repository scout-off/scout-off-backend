import { auditSecretAccess } from '../../src/secrets/audit';
import { EnvSecretsProvider } from '../../src/secrets/envProvider';
import { logger } from '../../src/utils/logger';

// Audit events go through the shared logger as a structured object (#1853).

describe('auditSecretAccess', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => true);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('emits a JSON audit event with a timestamp', () => {
    auditSecretAccess({
      action: 'get',
      name: 'SOME_SECRET',
      provider: 'env',
      found: true,
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: 'secrets_audit',
      action: 'get',
      name: 'SOME_SECRET',
      provider: 'env',
      found: true,
    });
  });

  it('includes optional detail when provided', () => {
    auditSecretAccess({
      action: 'refresh',
      name: '*',
      provider: 'env',
      found: true,
      detail: 'noop-env',
    });

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.detail).toBe('noop-env');
  });

  it('never includes secret values in the payload', () => {
    auditSecretAccess({
      action: 'get',
      name: 'SOME_SECRET',
      provider: 'env',
      found: true,
    });

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ['action', 'event', 'found', 'name', 'provider'].sort(),
    );
  });
});

describe('EnvSecretsProvider', () => {
  const SECRET_NAME = 'SCOUT_TEST_ENV_PROVIDER_SECRET';
  let infoSpy: jest.SpyInstance;
  let provider: EnvSecretsProvider;

  const lastEvent = (): Record<string, unknown> =>
    infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0] as Record<string, unknown>;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => true);
    provider = new EnvSecretsProvider();
    delete process.env[SECRET_NAME];
  });

  afterEach(() => {
    infoSpy.mockRestore();
    delete process.env[SECRET_NAME];
  });

  it('exposes the env provider kind', () => {
    expect(provider.kind).toBe('env');
  });

  it('returns the value from process.env and audits a successful get', () => {
    process.env[SECRET_NAME] = 'super-secret-value';

    expect(provider.get(SECRET_NAME)).toBe('super-secret-value');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(lastEvent()).toMatchObject({
      action: 'get',
      name: SECRET_NAME,
      provider: 'env',
      found: true,
    });
    expect(JSON.stringify(infoSpy.mock.calls[0])).not.toContain('super-secret-value');
  });

  it('returns undefined and audits found=false for a missing secret', () => {
    expect(provider.get(SECRET_NAME)).toBeUndefined();
    expect(lastEvent()).toMatchObject({
      action: 'get',
      name: SECRET_NAME,
      provider: 'env',
      found: false,
    });
  });

  it('treats an empty string as missing', () => {
    process.env[SECRET_NAME] = '';

    expect(provider.get(SECRET_NAME)).toBeUndefined();
    expect(lastEvent()).toMatchObject({ action: 'get', found: false });
  });

  it('reads live values on every get (no caching)', () => {
    process.env[SECRET_NAME] = 'first';
    expect(provider.get(SECRET_NAME)).toBe('first');

    process.env[SECRET_NAME] = 'second';
    expect(provider.get(SECRET_NAME)).toBe('second');
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  it('refresh is an audited no-op for a named secret', async () => {
    process.env[SECRET_NAME] = 'unchanged';

    await expect(provider.refresh(SECRET_NAME)).resolves.toBeUndefined();

    expect(lastEvent()).toMatchObject({
      action: 'refresh',
      name: SECRET_NAME,
      provider: 'env',
      found: true,
      detail: 'noop-env',
    });
    expect(provider.get(SECRET_NAME)).toBe('unchanged');
  });

  it('refresh without a name audits a bulk refresh with name "*"', async () => {
    await provider.refresh();

    expect(lastEvent()).toMatchObject({
      action: 'refresh',
      name: '*',
      provider: 'env',
      found: true,
      detail: 'noop-env',
    });
  });
});
