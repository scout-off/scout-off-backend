import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateRuntimeEnv, findStaleExampleKeys } from '../scripts/validate-env';

describe('validate-env runtime validation', () => {
  it('should pass on a complete valid config (NODE_ENV=development)', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass on a complete valid config (NODE_ENV=production)', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass when NODE_ENV is unset (defaults to development)', () => {
    const env = {
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error when CONTRACT_ID is missing', () => {
    const env = {
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: CONTRACT_ID');
  });

  it('should report an error when JWT_SECRET is missing', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: JWT_SECRET');
  });

  it('should report both errors when CONTRACT_ID and JWT_SECRET are missing', () => {
    const env = {
      NODE_ENV: 'development',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: CONTRACT_ID');
    expect(errors).toContain('Missing required environment variable: JWT_SECRET');
    expect(errors.length).toBe(2);
  });

  it('should report an error on a malformed/invalid NODE_ENV value', () => {
    const env = {
      NODE_ENV: 'invalid_env',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'NODE_ENV="invalid_env" is invalid. Must be one of: development, test, production'
    );
  });

  it('should pass on valid CORS_ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      CORS_ALLOWED_ORIGINS: 'https://app.scoutoff.io,https://staging.scoutoff.io',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error on malformed CORS_ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      CORS_ALLOWED_ORIGINS: 'invalid-origin-without-protocol',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'Invalid CORS origin format: "invalid-origin-without-protocol". Origins must be "*" or start with http:// or https://'
    );
  });

  it('should pass when PINATA_GATEWAY is a valid HTTPS URL', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      PINATA_GATEWAY: 'https://gateway.pinata.cloud',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass when PINATA_GATEWAY is unset', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error when PINATA_GATEWAY is HTTP instead of HTTPS', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      PINATA_GATEWAY: 'http://gateway.pinata.cloud',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'PINATA_GATEWAY="http://gateway.pinata.cloud" is invalid. Must be a valid HTTPS URL.'
    );
  });

  it('should report an error when PINATA_GATEWAY is not a valid URL', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      PINATA_GATEWAY: 'not-a-url',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'PINATA_GATEWAY="not-a-url" is invalid. Must be a valid HTTPS URL.'
    );
  });
});

describe('DB_DRIVER validation', () => {
  const baseEnv = {
    NODE_ENV: 'development',
    CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    JWT_SECRET: 'test-secret',
  };

  it('passes when DB_DRIVER is "sqlite"', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: 'sqlite' });
    expect(errors).toEqual([]);
  });

  it('passes when DB_DRIVER is "postgres"', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: 'postgres' });
    expect(errors).toEqual([]);
  });

  it('passes when DB_DRIVER is unset (defaults to sqlite)', () => {
    const errors = validateRuntimeEnv({ ...baseEnv });
    expect(errors).toEqual([]);
  });

  it('rejects a typo like "Postgres" (wrong case)', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: 'Postgres' });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/DB_DRIVER="Postgres" is invalid/);
    expect(errors[0]).toMatch(/sqlite.*postgres|postgres.*sqlite/i);
  });

  it('rejects a typo like "postgresql"', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: 'postgresql' });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/DB_DRIVER="postgresql" is invalid/);
  });

  it('rejects a value with a stray space like " postgres"', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: ' postgres' });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/DB_DRIVER=" postgres" is invalid/);
  });

  it('error message names the invalid value clearly', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: 'mysql' });
    expect(errors[0]).toContain('mysql');
  });

  it('error message lists the valid options', () => {
    const errors = validateRuntimeEnv({ ...baseEnv, DB_DRIVER: 'badval' });
    expect(errors[0]).toContain('sqlite');
    expect(errors[0]).toContain('postgres');
  });
});
