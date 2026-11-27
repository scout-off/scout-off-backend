import { Keypair } from '@stellar/stellar-sdk';

const VALID_SECRET = 'SDAT3WOW2WIVH5VRHJDRKXZ7I5IAOGFK7CDPT4GKJKW2LDQ3YMJ56QJQ';
// Dummy keypair for testing only — not used in any real environment

describe('getPlatformKeypair', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    jest.resetModules();
  });

  it('returns a Keypair when PLATFORM_SECRET_KEY is a valid secret', async () => {
    process.env.PLATFORM_SECRET_KEY = VALID_SECRET;
    jest.resetModules();
    const { getPlatformKeypair } = await import('../../src/utils/signer');
    const kp = getPlatformKeypair();
    expect(typeof kp.publicKey()).toBe('string');
    expect(kp.publicKey()).toMatch(/^G/);
  });

  it('returns the same keypair instance on multiple calls (loaded once)', async () => {
    process.env.PLATFORM_SECRET_KEY = VALID_SECRET;
    jest.resetModules();
    const { getPlatformKeypair } = await import('../../src/utils/signer');
    expect(getPlatformKeypair()).toBe(getPlatformKeypair());
  });

  it('rebuilds the signing keypair after the provider value rotates', async () => {
    process.env.PLATFORM_SECRET_KEY = VALID_SECRET;
    jest.resetModules();
    const { getPlatformKeypair } = await import('../../src/utils/signer');
    const initial = getPlatformKeypair();
    const rotatedSecret = Keypair.random().secret();
    process.env.PLATFORM_SECRET_KEY = rotatedSecret;

    const rotated = getPlatformKeypair();

    expect(rotated.publicKey()).not.toBe(initial.publicKey());
    expect(getPlatformKeypair()).toBe(rotated);
  });

  it('throws for an invalid secret key', async () => {
    process.env.PLATFORM_SECRET_KEY = 'INVALID_KEY';
    jest.resetModules();
    await expect(import('../../src/utils/signer')).rejects.toThrow();
  });

  it('can load without a platform key in test environments', async () => {
    process.env.NODE_ENV = 'test';
    process.env.PLATFORM_SECRET_KEY = '';
    process.env.STELLAR_SECRET_KEY = '';
    jest.resetModules();

    await expect(import('../../src/utils/signer')).resolves.toHaveProperty('getPlatformKeypair');
  });
});
