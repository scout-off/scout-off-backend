/**
 * apiVersion middleware
 *
 * Sets `X-API-Version: <major>` on every response.
 * The value is the major part of the version field in package.json
 * (e.g. "1.0.0" → "1").
 *
 * Applied globally in app.ts before route handlers so every response —
 * including health-check and metrics endpoints — carries the header.
 */

import { Request, Response, NextFunction } from 'express';
import { getVersionInfo } from '../version';

/** Parse the major segment from a semver string (e.g. "1.2.3" → "1"). */
function majorVersion(semver: string): string {
  return semver.split('.')[0] ?? '1';
}

const API_VERSION = majorVersion(getVersionInfo().version);

export function apiVersion(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('X-API-Version', API_VERSION);
  next();
}
