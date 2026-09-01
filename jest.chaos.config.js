/** Jest config for the dependency-failure chaos harness (#1116).
 *  Kept separate from the unit/scripts projects so CI can run it as its own job.
 */
module.exports = {
  displayName: 'chaos',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/tests/chaos/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: '<rootDir>/tsconfig.eslint.json',
      },
    ],
    '^.+\\.js$': 'ts-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@stellar/stellar-sdk|uint8array-extras|@exodus/bytes|@noble/ed25519|@noble/hashes)/)',
  ],
  moduleNameMapper: {
    '^@paralleldrive/cuid2$': '<rootDir>/__mocks__/@paralleldrive/cuid2.js',
    '^multiformats/cid$': '<rootDir>/__mocks__/multiformats/cid.js',
  },
  testTimeout: 30_000,
};
