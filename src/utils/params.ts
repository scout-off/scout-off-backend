import { Request } from 'express';

/**
 * Safely extract a route parameter as a string.
 * In Express 5, req.params values can be string | string[] for wildcard routes.
 * This codebase doesn't use wildcards, so all params should be strings.
 */
export function getParam(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Safely extract multiple route parameters as strings.
 */
export function getParams<T extends Record<string, string>>(
  req: Request,
  keys: (keyof T)[]
): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    const value = req.params[key as string];
    if (value !== undefined) {
      const strValue = Array.isArray(value) ? value[0] : value;
      result[key] = strValue as T[keyof T];
    }
  }
  return result;
}
