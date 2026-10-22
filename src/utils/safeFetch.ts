/**
 * SSRF-safe HTTPS fetcher (issue #1331).
 *
 * - Resolves the hostname up front and rejects private, loopback, link-local,
 *   CGNAT, multicast, reserved, IPv6 ULA and IPv4-mapped private addresses.
 * - Pins the validated IP for the connection via a custom `lookup`, so a
 *   second DNS answer (rebinding) cannot redirect the socket.
 * - Never follows redirects automatically; each hop is re-validated, up to
 *   `maxRedirects`, and must stay on https://.
 * - Streams the body with a hard byte limit and aborts as soon as it is hit.
 * - Sniffs magic bytes so the declared Content-Type cannot be trusted blindly.
 *
 * Intended to be shared by any outbound fetch of caller-supplied URLs
 * (evidence downloads today; webhooks #692 can adopt it).
 */
import https from 'https';
import net from 'net';
import dns from 'dns';
import { injectTraceHeaders } from './traceContext';
import type { IncomingMessage, ClientRequest } from 'http';
import type { RequestOptions } from 'https';

export type SafeFetchRejectReason =
  | 'invalid_url'
  | 'dns_failure'
  | 'blocked_ip'
  | 'redirect_invalid'
  | 'too_many_redirects'
  | 'too_large'
  | 'bad_status'
  | 'timeout'
  | 'unsupported_content'
  | 'network_error';

export class SafeFetchError extends Error {
  constructor(message: string, public readonly status: number, public readonly reason: SafeFetchRejectReason) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface ResolvedAddress { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type RequestFn = (options: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Injectable for tests; defaults to dns.promises.lookup(all). */
  resolver?: Resolver;
  /** Injectable for tests; defaults to https.request. */
  request?: RequestFn;
}

export interface SafeFetchResult {
  buffer: Buffer;
  declaredContentType: string;
  finalUrl: string;
}

const blockList = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockList.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blockList.addSubnet(net6, prefix, 'ipv6');

/** True if `ip` must never be contacted by an outbound fetch. */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6) {
    // IPv4-mapped / -compatible IPv6 (::ffff:a.b.c.d, ::ffff:7f00:1) → check the embedded IPv4.
    const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isBlockedIp(mapped[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return blockList.check(ip, 'ipv6');
  }
  return blockList.check(ip, 'ipv4');
}

const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

async function resolveSafe(hostname: string, resolver: Resolver): Promise<ResolvedAddress> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  if (net.isIP(bare)) {
    addresses = [{ address: bare, family: net.isIP(bare) }];
  } else {
    try {
      addresses = await resolver(bare);
    } catch {
      throw new SafeFetchError(`Could not resolve host ${bare}`, 422, 'dns_failure');
    }
  }
  if (addresses.length === 0) throw new SafeFetchError(`Could not resolve host ${bare}`, 422, 'dns_failure');
  // Reject if ANY answer is internal — an attacker controls which one a client would pick.
  const blocked = addresses.find((a) => isBlockedIp(a.address));
  if (blocked) {
    throw new SafeFetchError(`Evidence URL host ${bare} resolves to a disallowed address (${blocked.address})`, 422, 'blocked_ip');
  }
  return addresses[0];
}

function parseHttpsUrl(raw: string, reason: SafeFetchRejectReason): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError(`Invalid URL: ${raw}`, 422, reason);
  }
  if (url.protocol !== 'https:') throw new SafeFetchError(`Only https:// URLs are allowed: ${raw}`, 422, reason);
  if (url.username || url.password) throw new SafeFetchError('URLs with credentials are not allowed', 422, reason);
  return url;
}

function fetchOnce(url: URL, pinned: ResolvedAddress, opts: Required<Omit<SafeFetchOptions, 'resolver'>>): Promise<
  { redirect: string } | { buffer: Buffer; contentType: string }
> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: SafeFetchError) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    const req = opts.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        headers: injectTraceHeaders({ 'user-agent': 'scout-off-evidence-fetcher', accept: '*/*' }),
        // Pin the connection to the address we validated (defeats DNS rebinding).
        lookup: ((_host: string, lookupOpts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (lookupOpts?.all) cb(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        }) as unknown as RequestOptions['lookup'],
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.resume();
          if (!location) return fail(new SafeFetchError(`Redirect without Location header`, 422, 'redirect_invalid'));
          let next: string;
          try {
            next = new URL(location, url).toString();
          } catch {
            return fail(new SafeFetchError(`Invalid redirect location: ${location}`, 422, 'redirect_invalid'));
          }
          settled = true;
          return resolve({ redirect: next });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return fail(new SafeFetchError(`Evidence URL returned HTTP ${status}`, 422, 'bad_status'));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          return fail(new SafeFetchError(`Evidence file too large: ${declared} bytes exceeds the ${opts.maxBytes}-byte limit`, 413, 'too_large'));
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > opts.maxBytes) {
            res.destroy();
            return fail(new SafeFetchError(`Evidence file too large: exceeds the ${opts.maxBytes}-byte limit`, 413, 'too_large'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers['content-type'] ?? '') });
        });
        res.on('error', () => fail(new SafeFetchError('Evidence download failed', 502, 'network_error')));
      },
    );
    req.setTimeout(opts.timeoutMs, () => fail(new SafeFetchError(`Evidence download timed out after ${opts.timeoutMs}ms`, 504, 'timeout')));
    req.on('error', () => fail(new SafeFetchError('Evidence download failed', 502, 'network_error')));
    req.end();
  });
}

/** Fetch a caller-supplied https:// URL with SSRF protections and a hard size cap. */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const opts = {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs ?? 30000,
    maxRedirects: options.maxRedirects ?? 3,
    request: options.request ?? (https.request as unknown as RequestFn),
  };
  const resolver = options.resolver ?? defaultResolver;

  let url = parseHttpsUrl(rawUrl, 'invalid_url');
  for (let hop = 0; ; hop++) {
    const pinned = await resolveSafe(url.hostname, resolver);
    const result = await fetchOnce(url, pinned, opts);
    if ('buffer' in result) {
      return { buffer: result.buffer, declaredContentType: result.contentType, finalUrl: url.toString() };
    }
    if (hop >= opts.maxRedirects) throw new SafeFetchError(`Too many redirects (max ${opts.maxRedirects})`, 422, 'too_many_redirects');
    url = parseHttpsUrl(result.redirect, 'redirect_invalid');
  }
}

// ─── Content sniffing ─────────────────────────────────────────────────────────

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  return buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
}

/**
 * Detect the real MIME type from magic bytes. Returns null when the content
 * is not one of the recognised evidence formats.
 */
export function sniffContentType(buf: Buffer): string | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') {
    const kind = buf.subarray(8, 12).toString('latin1');
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (/^(heic|heix|mif1|avif)$/.test(brand)) return brand === 'avif' ? 'image/avif' : 'image/heic';
    return 'video/mp4';
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return 'video/ogg';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0xba]) || startsWith(buf, [0x00, 0x00, 0x01, 0xb3])) return 'video/mpeg';
  if (isPlainText(buf)) return 'text/plain';
  return null;
}

function isPlainText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf.includes(0)) return false;
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  // Markup served as text (or as an image) is a classic content-confusion vector.
  if (/^<(!doctype|html|head|body|script|svg|\?xml)/.test(head)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}
