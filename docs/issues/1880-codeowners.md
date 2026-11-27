# #1880 — CODEOWNERS: confirm maintainer handles

`.github/CODEOWNERS` now exists and maps the critical paths:

| Path                                                                                                                    | Owner group                 |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `*` (default)                                                                                                           | `@scout-off/maintainers`    |
| `contracts/`                                                                                                            | `@scout-off/contracts`      |
| `src/services/`, `src/utils/`, `src/middleware/`, `src/auth/`, auth/crypto controllers, `src/config*`, `src/tracing.ts` | `@scout-off/security`       |
| `src/db/`, migration scripts                                                                                            | `@scout-off/database`       |
| `.github/`, `.husky/`, `Dockerfile`, `docker-compose.yml`, `helm/`, deploy/backup scripts                               | `@scout-off/infrastructure` |

## Remaining work (maintainers)

1. Confirm or replace the placeholder handles (`@scout-off/maintainers`,
   `@scout-off/contracts`, `@scout-off/security`, `@scout-off/database`,
   `@scout-off/infrastructure`) with the real teams/users. Teams must have
   write access to the repository or GitHub will flag the entry as invalid.
2. Verify the file view shows no syntax errors (Settings → Code and automation
   → Code owners, or the file's rendered view).
3. Optionally enable "Require review from Code Owners" in the `main` branch
   protection rule once handles are confirmed.

Done when: handles are confirmed by maintainers and the CODEOWNERS file view
reports no errors.
