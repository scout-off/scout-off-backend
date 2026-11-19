import { auditSecretAccess } from '../../src/secrets/audit';
import { EnvSecretsProvider } from '../../src/secrets/envProvider';

describe('auditSecretAccess', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
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
    const [prefix, raw] = infoSpy.mock.calls[0] as [string, string];
    expect(prefix).toBe('[secrets-audit]');

    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: 'get',
      name: 'SOME_SECRET',
      provider: 'env',
      found: true,
    });
    expect(typeof payload.ts).toBe('string');
    expect(Number.isNaN(Date.parse(payload.ts as string))).toBe(false);
  });

  it('includes optional detail when provided', () => {
    auditSecretAccess({
      action: 'refresh',
      name: '*',
      provider: 'env',
      found: true,
      detail: 'noop-env',
    });

    const payload = JSON.parse(infoSpy.mock.calls[0][1] as string);
    expect(payload.detail).toBe('noop-env');
  });

  it('never includes secret values in the payload', () => {
    auditSecretAccess({
      action: 'get',
      name: 'SOME_SECRET',
      provider: 'env',
      found: true,
    });

    const raw = infoSpy.mock.calls[0][1] as string;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(
      ['action', 'found', 'name', 'provider', 'ts'].sort(),
    );
  });
});

describe('EnvSecretsProvider', () => {
  const SECRET_NAME = 'SCOUT_TEST_ENV_PROVIDER_SECRET';
  let infoSpy: jest.SpyInstance;
  let provider: EnvSecretsProvider;

  const lastEvent = (): Record<string, unknown> =>
    JSON.parse(infoSpy.mock.calls[infoSpy.mock.calls.length - 1][1] as string);

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
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
    expect(infoSpy.mock.calls[0][1]).not.toContain('super-secret-value');
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

    expect(provider.get(SECRET_NAME)).toBe('unchanged');
    expect(lastEvent()).toMatchObject({
      action: 'refresh',
      name: SECRET_NAME,
      provider: 'env',
      found: true,
      detail: 'noop-env',
    });
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
