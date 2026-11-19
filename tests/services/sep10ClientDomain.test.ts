/**
 * SEP-10 client_domain support (#1514).
 *
 * The stellar.toml "server" is a fake https.request + resolver injected into
 * safeFetch, so these tests never touch the network.
 */
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { RequestOptions } from 'http';
import { Keypair, Transaction, Networks, Operation } from '@stellar/stellar-sdk';
import config from '../../src/config';
import {
  buildChallenge,
  verifyChallenge,
  normalizeClientDomain,
  parseSigningKey,
  resolveClientDomainSigningKey,
  clearClientDomainCache,
  getErrorMapping,
  Sep10Error,
  Sep10ErrorCode,
} from '../../src/services/sep10';
import type { Resolver, RequestFn } from '../../src/utils/safeFetch';

const PUBLIC_IP = '93.184.216.34';
const DOMAIN = 'wallet.example.com';

const publicResolver: Resolver = async () => [{ address: PUBLIC_IP, family: 4 }];

function tomlServer(body: string | Buffer, seen: RequestOptions[] = []): RequestFn {
  return ((options: RequestOptions, cb: (res: never) => void) => {
    seen.push(options);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void; setTimeout(): void };
    req.setTimeout = () => undefined;
    req.destroy = () => undefined;
    req.end = () => {
      const res = Readable.from([Buffer.from(body)]);
      Object.assign(res, { statusCode: 200, headers: { 'content-type': 'text/plain' } });
      setImmediate(() => cb(res as never));
    };
    return req as never;
  }) as RequestFn;
}

/** A server that never answers: fires the request timeout immediately. */
const hangingServer: RequestFn = (() => {
  const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void; setTimeout(ms: number, cb: () => void): void };
  req.setTimeout = (_ms, cb) => setImmediate(cb);
  req.destroy = () => undefined;
  req.end = () => undefined;
  return req as never;
}) as unknown as RequestFn;

function signedChallenge(signers: Keypair[], client: Keypair, clientDomain?: { domain: string; signingKey: string }): string {
  const tx = new Transaction(buildChallenge(client.publicKey(), clientDomain), Networks.TESTNET);
  for (const kp of signers) tx.sign(kp);
  return tx.toXdr();
}

afterEach(() => {
  clearClientDomainCache();
  config.sep10ClientDomainRequired = false;
  config.sep10ClientDomainAllowlist = [];
});

describe('normalizeClientDomain', () => {
  it('accepts and lower-cases a bare hostname', () => {
    expect(normalizeClientDomain('Wallet.Example.COM')).toBe('wallet.example.com');
  });

  it.each(['https://wallet.example.com', 'wallet.example.com:8443', 'wallet.example.com/path', 'localhost', '10.0.0.1', ''])(
    'rejects %p',
    (raw) => {
      expect(() => normalizeClientDomain(raw)).toThrow(expect.objectContaining({ code: Sep10ErrorCode.INVALID_CLIENT_DOMAIN }));
    },
  );

  it('enforces the allowlist when configured', () => {
    config.sep10ClientDomainAllowlist = ['freighter.app'];
    expect(normalizeClientDomain('freighter.app')).toBe('freighter.app');
    expect(() => normalizeClientDomain(DOMAIN)).toThrow(expect.objectContaining({ code: Sep10ErrorCode.CLIENT_DOMAIN_NOT_ALLOWED }));
  });
});

describe('parseSigningKey', () => {
  const key = Keypair.random().publicKey();

  it('reads a top-level SIGNING_KEY', () => {
    expect(parseSigningKey(`VERSION="2.0.0"\nSIGNING_KEY = "${key}" # wallet key\n`)).toBe(key);
  });

  it('ignores SIGNING_KEY inside a table and invalid keys', () => {
    expect(parseSigningKey(`[DOCUMENTATION]\nSIGNING_KEY="${key}"\n`)).toBeNull();
    expect(parseSigningKey('SIGNING_KEY="GNOTAKEY"\n')).toBeNull();
  });
});

