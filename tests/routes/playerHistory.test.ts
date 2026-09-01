import request from "supertest";
import jwt from "jsonwebtoken";

import app from "../../src/app";

const SECRET = process.env.JWT_SECRET ?? "test-secret";

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: "1h" });
}

// Keep consistent with other tests
const PLAYER_WALLET = "G" + "A".repeat(55);
const ADMIN_WALLET = "G" + "B".repeat(55);

// Ensure we use real DB in this suite (no jest.mock for src/db)

describe("Player profile history", () => {
  // Shared spy/mock references reset between tests
  let updateProfileSpy: jest.SpyInstance;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stellar = require("../../src/services/stellar");
    updateProfileSpy = jest
      .spyOn(stellar, "updateProfile")
      .mockImplementationOnce(async () => ({
        transactionId: "tx-1",
        metadataUri: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      }))
      .mockImplementationOnce(async () => ({
        transactionId: "tx-2",
        metadataUri: "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
      }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ipfs = require("../../src/services/ipfs");
    jest.spyOn(ipfs, "pinJson").mockResolvedValue("QmMetaPinned");
    jest
      .spyOn(ipfs, "gatewayUrl")
      .mockImplementation((cid: unknown) => `https://gateway/${cid}`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const webhooks = require("../../src/services/webhooks");
    jest.spyOn(webhooks, "dispatchEventWebhook").mockResolvedValue(undefined);
  });

  afterEach(() => {
    updateProfileSpy?.mockRestore();
    jest.restoreAllMocks();
  });

  // ── Shared setup: register player and perform 2 updates ────────────────────

  async function setupPlayerWithHistory(): Promise<{
    playerId: string;
    ownerToken: string;
  }> {
    const playerToken = makeToken(PLAYER_WALLET, "player");

    const registerRes = await request(app)
      .post("/api/players/register")
      .set("Authorization", `Bearer ${playerToken}`)
      .send({
        wallet: PLAYER_WALLET,
        position: "striker",
        region: "europe",
        metadataUri: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      });
    expect(registerRes.status).toBe(201);
    const playerId = registerRes.body.data.playerId;

    // requireOwner compares the JWT subject to the :playerId route param, so
    // the update token's sub must be the player id (not the wallet).
    const ownerToken = makeToken(playerId, "player");

    // Optimistic concurrency (#1151): the first update has no prior token, so
    // use the documented override; the response ETag is the token for the
    // second update.
    const put1 = await request(app)
      .put(`/api/players/${playerId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("If-Match", "*")
      .send({ metadataUri: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" });
    expect(put1.status).toBe(200);

    const put2 = await request(app)
      .put(`/api/players/${playerId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("If-Match", put1.headers.etag)
      .send({ metadataUri: "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64" });
    expect(put2.status).toBe(200);

    return { playerId, ownerToken };
  }

  // ── GET /api/players/:playerId/history ─────────────────────────────────────

  it("accumulates across multiple PUT updates and history returns version list (admin)", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const historyRes = await request(app)
      .get(`/api/players/${playerId}/history`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.success).toBe(true);

    const history = historyRes.body.data;
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(2);

    // Newest first
    expect(history[0].metadataUri).toBe(
      "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
    );
    expect(history[0].txHash).toBe("tx-2");
    expect(history[0].version).toBe(2);

    expect(history[1].metadataUri).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    );
    expect(history[1].txHash).toBe("tx-1");
    expect(history[1].version).toBe(1);
  });

  it("returns 404 for history of unknown player", async () => {
    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get("/api/players/nonexistent-player-id/history")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("owner can access their own history", async () => {
    const { playerId, ownerToken } = await setupPlayerWithHistory();

    const res = await request(app)
      .get(`/api/players/${playerId}/history`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ── GET /api/players/:playerId/history/:version ────────────────────────────

  it("returns version 1 snapshot correctly", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/1`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.metadataUri).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    );
    expect(res.body.data.txHash).toBe("tx-1");
  });

  it("returns version 2 snapshot correctly", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/2`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.metadataUri).toBe(
      "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
    );
    expect(res.body.data.txHash).toBe("tx-2");
  });

  it("returns 404 for a non-existent version", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/99`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 for version on unknown player", async () => {
    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get("/api/players/nonexistent-player-id/history/1")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for non-numeric version", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/abc`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── GET /api/players/:playerId/history/:version/diff ──────────────────────

  it("diff between version 2 and version 1 shows metadataUri changed", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/2/diff`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.previousVersion).toBe(1);

    const diff = res.body.data.diff;
    expect(diff).toHaveProperty("metadataUri");
    expect(diff.metadataUri.from).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    );
    expect(diff.metadataUri.to).toBe(
      "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
    );
  });

  it("diff for version 1 (initial snapshot) has empty diff and null previousVersion", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/1/diff`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.previousVersion).toBeNull();
    // Version 1 has no predecessor — diff should show metadataUri added (from null)
    const diff = res.body.data.diff;
    expect(diff).toHaveProperty("metadataUri");
    expect(diff.metadataUri.from).toBeNull();
    expect(diff.metadataUri.to).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    );
  });

  it("diff returns 404 for non-existent version", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/99/diff`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("diff returns 404 for unknown player", async () => {
    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get("/api/players/nonexistent-player-id/history/1/diff")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("diff returns 400 for non-numeric version", async () => {
    const { playerId } = await setupPlayerWithHistory();

    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const res = await request(app)
      .get(`/api/players/${playerId}/history/abc/diff`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
