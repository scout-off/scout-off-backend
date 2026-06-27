import { Request } from 'express';
import { buildPaginationLinks, buildOffsetPaginationLinks } from '../../src/utils/paginationLinks';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(path: string, query: Record<string, string> = {}): Request {
  return {
    originalUrl: path + (Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : ''),
    query,
  } as unknown as Request;
}

// ── buildPaginationLinks ──────────────────────────────────────────────────────

describe('buildPaginationLinks', () => {
  it('returns null for both links on a single-page result set', () => {
    const req = makeReq('/api/players', { page: '1', pageSize: '20' });
    const links = buildPaginationLinks(req, { page: 1, pageSize: 20, total: 10 });
    expect(links.next).toBeNull();
    expect(links.prev).toBeNull();
  });

  it('returns only next on the first page when more pages exist', () => {
    const req = makeReq('/api/players', { page: '1', pageSize: '10' });
    const links = buildPaginationLinks(req, { page: 1, pageSize: 10, total: 25 });
    expect(links.prev).toBeNull();
    expect(links.next).not.toBeNull();
    expect(links.next).toContain('page=2');
    expect(links.next).toContain('pageSize=10');
  });

  it('returns only prev on the last page', () => {
    const req = makeReq('/api/players', { page: '3', pageSize: '10' });
    const links = buildPaginationLinks(req, { page: 3, pageSize: 10, total: 25 });
    expect(links.next).toBeNull();
    expect(links.prev).not.toBeNull();
    expect(links.prev).toContain('page=2');
    expect(links.prev).toContain('pageSize=10');
  });

  it('returns both next and prev on a middle page', () => {
    const req = makeReq('/api/players', { page: '2', pageSize: '10' });
    const links = buildPaginationLinks(req, { page: 2, pageSize: 10, total: 30 });
    expect(links.prev).not.toBeNull();
    expect(links.next).not.toBeNull();
    expect(links.prev).toContain('page=1');
    expect(links.next).toContain('page=3');
  });

  it('preserves active filter query parameters in link URLs', () => {
    const req = makeReq('/api/players', { region: 'europe', position: 'striker', page: '1', pageSize: '5' });
    const links = buildPaginationLinks(req, { page: 1, pageSize: 5, total: 15 });
    expect(links.next).toContain('region=europe');
    expect(links.next).toContain('position=striker');
    expect(links.next).toContain('page=2');
    expect(links.next).toContain('pageSize=5');
  });

  it('does not duplicate page/pageSize params from the original URL', () => {
    const req = makeReq('/api/players', { page: '2', pageSize: '10' });
    const links = buildPaginationLinks(req, { page: 2, pageSize: 10, total: 30 });
    // page should appear exactly once in the query string
    const nextUrl = links.next!;
    const nextParams = new URLSearchParams(nextUrl.split('?')[1]);
    expect(nextParams.getAll('page')).toHaveLength(1);
    expect(nextParams.getAll('pageSize')).toHaveLength(1);
  });

  it('returns correct URLs when total is exactly one full page', () => {
    // 20 results, pageSize=20 → only 1 page
    const req = makeReq('/api/players', { page: '1', pageSize: '20' });
    const links = buildPaginationLinks(req, { page: 1, pageSize: 20, total: 20 });
    expect(links.next).toBeNull();
    expect(links.prev).toBeNull();
  });

  it('returns correct URLs when total is exactly one item beyond a full page', () => {
    // 21 results, pageSize=20 → 2 pages
    const req = makeReq('/api/players', { page: '1', pageSize: '20' });
    const links = buildPaginationLinks(req, { page: 1, pageSize: 20, total: 21 });
    expect(links.next).not.toBeNull();
    expect(links.next).toContain('page=2');
    expect(links.prev).toBeNull();
  });

  it('includes the base path in the link URLs', () => {
    const req = makeReq('/api/v1/players', { page: '1', pageSize: '10' });
    const links = buildPaginationLinks(req, { page: 1, pageSize: 10, total: 30 });
    expect(links.next).toContain('/api/v1/players');
  });
});

// ── buildOffsetPaginationLinks ────────────────────────────────────────────────

describe('buildOffsetPaginationLinks', () => {
  it('returns null for both on a single-page result set', () => {
    const req = makeReq('/api/admin/events', { limit: '20', offset: '0' });
    const links = buildOffsetPaginationLinks(req, { limit: 20, offset: 0, total: 10 });
    expect(links.next).toBeNull();
    expect(links.prev).toBeNull();
  });

  it('returns only next on the first page', () => {
    const req = makeReq('/api/admin/events', { limit: '10', offset: '0' });
    const links = buildOffsetPaginationLinks(req, { limit: 10, offset: 0, total: 25 });
    expect(links.prev).toBeNull();
    expect(links.next).not.toBeNull();
    expect(links.next).toContain('page=2');
    expect(links.next).toContain('pageSize=10');
  });

  it('returns only prev on the last page', () => {
    // 3 pages of 10, currently on page 3 (offset=20)
    const req = makeReq('/api/admin/events', { limit: '10', offset: '20' });
    const links = buildOffsetPaginationLinks(req, { limit: 10, offset: 20, total: 25 });
    expect(links.next).toBeNull();
    expect(links.prev).not.toBeNull();
    expect(links.prev).toContain('page=2');
  });

  it('returns both on a middle page', () => {
    // page 2 (offset=10, limit=10, total=30)
    const req = makeReq('/api/admin/events', { limit: '10', offset: '10' });
    const links = buildOffsetPaginationLinks(req, { limit: 10, offset: 10, total: 30 });
    expect(links.prev).not.toBeNull();
    expect(links.next).not.toBeNull();
    expect(links.prev).toContain('page=1');
    expect(links.next).toContain('page=3');
  });

  it('preserves eventType and other filter params', () => {
    const req = makeReq('/api/admin/events', { eventType: 'milestone_approved', limit: '5', offset: '0' });
    const links = buildOffsetPaginationLinks(req, { limit: 5, offset: 0, total: 15 });
    expect(links.next).toContain('eventType=milestone_approved');
  });
});
