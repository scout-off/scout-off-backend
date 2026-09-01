/**
 * OpenAPI route contract tests (#1155)
 *
 * The OpenAPI spec (src/openapi.yaml + src/openapi.json) documents the
 * request/response shapes of every route. Nothing previously asserted that a
 * live response actually conforms to those shapes, so the spec could drift
 * from reality (undocumented fields, wrong types, missing required fields,
 * status-code mismatches) until an external consumer breaks.
 *
 * This harness closes that gap:
 *
 *   1. It loads the committed spec and iterates every documented operation.
 *      Operations with a straightforward fixture (player list, single player,
 *      milestones, subscription status) are executed against the app with
 *      supertest and their response bodies are validated against the spec's
 *      components.schemas with ajv.
 *   2. Validation is STRICT: object schemas are dereferenced and closed
 *      (additionalProperties: false), so an undocumented field fails the
 *      test just like a wrong type or a missing required field. The spec
 *      schemas are the source of truth; anything the server returns that the
 *      spec does not document is a failure (and vice versa).
 *   3. Every operation NOT yet covered must appear in the ALLOWLIST below
 *      with a reason. The coverage-completeness test fails when a new
 *      endpoint is added to the spec without being added to COVERED or
 *      ALLOWLIST, so coverage gaps stay explicit and tracked instead of
 *      silently accumulating.
 *
 * Health/version probes are intentionally out of scope: they are defined
 * directly in src/app.ts at the root path (not under the /api surface the
 * OpenAPI spec documents), so there is no spec entry for them to validate
 * against.
 *
 * Note on schema edits: adding a field to a component schema in
 * src/openapi.components.yaml and running `npm run build:openapi` updates the
 * contract; this test then enforces it. Fields such as `nextCursor`,
 * `registered_at`, `progressLabel` and `verificationBadge` were added to the
 * spec because the server demonstrably returns them — previously undocumented
 * drift this harness now pins down.
 */

import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import request from "supertest";
import Ajv from "ajv";
import app from "../../src/app";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Follow the conventions of tests/routes/player.test.ts: the db and network
// services are mocked so fixtures are deterministic and no real Stellar RPC /
// IPFS calls are made. The contract under test is the route response shape,
// so the fixture data below is what the validators must accept.

jest.mock("../../src/db", () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
  countPlayers: jest.fn().mockReturnValue(0),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: "player_search",
    admin_wallet: "",
    query_params: "{}",
    created_at: new Date().toISOString(),
    prev_hash: "0".repeat(64),
    hash: "mock-hash-1",
    event_source: "app_event",
  }),
  getLatestSubscription: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../src/services/stellar", () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  updateProfile: jest.fn(),
}));

jest.mock("../../src/services/ipfs", () => ({
  pinJson: jest.fn().mockResolvedValue("QmContractTestCID"),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
}));

