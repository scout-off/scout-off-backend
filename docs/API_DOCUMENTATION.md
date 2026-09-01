# API Documentation Pipeline

This document describes how ScoutOff's API documentation is generated, why the route source is the canonical source of truth, and the annotation format to use when adding or changing a route. See #1047 for the audit that motivated this.

## The problem this replaces

Before this pipeline existed, the API had three independently-maintained documentation surfaces — the hand-written OpenAPI spec (`src/openapi.yaml`), `BACKEND_API_DOCS.md`'s endpoint tables, and the JSDoc comments in `src/routes/*.ts` — describing overlapping but non-identical subsets of the real API surface, with no tooling keeping them consistent. Reconciling them once does not fix the structural problem: the next engineer who adds a route and updates only the code (or only one doc surface) reintroduces the same drift.

## The fix: one canonical source, generated everything else

**The canonical source is the route source code itself** — `src/routes/*.ts` and `src/routes/v2/*.ts` — specifically:

- **Path, method, and path parameters** come from the actual `router.route(path)` / `router.<verb>(path, ...)` registrations.
- **Auth requirements** (`security` in the generated spec) come from the *real* middleware chain — `requireRole(...)`, `optionalAuth`, `requireApiKeyScope(...)`, `requireOwner`/`requireWalletOwner(...)` — never from a comment. This is deliberate: a hand-written "requires admin role" note can silently go stale the moment someone changes the middleware; a requirement computed from the middleware itself cannot.
- **Request body and query schemas** come from the actual Zod schema passed to `validateBody()` / `validateQuery()`, resolved by statically reading the schema's `z.object({...})` definition (following imports across files as needed) and converting it to JSON Schema. This is the real runtime validator, not a hand-typed approximation of it.
- **Summary, description, and response shapes** come from a JSDoc comment directly above the route registration — this is the one part of an operation that has no runtime signal to derive from (nothing in the code says what a `409` *means*), so it stays human-authored.

All of this is assembled by `scripts/generate-openapi-json.js` into `src/openapi.yaml` and `src/openapi.json`. Nothing here executes application code, boots the app, or touches the database — it's pure TypeScript AST analysis (`scripts/lib/docgen/`), so it's fast and has no runtime dependencies.

The only hand-maintained file is `src/openapi.components.yaml` — generic, cross-cutting infrastructure (security schemes, common path parameters, reusable envelope schemas, `info`/`servers`/`tags`). That content doesn't carry per-route drift risk, so it's fine to hand-maintain; anything that describes a *specific route* must not be added there.

`BACKEND_API_DOCS.md` no longer maintains its own per-endpoint reference table. It links to the generated spec (served live at `GET /api/docs`, `GET /api/docs/yaml`, and browsable at `GET /api/docs/ui`) as the single source for endpoint-level detail, and keeps only genuinely conceptual documentation (versioning, auth flow, error format, SSE, rate limits) that isn't a per-route listing.

## The annotation format

Add a JSDoc comment directly above the `router.route(...)` / `router.<verb>(...)` statement it documents:

```ts
/**
 * POST /api/players/:playerId/deactivate
 *
 * Admin soft-delete of a player. Requires { reason } in the request body.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @body { reason: string } — required, max 500 chars
 * @response 200 { success: true, data: { playerId, cancelledMilestones, notifiedScouts } }
 * @response 400 { success: false, error } — missing/invalid reason or playerId
 * @response 404 { success: false, error } — player not found
 * @auth Bearer (admin role required)
 */
router.route('/:playerId/deactivate')
  .post(requireRole('admin'), adminDeactivatePlayer)
  .all(methodNotAllowed(['POST']));
```

Tags:

| Tag | Required | Meaning |
| --- | --- | --- |
| (free text) | Yes* | The paragraph before any tag becomes the operation description; its first sentence becomes the summary. |
| `@summary` | No | Explicit one-line summary, overriding the derived one. Use this when the natural first sentence doesn't stand alone (e.g. it's a fragment of a longer paragraph). |
| `@param <name> {<type>} - <description>` | No | Describes a path parameter. The parameter's *existence* is always derived from the route path (`:name`); this tag only supplies its type/description. |
| `@query <name> {<type>} - <description>` | No | Describes a query parameter, for routes that read `req.query` without a Zod schema. When `validateQuery(...)` is present, query parameters are derived from that schema instead and this tag is unnecessary. |
| `@header <name> {<type>} - <description>` | No | Describes a request header the route reads (e.g. `Idempotency-Key`). |
| `@body <description>` | No | Free-text description shown alongside the mechanically-derived request body schema (or on its own, for routes with no Zod body schema — e.g. raw CSV uploads). |
| `@response <status> <description>` | **Yes, at least one** | One per status code the route can return. |
| `@auth <note>` | No | Supplementary human context only — e.g. "admin or profile owner" for a route with bespoke inline authorization logic a middleware name alone can't express. **Never used to compute the generated spec's actual `security` field** — that's always derived from the real middleware. |
| `@deprecated <reason>` | No | Marks the operation deprecated in the generated spec. |
| `@tag <name>` | No | Overrides the default tag (normally derived from which router file the route lives in). |

\* A route with no comment at all, or a comment with no derivable summary and no `@response` tag, fails `npm run docs:check` (see below).

**Multiple operations on one `router.route(path)` chain** (e.g. `GET` + `PUT` on the same path) can share one comment block: give each operation its own `METHOD /path` header line followed by its own tags, in the order the methods are chained. Don't put shared tags after the last header only — each method needs its own `@response` set directly under its own header, or that method won't see them.

## Commands

```bash
npm run build:openapi     # regenerate src/openapi.yaml + src/openapi.json from route sources
npm run validate:openapi  # fail if the committed spec is stale relative to the routes
npm run docs:check        # fail if any route lacks a summary + at least one @response tag
```

All three run in CI (`.github/workflows/ci.yml`) on every push and PR — a route added without documentation, or a spec that wasn't regenerated after a route changed, fails the build.

## Adding a new resource router

If you add an entirely new `src/routes/<name>.ts` file (not just a new endpoint on an existing router), add it to `ROUTE_FILES` in `scripts/generate-openapi-json.js` with its mount prefix and tag. `scripts/check-route-docs.js` cross-checks this list against `src/app.ts`'s `app.use(...)` calls and fails CI if a mounted router has no entry.
