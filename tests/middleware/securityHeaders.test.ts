import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config';

/**
 * Pin every security-relevant response header to a concrete expected value.
 * Overlapping headers are owned by securityHeaders; helmet-only headers keep
 * helmet 8 defaults. HSTS must be absent outside production/staging.
 */
describe('securityHeaders middleware', () => {
  describe('exact security header values on a sample response', () => {
    let res: request.Response;

    beforeAll(async () => {
      res = await request(app).get('/health');
    });

    it('sets Content-Security-Policy from config (securityHeaders only)', () => {
      expect(res.headers['content-security-policy']).toBe(config.securityHeaders.csp);
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    });

    it('sets X-Content-Type-Options: nosniff (securityHeaders only)', () => {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-content-type-options']).toBe(config.securityHeaders.xContentTypeOptions);
    });

    it('sets X-Frame-Options: DENY (securityHeaders only)', () => {
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-frame-options']).toBe(config.securityHeaders.xFrameOptions);
    });

    it('sets Referrer-Policy: no-referrer (securityHeaders only)', () => {
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['referrer-policy']).toBe(config.securityHeaders.referrerPolicy);
    });

    it('sets Permissions-Policy from config (securityHeaders only)', () => {
      expect(res.headers['permissions-policy']).toBe(config.securityHeaders.permissionsPolicy);
      expect(res.headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
    });

    it('does not expose X-Powered-By', () => {
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('omits Strict-Transport-Security in test/development (HSTS disabled outside prod/staging)', () => {
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    // Helmet-owned headers (modules left enabled in app.ts) — pin defaults so
    // an upgrade that changes them fails this suite intentionally.
    it('sets Cross-Origin-Opener-Policy: same-origin (helmet)', () => {
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    });

    it('sets Cross-Origin-Resource-Policy: same-origin (helmet)', () => {
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    it('sets Origin-Agent-Cluster: ?1 (helmet)', () => {
      expect(res.headers['origin-agent-cluster']).toBe('?1');
    });

    it('sets X-DNS-Prefetch-Control: off (helmet)', () => {
      expect(res.headers['x-dns-prefetch-control']).toBe('off');
    });

    it('sets X-Download-Options: noopen (helmet)', () => {
      expect(res.headers['x-download-options']).toBe('noopen');
    });

    it('sets X-Permitted-Cross-Domain-Policies: none (helmet)', () => {
      expect(res.headers['x-permitted-cross-domain-policies']).toBe('none');
    });

    it('sets X-XSS-Protection: 0 (helmet)', () => {
      expect(res.headers['x-xss-protection']).toBe('0');
    });
  });

  describe('HSTS config value', () => {
    it('would set Strict-Transport-Security in production mode', () => {
      expect(config.securityHeaders.hsts).toMatch(/max-age=31536000/);
      expect(config.securityHeaders.hsts).toMatch(/includeSubDomains/);
    });
  });

  describe('CSP defaults', () => {
    it('includes default-src none', () => {
      expect(config.securityHeaders.csp).toContain("default-src 'none'");
    });

    it('includes frame-ancestors none', () => {
      expect(config.securityHeaders.csp).toContain("frame-ancestors 'none'");
    });
  });

  describe('Permissions-Policy defaults', () => {
    it('disables camera, microphone, and geolocation', () => {
      const pp = config.securityHeaders.permissionsPolicy;
      expect(pp).toContain('camera=()');
      expect(pp).toContain('microphone=()');
      expect(pp).toContain('geolocation=()');
    });
  });
});
