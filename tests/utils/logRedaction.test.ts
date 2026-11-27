import { redactLogArg, logWithoutRedaction } from '../../src/utils/logRedaction';
import config from '../../src/config';

describe('logRedaction', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRedactionEnabled = config.logRedaction.enabled;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    config.logRedaction.enabled = originalRedactionEnabled;
  });

  describe('wallet address masking', () => {
    beforeEach(() => {
      config.logRedaction.enabled = true;
    });

    it('masks Stellar public key (G...) keeping prefix and suffix', () => {
      const wallet = 'G' + 'A'.repeat(47) + 'WXYZ2345';
      const redacted = redactLogArg(wallet) as string;
      expect(redacted).toBe('G...2345');
    });

    it('masks Stellar secret key (S...) keeping prefix and suffix', () => {
      const secret = 'S' + 'A'.repeat(47) + 'WXYZ2345';
      const redacted = redactLogArg(secret) as string;
      expect(redacted).toBe('S...2345');
    });

    it('masks muxed account (M...) keeping prefix and suffix', () => {
      const muxed = 'M' + 'A'.repeat(60) + 'WXYZ2345';
      const redacted = redactLogArg(muxed) as string;
      expect(redacted).toBe('M...2345');
    });

    it('leaves strings shorter than a strkey untouched', () => {
      const shortWallet = 'GABC';
      const redacted = redactLogArg(shortWallet) as string;
      expect(redacted).toBe('GABC');
    });

    it('does not mask non-strkey strings', () => {
      const regularString = 'regular-string-123';
      const redacted = redactLogArg(regularString) as string;
      expect(redacted).toBe(regularString);
    });
  });

  describe('sensitive key dropping', () => {
    beforeEach(() => {
      config.logRedaction.enabled = true;
    });

    it('drops token key', () => {
      const obj = { token: 'secret-token', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.token).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops authorization key', () => {
      const obj = { authorization: 'Bearer secret', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.authorization).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops secret key', () => {
      const obj = { secret: 'my-secret', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.secret).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops apikey key', () => {
      const obj = { apikey: 'api-key-123', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.apikey).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops api_key key', () => {
      const obj = { api_key: 'api-key-123', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.api_key).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops password key', () => {
      const obj = { password: 'pass123', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.password).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops x-api-key key', () => {
      const obj = { 'x-api-key': 'api-key-123', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted['x-api-key']).toBeUndefined();
      expect(redacted.other).toBe('value');
    });

    it('drops multiple sensitive keys in one object', () => {
      const obj = {
        token: 'secret',
        password: 'pass',
        safe: 'value',
      };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.token).toBeUndefined();
      expect(redacted.password).toBeUndefined();
      expect(redacted.safe).toBe('value');
    });

    it('is case-insensitive for key matching', () => {
      const obj = { TOKEN: 'secret', Password: 'pass' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.TOKEN).toBeUndefined();
      expect(redacted.Password).toBeUndefined();
    });
  });

  describe('nested object redaction', () => {
    beforeEach(() => {
      config.logRedaction.enabled = true;
    });

    it('recursively redacts nested objects', () => {
      const obj = {
        user: {
          wallet: 'G' + 'A'.repeat(47) + 'WXYZ2345',
          token: 'secret',
        },
        safe: 'value',
      };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect((redacted.user as Record<string, unknown>).wallet).toBe('G...2345');
      expect((redacted.user as Record<string, unknown>).token).toBeUndefined();
      expect(redacted.safe).toBe('value');
    });

    it('handles deeply nested objects', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              secret: 'deep-secret',
            },
          },
        },
      };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(
        ((redacted.level1 as Record<string, unknown>).level2 as Record<string, unknown>).level3,
      ).toEqual({});
    });
  });

  describe('array redaction', () => {
    beforeEach(() => {
      config.logRedaction.enabled = true;
    });

    it('redacts wallet addresses in arrays', () => {
      const arr = ['G' + 'A'.repeat(47) + 'WXYZ2345', 'other'];
      const redacted = redactLogArg(arr) as unknown[];
      expect(redacted[0]).toBe('G...2345');
      expect(redacted[1]).toBe('other');
    });

    it('redacts objects in arrays', () => {
      const arr = [{ token: 'secret' }, { safe: 'value' }];
      const redacted = redactLogArg(arr) as Record<string, unknown>[];
      expect(redacted[0].token).toBeUndefined();
      expect(redacted[1].safe).toBe('value');
    });
  });

  describe('correlation ID hashing', () => {
    beforeEach(() => {
      config.logRedaction.enabled = true;
      config.logRedaction.hashCorrelationIds = true;
    });

    afterEach(() => {
      config.logRedaction.hashCorrelationIds = false;
    });

    it('hashes correlationId in strings', () => {
      const str = 'correlationId=abc-123-def';
      const redacted = redactLogArg(str) as string;
      expect(redacted).toMatch(/^correlationId=[a-f0-9]{8}$/);
      expect(redacted).not.toContain('abc-123-def');
    });

    it('hashes cid in strings', () => {
      const str = 'cid=xyz-789';
      const redacted = redactLogArg(str) as string;
      expect(redacted).toMatch(/^cid=[a-f0-9]{8}$/);
      expect(redacted).not.toContain('xyz-789');
    });

    it('produces consistent hashes for same input', () => {
      const str = 'correlationId=test-123';
      const redacted1 = redactLogArg(str) as string;
      const redacted2 = redactLogArg(str) as string;
      expect(redacted1).toBe(redacted2);
    });

    it('hashes correlationId in object values', () => {
      const obj = { correlationId: 'abc-123-def', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.correlationId).toMatch(/^[a-f0-9]{8}$/);
      expect(redacted.correlationId).not.toBe('abc-123-def');
      expect(redacted.other).toBe('value');
    });

    it('hashes cid in object values', () => {
      const obj = { cid: 'xyz-789', other: 'value' };
      const redacted = redactLogArg(obj) as Record<string, unknown>;
      expect(redacted.cid).toMatch(/^[a-f0-9]{8}$/);
      expect(redacted.cid).not.toBe('xyz-789');
      expect(redacted.other).toBe('value');
    });

    it('does not hash correlation IDs when disabled', () => {
      config.logRedaction.hashCorrelationIds = false;
      const str = 'correlationId=abc-123-def';
      const redacted = redactLogArg(str) as string;
      expect(redacted).toBe(str);
    });
  });

  describe('environment-based redaction', () => {
    it('disables redaction when config.logRedaction.enabled is false (development default)', () => {
      // redactLogArg closes over the singleton config; toggle it directly
      // rather than re-importing (the top-level import is already bound).
      config.logRedaction.enabled = false;

      const wallet = 'G' + 'A'.repeat(47) + 'WXYZ2345';
      const redacted = redactLogArg(wallet);
      expect(redacted).toBe(wallet);
    });

    it('enables redaction in staging by default', async () => {
      process.env.NODE_ENV = 'staging';
      process.env.ADMIN_WALLET = 'GADMINWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      // Placeholder secrets like 'test-secret' are rejected outside dev/test.
      process.env.JWT_SECRET = 'k8Zq3vN1pW7xR4tY9bM2cF6hJ0lD5sGaQe';
      process.env.PLATFORM_SECRET_KEY = 'SPLATFORMSECRETKEY1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      jest.resetModules();
      const configModule = await import('../../src/config');
      const stagingConfig = configModule.default;

      expect(stagingConfig.logRedaction.enabled).toBe(true);
    });
  });

  describe('logWithoutRedaction', () => {
    it('is exported as a function', () => {
      expect(typeof logWithoutRedaction).toBe('function');
    });
  });
});
