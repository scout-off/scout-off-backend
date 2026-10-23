import fs from 'fs';
import path from 'path';
import config from './config';

interface PackageJson {
  version: string;
}

const pkg: PackageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

// Deploy tarballs exclude .git (see deploy-staging.yml), so the commit can't
// be read via git at runtime. CI writes it to BUILD_COMMIT at package time;
// GIT_COMMIT lets it be overridden for other deploy methods.
function resolveCommit(): string {
  if (process.env.GIT_COMMIT) {
    return process.env.GIT_COMMIT;
  }
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'BUILD_COMMIT'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

const commit = resolveCommit();
const STARTED_AT = new Date();

export interface VersionInfo {
  version: string;
  commit: string;
  node: string;
  environment: string;
  startedAt: string;
  uptimeSeconds: number;
}

export function getVersionInfo(): VersionInfo {
  return {
    version: pkg.version,
    commit,
    node: process.version,
    environment: config.nodeEnv,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

// Descriptive User-Agent for outbound webhook deliveries, e.g.
// "ScoutOff-Webhooks/1.2.3". Receivers can use this to identify the sender
// in access logs without parsing the payload.
export function getWebhookUserAgent(): string {
  return `ScoutOff-Webhooks/${pkg.version}`;
}