jest.mock("../../src/services/indexer", () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock("../../src/services/webhooks", () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/services/cache", () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
  invalidatePlayerCache: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET ?? "test-secret";
const PLAYER_WALLET = "G" + "A".repeat(55);
// Valid Stellar addresses: requireWalletOwner() validates the checksum on
// the :wallet path param and rejects malformed addresses with 400.
const SCOUT_WALLET = "GATAGRQ7FKP53QHHAFKG7RGD3XAGCA46HG6JSVKT57S4KPW6CQ4IUIIQ";
const PLAYER_ID = "player-contract-1";

const PLAYER_ROW = {
  player_id: PLAYER_ID,
  wallet: PLAYER_WALLET,
  position: "Forward",
  region: "West Africa",
  metadata_uri: "QmContractTestCID",
  progress_level: 1,
  created_at: 1700000000,
  registered_at: 1700000000,
  is_active: 1,
};

const APPROVED_MILESTONE = {
  type: "milestone_approved",
  payload: {
    milestone_id: "milestone-1",
    player_id: PLAYER_ID,
    milestone_type: "performance",
    evidence_uri: "ipfs://QmContractTestCID",
    submitted_at: 1000,
    approved_at: 2000,
  },
};

function makeScoutToken(): string {
  return jwt.sign({ sub: SCOUT_WALLET, role: "scout" }, SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  const db = require("../../src/db") as {
    getPlayerById: jest.Mock;
    searchPlayers: jest.Mock;
    countPlayers: jest.Mock;
    countTrialOffersByPlayer: jest.Mock;
    queryEvents: jest.Mock;
    getLatestSubscription: jest.Mock;
  };
  db.getPlayerById.mockReturnValue(PLAYER_ROW);
  db.searchPlayers.mockReturnValue({ data: [PLAYER_ROW], nextCursor: null });
  db.countPlayers.mockReturnValue(1);
  db.countTrialOffersByPlayer.mockReturnValue(0);
  db.queryEvents.mockImplementation((type: string) =>
    type === "milestone_approved" ? [APPROVED_MILESTONE] : [],
  );
  db.getLatestSubscription.mockResolvedValue(null);
});

// ─── Spec loading + schema helpers ────────────────────────────────────────────

interface OpenApiSpec {
  servers: { url: string }[];
  components: { schemas: Record<string, Record<string, unknown>> };
  paths: Record<string, Record<string, { operationId?: string; responses: Record<string, unknown> }>>;
}

const spec: OpenApiSpec = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/openapi.json"), "utf8"),
);

type SchemaObject = Record<string, unknown>;

/**
 * Resolve `$ref` pointers into `#/components/schemas/<name>` and flatten
 * `allOf` branches into a single object schema. The resulting schema is fully
 * self-contained (no `$ref` remains), which lets the harness apply strict
 * closure below without tripping over JSON Schema's `additionalProperties`
 * + `allOf` interaction.
 */
function derefAndClose(schema: unknown, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(schema)) {
    return schema.map((s) => derefAndClose(s, seen));
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const obj = schema as SchemaObject;

  if (typeof obj.$ref === "string") {
    const ref = obj.$ref as string;
    if (!ref.startsWith("#/components/schemas/")) {
      throw new Error(`Contract harness: unsupported $ref "${ref}"`);
    }
    const name = ref.split("/").pop() as string;
    if (seen.has(name)) {
      // Cycle guard — no component schema in the spec is recursive today.
      return { type: "object" };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    const target = spec.components.schemas[name];
    if (!target) {
      throw new Error(`Contract harness: unknown component schema "${name}"`);
    }
    return derefAndClose(target, nextSeen);
  }

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$ref") continue;
    out[key] = derefAndClose(value, seen);
  }

  if (Array.isArray(out.allOf)) {
    const merged: SchemaObject = {
      type: "object",
      properties: {},
      required: [],
    };
    for (const branch of out.allOf as unknown[]) {
      const b = derefAndClose(branch, seen) as SchemaObject;
      if (b && typeof b === "object" && b.type === "object") {
        Object.assign(merged.properties as Record<string, unknown>, b.properties ?? {});
        (merged.required as string[]).push(...((b.required as string[]) ?? []));
      }
    }
    for (const [key, value] of Object.entries(out)) {
      if (key === "allOf" || key === "properties" || key === "required") continue;
      merged[key] = value;
    }
    merged.required = [...new Set(merged.required as string[])];
    return closeSchema(merged);
  }

  return closeSchema(out);
}

/** Add `additionalProperties: false` to object schemas that don't already declare it. */
function closeSchema(schema: SchemaObject): SchemaObject {
  const out = { ...schema };
  if (
    out.type === "object" &&
    out.additionalProperties === undefined &&
    out.unevaluatedProperties === undefined
  ) {
    out.additionalProperties = false;
  }
  return out;
}

/** `{ success: true, data: <dataSchema> }` — the envelope every API response uses. */
function successEnvelope(dataSchema: unknown): SchemaObject {
  return closeSchema({
    type: "object",
    required: ["success", "data"],
    properties: {
      success: { const: true },
      data: dataSchema,
    },
  });
}

// ─── Covered operations ───────────────────────────────────────────────────────
// Keyed by "METHOD /path" as it appears in the spec. Each entry describes a
// valid request (path params, query string, auth) and the response schema the
// body must conform to. Schemas are composed from spec components, so they
// can never drift from the documented contract by construction.

interface CoveredFixture {
  params?: Record<string, string>;
  query?: Record<string, string>;
  auth?: "scout";
  expectedStatus: number;
  schema: (s: OpenApiSpec) => unknown;
}

const COVERED: Record<string, CoveredFixture> = {
  "GET /players": {
    query: { page: "1", pageSize: "20" },
    expectedStatus: 200,
    schema: (s) => derefAndClose(s.components.schemas.PlayerList),
  },
  "GET /players/{playerId}": {
    params: { playerId: PLAYER_ID },
    expectedStatus: 200,
    schema: (s) => successEnvelope(derefAndClose(s.components.schemas.PlayerDetail)),
  },
  "GET /players/{playerId}/milestones": {
    params: { playerId: PLAYER_ID },
    expectedStatus: 200,
    schema: (s) =>
      successEnvelope({ type: "array", items: derefAndClose(s.components.schemas.Milestone) }),
  },
  "GET /scouts/{wallet}/subscription": {
    params: { wallet: SCOUT_WALLET },
    auth: "scout",
    expectedStatus: 200,
    schema: (s) => successEnvelope(derefAndClose(s.components.schemas.SubscriptionStatus)),
  },
};

// ─── Allowlist ────────────────────────────────────────────────────────────────
// Operations not yet covered, with the reason each is excluded. Adding a new
// endpoint to the spec without an entry here (or in COVERED) fails the
// coverage-completeness test below.

const ALLOWLIST: Record<string, string> = {
  // Admin — all require an admin JWT and/or seeded admin state fixtures.
  "GET /admin/actions/pending": "admin-only read; requires admin JWT + seeded pending actions",
  "GET /admin/actions/{id}": "admin-only read; requires admin JWT + seeded action",
  "POST /admin/actions/{id}/approve": "admin-only multi-sig write; requires admin JWT + action state",
  "GET /admin/audit": "admin-only read; requires admin JWT + audit rows",
  "GET /admin/audit/trail": "admin-only read; requires admin JWT + audit rows",
  "GET /admin/audit/verify": "admin-only read; requires admin JWT + audit rows",
  "POST /admin/contract/pause": "admin-only write; requires admin JWT",
  "POST /admin/contract/unpause": "admin-only write; requires admin JWT",
  "GET /admin/events": "admin-only read; requires admin JWT + indexed events",
  "GET /admin/events/export": "CSV stream; requires admin JWT",
  "GET /admin/feature-flags": "admin-only read; requires admin JWT + seeded flags",
  "PUT /admin/feature-flags": "admin-only write; requires admin JWT + seeded flags",
  "PUT /admin/feature-flags/{name}": "admin-only write; requires admin JWT + seeded flag",
  "GET /admin/fees": "admin-only read; requires admin JWT + fee events",
  "POST /admin/fees": "admin-only write; requires admin JWT + on-chain fee state",
  "POST /admin/fees/withdraw": "admin-only write; requires admin JWT + on-chain fee state",
  "POST /admin/indexer/reindex": "admin-only write; mutates indexer state",
  "POST /admin/introspect": "admin-only read; requires admin JWT",
  "POST /admin/ip-allowlist": "admin-only write; requires admin JWT",
  "GET /admin/ip-reputation/{ip}": "admin-only read; requires admin JWT",
  "POST /admin/players/import": "admin-only bulk write; requires admin JWT",
  "POST /admin/players/{playerId}/deactivate": "admin-only write; requires admin JWT",
  "POST /admin/players/{playerId}/reactivate": "admin-only write; requires admin JWT",
  "POST /admin/reindex": "admin-only background job; mutates indexer state",
  "GET /admin/reindex/status": "admin-only read; requires admin JWT",
  "GET /admin/stats": "admin-only read; requires admin JWT + indexed events",
  "POST /admin/tokens/revoke": "admin-only write; requires admin JWT",
  "GET /admin/validators": "admin-only read; requires admin JWT + validators",
  "POST /admin/validators/import": "admin-only bulk write; requires admin JWT",
  "POST /admin/validators/register": "admin-only write; on-chain registration",
  "POST /admin/validators/revoke": "admin-only write; on-chain revocation",
  "GET /admin/validators/{wallet}/stats": "admin-only read; requires admin JWT",
  "GET /admin/webhooks/dead-letters": "admin-only read; requires admin JWT + dead-letter rows",
  "DELETE /admin/webhooks/dead-letters": "admin-only write; requires admin JWT",
  "DELETE /admin/webhooks/dead-letters/{id}": "admin-only write; requires admin JWT",
  "POST /admin/webhooks/dead-letters/{id}/requeue": "admin-only write; re-signs webhook payload",
  "POST /admin/webhooks/{id}/replay": "deprecated alias; admin-only write",

  // Auth — SEP-10 challenge flow requires signed XDR fixtures.
  "GET /auth/challenge": "SEP-10 challenge; response is an XDR string, not a JSON envelope",
  "POST /auth/logout": "requires auth token + token-revocation side effects",
  "POST /auth/refresh": "requires a valid refresh-token fixture",
  "POST /auth/token": "requires a signed SEP-10 challenge XDR fixture",

  // Docs — serve the spec/UI themselves; not JSON API payloads.
  "GET /docs": "serves the OpenAPI spec itself; validating it against itself is circular",
  "GET /docs/ui": "serves Swagger UI HTML (non-JSON)",
  "GET /docs/yaml": "serves raw YAML (non-JSON)",

  // Events — SSE is a long-lived stream, not a JSON response.
  "GET /events/stream": "SSE stream; long-lived connection, not a JSON envelope",

  // Players — write ops or auth/state-dependent reads.
  "POST /players/register": "write op; requires player JWT + IPFS pin",
  "PUT /players/{playerId}": "write op; requires owner JWT + on-chain update",
  "GET /players/{playerId}/analytics": "requires owner JWT + analytics rows",
  "POST /players/{playerId}/anonymize": "destructive write op; requires owner JWT",
  "POST /players/{playerId}/deactivate": "write op; requires owner JWT",
  "GET /players/{playerId}/history": "requires history rows + owner/admin auth",
  "GET /players/{playerId}/history/{version}": "requires history rows + owner/admin auth",
  "GET /players/{playerId}/history/{version}/diff": "requires history rows + owner/admin auth",
  "POST /players/{playerId}/reactivate": "write op; requires owner JWT",
  "GET /players/{playerId}/tokens": "requires on-chain token-state fixture",
  "POST /players/{playerId}/tokens/buy": "write op; requires on-chain payment fixture",
  "POST /players/{playerId}/trial-offers/{offerId}/accept": "write op; requires trial-offer state + auth",
  "POST /players/{playerId}/trial-offers/{offerId}/reject": "write op; requires trial-offer state + auth",

  // Scouts — require scout JWT plus per-resource state fixtures.
  "GET /scouts/{wallet}/api-keys": "requires scout JWT + API-key fixtures",
  "POST /scouts/{wallet}/api-keys": "write op; requires scout JWT",
  "DELETE /scouts/{wallet}/api-keys/{id}": "write op; requires scout JWT",
  "POST /scouts/{wallet}/api-keys/{id}/rotate": "write op; requires scout JWT",
  "GET /scouts/{wallet}/bookmark-folders": "requires scout JWT + bookmark fixtures",
  "POST /scouts/{wallet}/bookmark-folders": "write op; requires scout JWT",
  "DELETE /scouts/{wallet}/bookmark-folders/{folderId}": "write op; requires scout JWT",
  "GET /scouts/{wallet}/bookmarks": "requires scout JWT + bookmark fixtures",
  "POST /scouts/{wallet}/bookmarks": "write op; requires scout JWT",
  "DELETE /scouts/{wallet}/bookmarks/{playerId}": "write op; requires scout JWT",
  "GET /scouts/{wallet}/contacts": "requires scout JWT + unlock fixtures",
  "GET /scouts/{wallet}/contacts/{playerId}": "requires scout JWT + unlock fixtures",
  "POST /scouts/{wallet}/contacts/{playerId}/unlock": "write op; requires scout JWT + on-chain payment",
  "GET /scouts/{wallet}/notes": "requires scout JWT + note fixtures",
  "GET /scouts/{wallet}/notes/{playerId}": "requires scout JWT + note fixtures",
  "PUT /scouts/{wallet}/notes/{playerId}": "write op; requires scout JWT",
  "GET /scouts/{wallet}/payments": "requires scout JWT + payment history",
  "GET /scouts/{wallet}/players/{playerId}/notes": "requires scout JWT + note fixtures",
  "POST /scouts/{wallet}/players/{playerId}/notes": "write op; requires scout JWT",
  "PUT /scouts/{wallet}/players/{playerId}/notes/{noteId}": "write op; requires scout JWT",
  "DELETE /scouts/{wallet}/players/{playerId}/notes/{noteId}": "write op; requires scout JWT",
  "GET /scouts/{wallet}/recommendations": "requires scout JWT + recommendation fixtures",
  "GET /scouts/{wallet}/saved-searches": "requires scout JWT + saved-search fixtures",
  "POST /scouts/{wallet}/saved-searches": "write op; requires scout JWT",
  "PUT /scouts/{wallet}/saved-searches/{id}": "write op; requires scout JWT",
  "DELETE /scouts/{wallet}/saved-searches/{id}": "write op; requires scout JWT",
  "GET /scouts/{wallet}/saved-searches/{id}/run": "requires scout JWT + saved-search fixtures",
  "POST /scouts/{wallet}/subscribe": "write op; requires scout JWT + on-chain subscribe",
  "PUT /scouts/{wallet}/subscribe": "write op; requires scout JWT + on-chain subscribe",
  "DELETE /scouts/{wallet}/subscribe": "write op; requires scout JWT + subscription state",
  "POST /scouts/{wallet}/trial-offer": "write op; requires scout JWT + on-chain offer",
  "GET /scouts/{wallet}/trial-offers": "requires scout JWT + trial-offer fixtures",
  "POST /scouts/{wallet}/trial-offers": "write op; requires scout JWT + on-chain offer",
  "DELETE /scouts/{wallet}/trial-offers/{offerId}": "write op; requires scout JWT + offer state",
  "GET /scouts/{wallet}/webhooks": "requires scout JWT + webhook fixtures",
  "POST /scouts/{wallet}/webhooks": "write op; requires scout JWT",
  "DELETE /scouts/{wallet}/webhooks/{id}": "write op; requires scout JWT",
  "POST /scouts/{wallet}/webhooks/{id}/test": "write op; issues outbound HTTP request",

  // Validators — require validator JWT + milestone evidence fixtures.
  "POST /validators/milestone": "write op; requires validator JWT + evidence fixture",
  "POST /validators/milestones/approve-bulk": "write op; requires validator JWT + pending milestones",
  "GET /validators/milestones/pending": "requires validator JWT + pending milestones",
  "GET /validators/{wallet}/milestones/pending": "requires validator JWT + pending milestones",

  // v2
  "GET /versioning/demo": "v2-only demo route",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findOperation(
  method: string,
  pathTemplate: string,
): { operationId?: string; responses: Record<string, unknown> } | undefined {
  const item = spec.paths[pathTemplate];
  if (!item) return undefined;
  return item[method.toLowerCase()];
}

function buildUrl(pathTemplate: string, fixture: CoveredFixture): string {
  const server = spec.servers[0].url; // "/api" — the stable version-less alias
  const filled = pathTemplate.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = fixture.params?.[name];
    if (value === undefined) {
      throw new Error(`Contract harness: no param fixture for "{${name}}" in ${pathTemplate}`);
    }
    return value;
  });
  return `${server}${filled}`;
}

