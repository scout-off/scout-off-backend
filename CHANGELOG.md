# Changelog

All notable changes to the ScoutOff backend are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `CHANGELOG.md` in Keep a Changelog format, replacing the one-off `CHANGES.md`
  implementation notes.

### Changed

- Pull requests now record whether the changelog was updated (see
  `.github/PULL_REQUEST_TEMPLATE.md`).

### Deprecated

- `CHANGES.md` — historical implementation notes only; new user-facing changes
  belong in this file.

### Removed

### Fixed

### Security

## [1.0.0] - 2026-07-27

Baseline release of the ScoutOff backend as documented in
[`docs/history/`](docs/history/) and [`CHANGES.md`](CHANGES.md).

### Added

- Player, scout, subscription, progress and trial-offer APIs with SEP-10 auth.
- Soroban contracts: `register`, `player_token`, `progress`, `subscription`,
  `connection` and `shared`.
- OpenAPI linting with Spectral, request timeouts with `AbortController`
  propagation, a unified cache store, and API docs visibility control.
- GraphQL endpoint, webhooks with dead-letter handling, background jobs,
  rate limiting, audit log, metrics and readiness checks.

[Unreleased]: https://github.com/scout-off/scout-off-backend/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/scout-off/scout-off-backend/releases/tag/v1.0.0
