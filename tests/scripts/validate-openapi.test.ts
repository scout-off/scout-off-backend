/**
 * Regression tests for scripts/validate-openapi.js (issue #1036).
 *
 * The validator's YAML↔JSON sync check previously passed the top-level key
 * list to JSON.stringify as a replacer ARRAY. JSON.stringify treats an array
 * replacer as an allow-list applied at EVERY nesting level, so any property
 * whose name was not a top-level key (openapi, info, paths, ...) was stripped
 * at every depth — a spec differing only in a deeply-nested field (e.g.
 * paths./a.get.summary) normalised to an empty `paths: {}` on both sides and
 * the check passed even though the specs had genuinely diverged.
 *
 * These tests pin the fixed behaviour: canonicalisation sorts object keys at
 * every level, specsAreEqual flags deep-only drift, and the script itself
 * (spawned against fixtures) fails when the two specs differ only in a
 * nested field.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

// The script is plain CommonJS; require it directly so the exported pure
// functions can be unit-tested without spawning a process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { canonicalise, specsAreEqual } = require('../../scripts/validate-openapi');

const REPO_ROOT = path.resolve(__dirname, '../..');
const VALIDATOR = path.join(REPO_ROOT, 'scripts/validate-openapi.js');

const MINIMAL_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Fixture spec', version: '1.0.0' },
  paths: {
    '/a': { get: { summary: 'Original summary' } },
    '/b': { get: { summary: 'Another endpoint' } },
  },
};

const runValidator = (env = {}) =>
  spawnSync('node', [VALIDATOR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('validate-openapi canonicalise', () => {
  it('sorts object keys at every nesting level', () => {
    const input = { z: 1, a: { y: 2, x: { w: 3, v: 4 } } };
    expect(JSON.stringify(canonicalise(input))).toBe(
      JSON.stringify({ a: { x: { v: 4, w: 3 }, y: 2 }, z: 1 }),
    );
  });

  it('is insensitive to key insertion order at any depth', () => {
    const a = {
      openapi: '3.0.0',
      paths: { '/x': { get: { summary: 's', operationId: 'o' } } },
      info: { title: 't' },
    };
    const b = {
      info: { title: 't' },
      paths: { '/x': { get: { operationId: 'o', summary: 's' } } },
      openapi: '3.0.0',
    };
    expect(JSON.stringify(canonicalise(a))).toBe(JSON.stringify(canonicalise(b)));
    expect(specsAreEqual(a, b)).toBe(true);
  });

  it('does not sort arrays (order is significant in OpenAPI)', () => {
    const a = { required: ['a', 'b'] };
    const b = { required: ['b', 'a'] };
    expect(specsAreEqual(a, b)).toBe(false);
  });
});

describe('validate-openapi specsAreEqual (issue #1036 regression)', () => {
  it('flags specs differing only in a deeply-nested field as different', () => {
    const before = JSON.parse(JSON.stringify(MINIMAL_SPEC));
    const after = JSON.parse(JSON.stringify(MINIMAL_SPEC));
    // Only nested drift: paths./a.get.summary — exactly the false-negative
    // case from the issue, which the old replacer-array normalise collapsed.
    after.paths['/a'].get.summary = 'Changed deep summary';
    expect(specsAreEqual(before, after)).toBe(false);
  });

  it('flags a deeply-nested property missing from one spec as different', () => {
    const withField = JSON.parse(JSON.stringify(MINIMAL_SPEC));
    withField.paths['/a'].get.tags = ['players'];
    const missingField = JSON.parse(JSON.stringify(withField));
    delete missingField.paths['/a'].get.tags;
    expect(specsAreEqual(withField, missingField)).toBe(false);
  });

  it('flags deep drift in nested requestBody schemas (mirrors real drift found in repo)', () => {
    const withDescription = {
      paths: {
        '/auth/token': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    properties: {
                      transaction: { description: 'Signed transaction XDR' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const withoutDescription = JSON.parse(JSON.stringify(withDescription));
    delete withoutDescription.paths['/auth/token'].post.requestBody.content[
      'application/json'
    ].schema.properties.transaction.description;
    expect(specsAreEqual(withDescription, withoutDescription)).toBe(false);
  });

  it('returns true for structurally identical specs', () => {
    expect(specsAreEqual(MINIMAL_SPEC, JSON.parse(JSON.stringify(MINIMAL_SPEC)))).toBe(true);
  });
});

describe('validate-openapi script (integration)', () => {
  it('passes against the real in-repo specs', () => {
    const result = runValidator();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('spec valid');
  });

  it('fails when the JSON differs from the YAML only in a deeply-nested field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-openapi-'));
    try {
      const jsonSpec = JSON.parse(JSON.stringify(MINIMAL_SPEC));
      // Inject a nested-only discrepancy — top-level key sets stay identical.
      jsonSpec.paths['/a'].get.summary = 'Drifted deep summary';
      const yamlPath = path.join(tmpDir, 'openapi.yaml');
      const jsonPath = path.join(tmpDir, 'openapi.json');
      fs.writeFileSync(yamlPath, yaml.dump(MINIMAL_SPEC));
      fs.writeFileSync(jsonPath, `${JSON.stringify(jsonSpec, null, 2)}\n`);

      const result = runValidator({
        OPENAPI_YAML_PATH: yamlPath,
        OPENAPI_JSON_PATH: jsonPath,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('out of sync');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes when the fixture JSON matches the fixture YAML', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-openapi-'));
    try {
      const yamlPath = path.join(tmpDir, 'openapi.yaml');
      const jsonPath = path.join(tmpDir, 'openapi.json');
      fs.writeFileSync(yamlPath, yaml.dump(MINIMAL_SPEC));
      fs.writeFileSync(jsonPath, `${JSON.stringify(MINIMAL_SPEC, null, 2)}\n`);

      const result = runValidator({
        OPENAPI_YAML_PATH: yamlPath,
        OPENAPI_JSON_PATH: jsonPath,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('spec valid');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
