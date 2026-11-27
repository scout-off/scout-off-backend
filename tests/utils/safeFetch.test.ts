import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { RequestOptions } from 'http';
import {
  safeFetch,
  isBlockedIp,
  sniffContentType,
  SafeFetchError,
  Resolver,
  RequestFn,
} from '../../src/utils/safeFetch';

const PUBLIC_IP = '93.184.216.34';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function stubResolver(map: Record<string, string>): Resolver {
  return async (host) => {
    if (!map[host]) throw new Error('ENOTFOUND');
    return [{ address: map[host], family: map[host].includes(':') ? 6 : 4 }];
  };
}

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Readable | Buffer;
}

/** Fake https.request: routes by hostname, records requests, never touches the network. */
function fakeRequest(routes: Record<string, FakeResponse>, seen: RequestOptions[] = []): RequestFn {
  return ((options: RequestOptions, cb: (res: never) => void) => {
    seen.push(options);
    const req = new EventEmitter() as EventEmitter & {
      end(): void;
      destroy(): void;
      setTimeout(): void;
    };
    req.setTimeout = () => undefined;
    req.destroy = () => undefined;
    req.end = () => {
      const route = routes[`${options.hostname}${options.path}`];
      const body =
        route.body instanceof Readable ? route.body : Readable.from(route.body ? [route.body] : []);
      Object.assign(body, { statusCode: route.status, headers: route.headers ?? {} });
      setImmediate(() => cb(body as never));
    };
    return req as never;
  }) as RequestFn;
}

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each([PUBLIC_IP, '8.8.8.8', '2606:4700:4700::1111'])('allows %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe('safeFetch', () => {
  it('rejects hosts that resolve to the metadata IP with 422', async () => {
    const seen: RequestOptions[] = [];
    const p = safeFetch('https://evil.example.com/x.png', {
      maxBytes: 1000,
      resolver: stubResolver({ 'evil.example.com': '169.254.169.254' }),
      request: fakeRequest({}, seen),
    });
    await expect(p).rejects.toMatchObject({ status: 422, reason: 'blocked_ip' });
    expect(seen).toHaveLength(0);
  });

  it('rejects hosts that resolve to a private IP', async () => {
    await expect(
      safeFetch('https://intranet.example.com/', {
        maxBytes: 1000,
        resolver: stubResolver({ 'intranet.example.com': '10.0.0.5' }),
        request: fakeRequest({}),
      }),
    ).rejects.toMatchObject({ status: 422, reason: 'blocked_ip' });
  });

  it('pins the connection to the validated IP', async () => {
    const seen: RequestOptions[] = [];
    await safeFetch('https://cdn.example.com/a.png', {
      maxBytes: 1000,
      resolver: stubResolver({ 'cdn.example.com': PUBLIC_IP }),
      request: fakeRequest({ 'cdn.example.com/a.png': { status: 200, body: PNG } }, seen),
    });
    const lookup = seen[0].lookup as unknown as (
      h: string,
      o: object,
      cb: (e: null, a: string) => void,
    ) => void;
    const got = await new Promise<string>((r) => lookup('cdn.example.com', {}, (_e, a) => r(a)));
    expect(got).toBe(PUBLIC_IP);
  });

  it('rejects redirects to private addresses', async () => {
    await expect(
      safeFetch('https://cdn.example.com/a.png', {
        maxBytes: 1000,
        resolver: stubResolver({
          'cdn.example.com': PUBLIC_IP,
          'internal.example.com': '192.168.0.10',
        }),
        request: fakeRequest({
          'cdn.example.com/a.png': {
            status: 302,
            headers: { location: 'https://internal.example.com/secret' },
          },
        }),
      }),
    ).rejects.toMatchObject({ status: 422, reason: 'blocked_ip' });
  });

  it('rejects redirects to literal loopback and to http://', async () => {
    const resolver = stubResolver({ 'cdn.example.com': PUBLIC_IP });
    await expect(
      safeFetch('https://cdn.example.com/a', {
        maxBytes: 1000,
        resolver,
        request: fakeRequest({
          'cdn.example.com/a': { status: 301, headers: { location: 'https://127.0.0.1/' } },
        }),
      }),
    ).rejects.toMatchObject({ reason: 'blocked_ip' });
    await expect(
      safeFetch('https://cdn.example.com/a', {
        maxBytes: 1000,
        resolver,
        request: fakeRequest({
          'cdn.example.com/a': { status: 301, headers: { location: 'http://cdn.example.com/b' } },
        }),
      }),
    ).rejects.toMatchObject({ reason: 'redirect_invalid' });
  });

  it('follows a bounded number of safe redirects', async () => {
    const resolver = stubResolver({ 'cdn.example.com': PUBLIC_IP });
    const res = await safeFetch('https://cdn.example.com/a', {
      maxBytes: 1000,
      resolver,
      request: fakeRequest({
        'cdn.example.com/a': { status: 302, headers: { location: '/b' } },
        'cdn.example.com/b': { status: 200, body: PNG },
      }),
    });
    expect(res.finalUrl).toBe('https://cdn.example.com/b');
    await expect(
      safeFetch('https://cdn.example.com/a', {
        maxBytes: 1000,
        resolver,
        maxRedirects: 0,
        request: fakeRequest({ 'cdn.example.com/a': { status: 302, headers: { location: '/b' } } }),
      }),
    ).rejects.toMatchObject({ reason: 'too_many_redirects' });
  });

  it('aborts an oversized stream early instead of buffering it all', async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const err = await safeFetch('https://cdn.example.com/big', {
      maxBytes: 1024 * 1024,
      resolver: stubResolver({ 'cdn.example.com': PUBLIC_IP }),
      request: fakeRequest({ 'cdn.example.com/big': { status: 200, body: endless } }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err).toMatchObject({ status: 413, reason: 'too_large' });
    expect(produced).toBeLessThan(4 * 1024 * 1024);
    expect(endless.destroyed).toBe(true);
  });
});

describe('sniffContentType', () => {
  it('detects real formats', () => {
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffContentType(Buffer.from('plain notes'))).toBe('text/plain');
  });

  it('does not accept HTML as text or image', () => {
    expect(sniffContentType(Buffer.from('<!DOCTYPE html><html></html>'))).toBeNull();
    expect(sniffContentType(Buffer.from([0, 1, 2, 3]))).toBeNull();
  });
});
