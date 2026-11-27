#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const specPath = path.join(ROOT, 'src/openapi.yaml');
const schemaPath = path.join(ROOT, 'clients/typescript/src/schema.ts');
const clientPackagePath = path.join(ROOT, 'clients/typescript/package.json');

function main() {
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  const clientPackage = JSON.parse(fs.readFileSync(clientPackagePath, 'utf8'));
  if (clientPackage.version !== spec.info.version) {
    throw new Error(
      `Client version ${clientPackage.version} does not match OpenAPI version ${spec.info.version}. ` +
        'Run: npm run build:client',
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutoff-client-'));
  try {
    const generatedPath = path.join(tempDir, 'schema.d.ts');
    const cliPath = path.join(ROOT, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
    execFileSync(process.execPath, [cliPath, specPath, '--output', generatedPath], {
      stdio: 'ignore',
    });

    if (fs.readFileSync(schemaPath, 'utf8') !== fs.readFileSync(generatedPath, 'utf8')) {
      throw new Error(
        'Generated TypeScript client schema is out of date. Run: npm run build:client',
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`[validate-client] OK — generated client matches OpenAPI ${spec.info.version}`);
}

try {
  main();
} catch (err) {
  console.error(`[validate-client] ${err.message}`);
  process.exit(1);
}