function sendRequest(method: string, pathTemplate: string, fixture: CoveredFixture) {
  let req = request(app)[method.toLowerCase() as "get"](buildUrl(pathTemplate, fixture));
  if (fixture.query) req = req.query(fixture.query);
  if (fixture.auth === "scout") req = req.set("Authorization", `Bearer ${makeScoutToken()}`);
  return req;
}

function validateAgainst(schema: unknown, body: unknown): { valid: boolean; errors?: unknown[] } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  const valid = validate(body);
  return valid ? { valid } : { valid, errors: validate.errors ?? [] };
}

function assertConforms(key: string, fixture: CoveredFixture): void {
  const [method, pathTemplate] = key.split(" ");
  const op = findOperation(method, pathTemplate);
  expect(op).toBeDefined();
  expect(op!.operationId).toBeDefined();

  return sendRequest(method, pathTemplate, fixture).then((res) => {
    expect(res.status).toBe(fixture.expectedStatus);
    expect(Object.keys(op!.responses)).toContain(String(res.status));

    const { valid, errors } = validateAgainst(fixture.schema(spec), res.body);
    if (!valid) {
      throw new Error(
        `OpenAPI contract violation for ${key}:\n` +
          `${JSON.stringify(errors, null, 2)}\n` +
          `response body: ${JSON.stringify(res.body, null, 2)}`,
      );
    }
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OpenAPI contract conformance", () => {
  for (const [key, fixture] of Object.entries(COVERED)) {
    it(`${key} response conforms to the documented schema`, () => assertConforms(key, fixture));
  }
});

describe("OpenAPI contract coverage completeness", () => {
  it("every documented operation is contract-tested or explicitly allowlisted", () => {
    const uncovered: string[] = [];
    for (const [pathTemplate, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === "servers") continue;
        const key = `${method.toUpperCase()} ${pathTemplate}`;
        if (COVERED[key]) continue;
        const reason = ALLOWLIST[key];
        if (!reason || reason.trim().length === 0) {
          uncovered.push(`${key} (${op.operationId ?? "unknown"})`);
        }
      }
    }
    if (uncovered.length > 0) {
      throw new Error(
        "Operations with no contract coverage and no allowlist reason:\n" +
          uncovered.join("\n") +
          "\nAdd them to COVERED (with a fixture + schema) or to ALLOWLIST (with a reason).",
      );
    }
  });

  it("every COVERED and ALLOWLIST key exists in the spec", () => {
    const unknownKeys: string[] = [];
    for (const key of [...Object.keys(COVERED), ...Object.keys(ALLOWLIST)]) {
      const [method, pathTemplate] = key.split(" ");
      if (!findOperation(method, pathTemplate)) {
        unknownKeys.push(key);
      }
    }
    expect(unknownKeys).toEqual([]);
  });
});

