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

  it('throws for an invalid secret key', async () => {
    process.env.PLATFORM_SECRET_KEY = 'INVALID_KEY';
    jest.resetModules();
    await expect(import('../../src/utils/signer')).rejects.toThrow();
  });
});
