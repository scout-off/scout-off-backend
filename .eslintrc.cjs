module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    jest: true,
    es2021: true
  },
  rules: {
    '@typescript-eslint/no-unused-vars': 'off',
    'no-console': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    'no-empty': 'off',
    // Type-aware promise rules for src/**
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
    // Catch imports of packages not declared in dependencies/devDependencies.
    // This prevents a repeat of issue #1417 where @envelop/core was used via
    // a transitive dependency without being declared directly.
    'import/no-extraneous-dependencies': ['error', { devDependencies: ['tests/**/*.ts', 'scripts/**/*.ts', '**/*.test.ts', '**/*.spec.ts'] }],
    'import/no-duplicates': 'error'
  },
  overrides: [
    {
      // Catch dead imports and variables in application code. Prefix
      // intentionally unused parameters (e.g. Express `next`) with `_`.
      files: ['src/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
      }
    },
    {
      // logger.ts also uses console.debug/console.info, which the base
      // allowlist (warn/error only) doesn't cover.
      files: ['src/utils/logger.ts'],
      rules: { 'no-console': 'off' }
    }
    ,
    {
      // Tests sometimes import helpers or types that are intentionally unused
      // during setup; treat unused vars as warnings in tests to avoid CI failures
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
      }
    }
    ,
    {
      // scripts/*.ts are standalone CLI tools meant to print directly to the
      // terminal for a human operator (banners, progress, summaries). The
      // shared logger prepends level tags and is gated by config.logLevel,
      // which would mangle formatted output and can suppress it entirely —
      // neither is appropriate for a script whose job is to report its own
      // progress. console is intentional here, not an oversight.
      files: ['scripts/*.ts'],
      rules: { 'no-console': 'off' }
    }
  ]
};
