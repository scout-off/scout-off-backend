## API Versioning Policy

Decision: `/api/v2` is intended to be a near-parity surface with `/api/v1` by
default. Divergence is permitted but must be deliberate, documented, and
machine-checkable.

Mechanics:

- Any route present under `/api/v1` is expected to also be present under
  `/api/v2` unless it is explicitly listed in the parity allowlist.
- Deliberate differences (v2-only routes or v2 response-shape changes) must
  be documented in this file and added to `src/config/apiVersioning.ts` so
  the automated parity test can ignore them.

Rationale: This ensures accidental omissions (e.g., failing to copy a new
endpoint into v2) are caught by CI while still allowing planned API evolution.

Example allowed divergence:

- `/api/v2/versioning/demo` — a deliberately v2-only demo endpoint used to
  exercise the parity testing machinery.

## How the served version is determined

Clients can select an API version in three ways. When more than one applies
to a request, the following precedence is used, highest first:

1. **Explicit path prefix** — `/api/v2/...` or `/api/v1/...`. The prefix in
   the URL always wins over any header.
2. **`API-Version` request header** — e.g. `API-Version: 2` sent on a bare
   `/api/...` request. Parsed by `src/middleware/versionRouting.ts`, which
   sets `req.apiVersionOverride` for the router to consult.
3. **Default (`/api/...` with no header)** — treated as `/api/v1`. The `/api`
   alias is v1 for backward compatibility with clients that predate
   versioning.

Every response also carries an `API-Version: <major>` header
(`src/middleware/apiVersion.ts`), stating which version actually served the
request, independent of which of the three forms the client used to ask for
it.

## Current state of v2

`/api/v2` is a route set that is currently identical to `/api/v1` for every
endpoint except the deliberate divergences listed above — it exists so that
future breaking changes have a place to land without disturbing v1 clients,
not because v2 behavior differs from v1 today.

## Deprecation policy

No API version is deprecated today; `/api/v1` (and the unversioned `/api`
alias) remain fully supported. When a v1 sunset is eventually scheduled:

- It will be announced in this file and in `BACKEND_API_DOCS.md` with a
  concrete removal date, giving clients a minimum notice window.
- Requests to a deprecated version will start returning a `Deprecation`
  response header ahead of removal (in addition to the existing
  `API-Version` header) so automated clients can detect it.
- Unversioned `/api/...` requests already log a deprecation warning in
  production (see `versionRouting.ts`) encouraging callers to pin
  `/api/v1` or `/api/v2` explicitly ahead of any future policy change.
