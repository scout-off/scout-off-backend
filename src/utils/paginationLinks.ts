import { Request } from 'express';

export interface PaginationLinks {
  next: string | null;
  prev: string | null;
}

export interface PaginationLinkOptions {
  /** Current page (1-based). */
  page: number;
  /** Page size. */
  pageSize: number;
  /** Total number of records matching the query. */
  total: number;
}

/**
 * Builds hypermedia `links.next` and `links.prev` URLs for paginated responses.
 *
 * The base URL is derived from the incoming Express request so the returned
 * links automatically reflect the correct host, prefix, and any active filter
 * query parameters (region, position, minTier, eventType, etc.).
 * Only `page` and `pageSize` are overwritten; all other query parameters are
 * preserved verbatim.
 */
export function buildPaginationLinks(
  req: Request,
  { page, pageSize, total }: PaginationLinkOptions,
): PaginationLinks {
  const totalPages = Math.ceil(total / pageSize);

  const buildUrl = (targetPage: number): string => {
    // Clone current query params so we don't mutate the request object.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'page' || key === 'pageSize') continue; // we set these ourselves
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }
    params.set('page', String(targetPage));
    params.set('pageSize', String(pageSize));

    // Reconstruct the base path from the request.
    // req.originalUrl may include a query string; strip it.
    const basePath = req.originalUrl.split('?')[0];
    return `${basePath}?${params.toString()}`;
  };

  return {
    next: page < totalPages ? buildUrl(page + 1) : null,
    prev: page > 1 ? buildUrl(page - 1) : null,
  };
}

/**
 * Variant that accepts offset/limit-style pagination and converts to page/pageSize
 * before delegating to `buildPaginationLinks`.
 */
export function buildOffsetPaginationLinks(
  req: Request,
  opts: { limit: number; offset: number; total: number },
): PaginationLinks {
  const { limit, offset, total } = opts;
  // Derive a 1-based page number from offset/limit.
  const page = Math.floor(offset / limit) + 1;
  return buildPaginationLinks(req, { page, pageSize: limit, total });
}
