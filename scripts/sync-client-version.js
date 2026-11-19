#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_ROOT = path.join(__dirname, '..');

/**
 * Resolve the version to publish for the TypeScript client.
 *
 * Prefers the root package.json version and falls back to the OpenAPI
 * `info.version` when the root package has no version field.
 *
 * @param {string} root Repository root containing package.json and src/openapi.yaml.
 * @returns {string} The version to write into the client package.json.
 */
function resolveVersion(root) {
  const rootPackagePath = path.join(root, 'package.json');
  if (fs.existsSync(rootPackagePath)) {
    const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
    if (typeof rootPackage.version === 'string' && rootPackage.version.length > 0) {
      return rootPackage.version;
    }
  }

  const spec = yaml.load(fs.readFileSync(path.join(root, 'src/openapi.yaml'), 'utf8'));
  return spec.info.version;
}

/**
 * Copy the resolved version into the TypeScript client package.json,
 * preserving two-space indentation and a trailing newline. Leaves the file
 * untouched when the version already matches.
 *
 * @param {string} [root] Repository root; defaults to the repo containing this script.
 * @returns {{ version: string, changed: boolean }} Result of the sync.
 */
function syncClientVersion(root = DEFAULT_ROOT) {
  const packagePath = path.join(root, 'clients/typescript/package.json');
  const clientPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const version = resolveVersion(root);

  if (clientPackage.version === version) {
    return { version, changed: false };
  }

  clientPackage.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(clientPackage, null, 2)}\n`);
  return { version, changed: true };
}

module.exports = { resolveVersion, syncClientVersion };

if (require.main === module) {
  const { version, changed } = syncClientVersion();
  console.log(
    changed
      ? `[sync-client-version] Set TypeScript client version to ${version}`
      : `[sync-client-version] TypeScript client version already ${version}`
  );
}
