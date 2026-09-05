import { z } from 'zod';

/**
 * Strict empty-body schema for mutating routes that take no JSON fields.
 * `.default({})` lets body-less requests (undefined `req.body`) succeed the
 * same way as an explicit `{}` payload.
 */
export const emptyBodySchema = z.object({}).strict().default({});

/**
 * Lenient empty-body schema: unknown fields are silently stripped rather than
 * rejected. For endpoints that deliberately ignore any request body (e.g.
 * POST /api/admin/introspect, which decodes only the caller's own bearer
 * token — #279) so that a stray `token` field can't turn into a 400.
 */
export const ignoredBodySchema = z.object({}).strip().default({});
