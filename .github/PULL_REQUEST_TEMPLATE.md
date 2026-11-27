## Summary

One paragraph describing what this PR does and why it is needed.

## Issue

Closes #

## Type of Change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Documentation
- [ ] Infra

## Testing Checklist

- [ ] I have added unit tests for new logic.
- [ ] I have added integration tests for new API endpoints.
- [ ] All existing tests pass (`npm test`).

## Documentation Checklist

- [ ] README updated if user-facing behaviour changed.
- [ ] CHANGELOG updated (if user-facing) — add an entry under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).
- [ ] New or changed endpoints documented in a JSDoc comment above the route (see [docs/API_DOCUMENTATION.md](../docs/API_DOCUMENTATION.md)) — `npm run docs:check` and `npm run validate:openapi` verify this and run in CI.
- [ ] `.env.example` updated for new environment variables.

## Migration Checklist (if applicable)

- [ ] Migration files added for SQLite and PostgreSQL (Postgres twin included).

## Security Checklist

- [ ] Input validation added for new fields.
- [ ] `npm audit` run and no new high/critical issues.

## Release Checklist

- [ ] `CHANGES.md` updated for user-visible changes.
- [ ] New or changed feature flags documented in [docs/feature-flags.md](../docs/feature-flags.md).

<details>
<summary>Client &amp; Contract Checklist (if applicable)</summary>

- [ ] TypeScript client regenerated (`npm run generate:client`) and `npm run validate:client` passes.
- [ ] OpenAPI JSON regenerated (`npm run build:openapi`) if routes or schemas changed.
- [ ] Soroban contracts build and their tests pass (`npm run test:contracts`).
- [ ] Contract WASM size budgets respected (`node scripts/check-contract-wasm-size.js`).

</details>
