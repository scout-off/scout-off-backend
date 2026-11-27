import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { FileSecretsProvider } from '../../src/secrets/fileProvider';

describe('FileSecretsProvider', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'scout-secrets-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads named secret files, strips the mounted newline, and reports missing values', () => {
    writeFileSync(path.join(directory, 'JWT_SECRET'), 'initial-secret\n');
    const provider = new FileSecretsProvider(directory);
    const audit = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    expect(provider.get('JWT_SECRET')).toBe('initial-secret');
    expect(provider.get('PINATA_SECRET')).toBeUndefined();
    expect(() => provider.get('../JWT_SECRET')).toThrow('Unknown secret name');

    audit.mockRestore();
    provider.close();
  });

  it('notifies subscribers when a mounted secret changes', async () => {
    writeFileSync(path.join(directory, 'JWT_SECRET'), 'before');
    const provider = new FileSecretsProvider(directory, 10);
    const audit = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const changed = jest.fn();
    const unsubscribe = provider.watch(changed);

    writeFileSync(path.join(directory, 'JWT_SECRET'), 'after');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(changed).toHaveBeenCalledWith('JWT_SECRET', 'after');
    expect(provider.get('JWT_SECRET')).toBe('after');

    unsubscribe();
    provider.close();
    audit.mockRestore();
  });

  it('serves updated files through config getters without a module restart', async () => {
    const savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      SECRETS_PROVIDER: process.env.SECRETS_PROVIDER,
      SECRETS_DIR: process.env.SECRETS_DIR,
      CONTRACT_ID: process.env.CONTRACT_ID,
    };
    process.env.NODE_ENV = 'test';
    process.env.SECRETS_PROVIDER = 'file';
    process.env.SECRETS_DIR = directory;
    process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    writeFileSync(path.join(directory, 'JWT_SECRET'), 'before');
    jest.resetModules();

    try {
      const { default: config } = await import('../../src/config');
      expect(config.jwtSecret).toBe('before');
      writeFileSync(path.join(directory, 'JWT_SECRET'), 'after');
      expect(config.jwtSecret).toBe('after');
    } finally {
      const { secretsProvider } = await import('../../src/secrets/provider');
      secretsProvider.close?.();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.resetModules();
    }
  });
});