describe("contract harness rejects schema violations", () => {
  // The harness must have teeth: the same validation used against live
  // responses must fail on undocumented fields, wrong types, and missing
  // required fields. The baseline is the real response body, so these tests
  // prove the validator itself catches the drift this issue targets.
  async function baselinePlayerBody(): Promise<Record<string, unknown>> {
    const fixture = COVERED["GET /players/{playerId}"];
    const res = await sendRequest("GET", "/players/{playerId}", fixture);
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  it("rejects an undocumented top-level field", async () => {
    const body = await baselinePlayerBody();
    (body as Record<string, unknown>).undocumentedField = "surprise";
    const { valid } = validateAgainst(COVERED["GET /players/{playerId}"].schema(spec), body);
    expect(valid).toBe(false);
  });

  it("rejects an undocumented field inside the data payload", async () => {
    const body = await baselinePlayerBody();
    ((body.data as Record<string, unknown>).undocumentedField = "surprise");
    const { valid } = validateAgainst(COVERED["GET /players/{playerId}"].schema(spec), body);
    expect(valid).toBe(false);
  });

  it("rejects a wrong field type", async () => {
    const body = await baselinePlayerBody();
    (body.data as Record<string, unknown>).offerCount = "not-a-number";
    const { valid } = validateAgainst(COVERED["GET /players/{playerId}"].schema(spec), body);
    expect(valid).toBe(false);
  });

  it("rejects a missing required field", async () => {
    const body = await baselinePlayerBody();
    delete (body.data as Record<string, unknown>).offerCount;
    const { valid } = validateAgainst(COVERED["GET /players/{playerId}"].schema(spec), body);
    expect(valid).toBe(false);
  });
});
