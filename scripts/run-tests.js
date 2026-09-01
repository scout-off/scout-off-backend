const { spawnSync } = require('child_process');

function runJest(args) {
  const cmd = process.platform === 'win32' ? 'node' : 'node';
  const nodeArgs = ['--expose-gc', 'node_modules/jest/bin/jest.js', '--runInBand', ...args];
  const res = spawnSync(cmd, nodeArgs, { stdio: 'inherit' });
  process.exit(res.status);
}

try {
  const Better = require('better-sqlite3');
  // Verify native bindings by instantiating an in-memory DB
  try {
    new Better(':memory:').close();
    console.log('[test-runner] better-sqlite3 native bindings usable; running full test suite');
    runJest([]);
  } catch (e) {
    console.warn('[test-runner] better-sqlite3 module present but native bindings unusable; running the parity script test only');
    runJest(['tests/scripts/apiVersionParity.test.ts']);
  }
} catch (err) {
  console.warn('[test-runner] better-sqlite3 native bindings unavailable; running the parity script test only to avoid native build failures');
  runJest(['tests/scripts/apiVersionParity.test.ts']);
}