describe('resolveClientDomainSigningKey', () => {
  it('fetches /.well-known/stellar.toml and caches the key', async () => {
    const key = Keypair.random().publicKey();
    const seen: RequestOptions[] = [];
    const request = tomlServer(`SIGNING_KEY="${key}"\n`, seen);

    await expect(resolveClientDomainSigningKey(DOMAIN, { resolver: publicResolver, request })).resolves.toBe(key);
    await expect(resolveClientDomainSigningKey(DOMAIN, { resolver: publicResolver, request })).resolves.toBe(key);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hostname: DOMAIN, path: '/.well-known/stellar.toml' });
  });

  it('rejects domains resolving to private IPs (SSRF)', async () => {
    const seen: RequestOptions[] = [];
    const resolver: Resolver = async () => [{ address: '169.254.169.254', family: 4 }];
    await expect(resolveClientDomainSigningKey(DOMAIN, { resolver, request: tomlServer('x', seen) }))
      .rejects.toMatchObject({ code: Sep10ErrorCode.CLIENT_DOMAIN_TOML_FETCH_FAILED, message: expect.stringContaining('blocked_ip') });
    expect(seen).toHaveLength(0);
  });

  it('fails on a TOML timeout', async () => {
    await expect(resolveClientDomainSigningKey(DOMAIN, { resolver: publicResolver, request: hangingServer }))
      .rejects.toMatchObject({ code: Sep10ErrorCode.CLIENT_DOMAIN_TOML_FETCH_FAILED, message: expect.stringContaining('timeout') });
  });

  it('fails on an oversized TOML', async () => {
    const huge = Buffer.alloc(100 * 1024 + 1, 'a');
    await expect(resolveClientDomainSigningKey(DOMAIN, { resolver: publicResolver, request: tomlServer(huge) }))
      .rejects.toMatchObject({ code: Sep10ErrorCode.CLIENT_DOMAIN_TOML_FETCH_FAILED, message: expect.stringContaining('too_large') });
  });

  it('fails when SIGNING_KEY is missing', async () => {
    await expect(resolveClientDomainSigningKey(DOMAIN, { resolver: publicResolver, request: tomlServer('VERSION="2.0.0"\n') }))
      .rejects.toMatchObject({ code: Sep10ErrorCode.CLIENT_DOMAIN_SIGNING_KEY_MISSING });
  });
});

describe('client_domain challenge', () => {
  const client = Keypair.random();
  const walletSigner = Keypair.random();
  const clientDomain = { domain: DOMAIN, signingKey: walletSigner.publicKey() };

  it('adds a client_domain manageData op sourced by the wallet signing key', () => {
    const tx = new Transaction(buildChallenge(client.publicKey(), clientDomain), Networks.TESTNET);
    const op = tx.operations.find((o) => (o as Operation.ManageData).name === 'client_domain') as Operation.ManageData;

    expect(op).toBeDefined();
    expect(op.source).toBe(walletSigner.publicKey());
    expect(Buffer.from(op.value!).toString()).toBe(DOMAIN);
  });

  it('returns the verified client_domain when both client and wallet signed', () => {
    expect(verifyChallenge(signedChallenge([client, walletSigner], client, clientDomain)))
      .toEqual({ account: client.publicKey(), clientDomain: DOMAIN });
  });

  it('fails without the client_domain signature', () => {
    expect(() => verifyChallenge(signedChallenge([client], client, clientDomain)))
      .toThrow(expect.objectContaining({ code: Sep10ErrorCode.MISSING_CLIENT_DOMAIN_SIGNATURE }));
  });

  it('fails when signed by the wrong wallet key', () => {
    expect(() => verifyChallenge(signedChallenge([client, Keypair.random()], client, clientDomain)))
      .toThrow(expect.objectContaining({ code: Sep10ErrorCode.MISSING_CLIENT_DOMAIN_SIGNATURE }));
  });

  it('rejects challenges without client_domain in required mode', () => {
    config.sep10ClientDomainRequired = true;
    expect(() => verifyChallenge(signedChallenge([client], client)))
      .toThrow(expect.objectContaining({ code: Sep10ErrorCode.CLIENT_DOMAIN_REQUIRED }));
  });

  it('keeps the existing flow unchanged when client_domain is not used', () => {
    expect(verifyChallenge(signedChallenge([client], client))).toEqual({ account: client.publicKey() });
  });

  it('maps the new error codes', () => {
    expect(getErrorMapping(Sep10ErrorCode.MISSING_CLIENT_DOMAIN_SIGNATURE).httpStatus).toBe(401);
    expect(getErrorMapping(Sep10ErrorCode.INVALID_CLIENT_DOMAIN).httpStatus).toBe(400);
    expect(getErrorMapping(Sep10ErrorCode.CLIENT_DOMAIN_TOML_FETCH_FAILED).errorCode).toBe('CLIENT_DOMAIN_TOML_FETCH_FAILED');
    expect(getErrorMapping(Sep10ErrorCode.CLIENT_DOMAIN_SIGNING_KEY_MISSING).errorCode).toBe('CLIENT_DOMAIN_SIGNING_KEY_MISSING');
    expect(new Sep10Error(Sep10ErrorCode.CLIENT_DOMAIN_NOT_ALLOWED, 'x')).toBeInstanceOf(Error);
  });
});
