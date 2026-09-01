import { z } from 'zod';

/**
 * Strict empty-body schema for mutating routes that take no JSON fields.
 * `.default({})` lets body-less requests (undefined `req.body`) succeed the
 * same way as an explicit `{}` payload.
 */
export const emptyBodySchema = z.object({}).strict().default({});
