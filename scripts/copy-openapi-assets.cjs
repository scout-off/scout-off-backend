#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
for (const name of ['openapi.json', 'openapi.yaml', 'openapi.components.yaml']) {
  const source = path.join(root, 'src', name);
  if (!fs.existsSync(source)) throw new Error(`Required OpenAPI asset missing: ${source}`);
  fs.copyFileSync(source, path.join(output, name));
}
console.log('[build] Copied OpenAPI assets to dist/');
