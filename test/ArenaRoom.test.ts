import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { ArenaState } from "../src/rooms/schema/ArenaState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// A hand-rolled fake `players` collection -- no MongoDB runs in this test
// process (see the "degrades to no-op" test below), so refreshLeaderboard()'s
// merge/dedupe logic needs SOMETHING to query. This implements just the
// subset ArenaRoom.ts actually calls: find().sort().limit().toArray(),
// updateOne() (upsert), findOne(). Good enough to exercise real merge logic
// without pulling in a real database for tests.
function fakePlayersCollection(seed: PlayerDoc[] = []): Collection<PlayerDoc> {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  return {
    docs, // exposed for test assertions, not part of the real Collection API
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      docs.set(filter._id, { ...base, ...(update.$set ?? {}) } as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  } as unknown as Collection<PlayerDoc>;
}

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // Every leaderboard test below swaps in a fake collection via
  // __setPlayersForTest(); reset to null afterwards so the OTHER tests in
  // this file (which assert the real "no MONGODB_URI" no-op path) keep seeing
  // Mongo as unreachable, same as a real local `npm start`.
  afterEach(() => __setPlayersForTest(null));

  it("connecting into a room", async () => {
    // `room` is the server-side Room instance reference.
    const room = await colyseus.createRoom<ArenaState>("arena", {});

    // `client1` is the client-side `Room` instance reference (same as JavaScript SDK)
    const client1 = await colyseus.connectTo(room);

    // make your assertions
    assert.strictEqual(client1.sessionId, room.clients[0].sessionId);
  });

  // Exercises the exact message shapes src/network/NetworkContext.jsx and
  // Player.jsx send from the client, end-to-end against the real room --
  // catches a field-name mismatch between client and server that a
  // TypeScript-only check on the server side can't.
  it("relays move/targetHit between two clients", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    client1.send("move", {
      x: 1, y: 2, z: 3, yaw: 0.5, speed: 0.75, firing: true,
      beamToX: 4, beamToY: 5, beamToZ: 6,
    });
    await room.waitForNextPatch();

    const p1FromClient2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p1FromClient2.x, 1);
    assert.strictEqual(p1FromClient2.speed, 0.75);
    assert.strictEqual(p1FromClient2.firing, true);
    assert.strictEqual(p1FromClient2.beamToZ, 6);

    client1.send("targetHit", { targetId: "target-a" });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.targetsHit.get("target-a"), true);

    // Avatar blob relays verbatim, so client2 can rebuild client1's real
    // Bloxity character (equipped cosmetics + proportions).
    const avatar = JSON.stringify({ e: { headId: "42" }, p: { height: 1.2 } });
    client1.send("setAvatar", { avatar });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client1.sessionId).avatar, avatar);

    // Stats relay verbatim (clamped to >= 0), so client2 can rank client1 on
    // an in-world leaderboard.
    client1.send("stats", { power: 2480, rebirth: 3, wins: 17 });
    await room.waitForNextPatch();
    const p1StatsFromClient2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p1StatsFromClient2.power, 2480);
    assert.strictEqual(p1StatsFromClient2.rebirth, 3);
    assert.strictEqual(p1StatsFromClient2.wins, 17);

    // A negative value (never legitimately sent by the client, but the room
    // trusts the wire otherwise) is clamped rather than relayed as-is.
    client1.send("stats", { power: -5 });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client1.sessionId).power, 0);
  });

  // PVP: client1 reports the hit it landed on client2 (exact shape src/
  // systems/playerCombat.js strikeTarget() sends), client2 sees its own hp
  // drop and, once it hits 0, itself flip dead -- then reports its own
  // respawn (src/systems/playerHealth.js) and comes back to full health.
  it("relays playerDamage/playerRespawn between two clients", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    assert.strictEqual(client1.state.players.get(client2.sessionId).hp, 100);

    client1.send("playerDamage", { targetId: client2.sessionId, hp: 63 });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client2.sessionId).hp, 63);
    assert.strictEqual(client1.state.players.get(client2.sessionId).dead, false);

    // A client can never damage itself.
    client2.send("playerDamage", { targetId: client2.sessionId, hp: 1 });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client2.sessionId).hp, 63);

    // hp reaching 0 flips dead, same as a wall's hp reaching 0 flips destroyed.
    client1.send("playerDamage", { targetId: client2.sessionId, hp: 0 });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client2.sessionId).dead, true);

    // A dead target can't be damaged again until it respawns.
    client1.send("playerDamage", { targetId: client2.sessionId, hp: 50 });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client2.sessionId).hp, 0);

    client2.send("playerRespawn", {});
    await room.waitForNextPatch();
    const respawned = client1.state.players.get(client2.sessionId);
    assert.strictEqual(respawned.hp, 100);
    assert.strictEqual(respawned.dead, false);
  });

  // No MONGODB_URI in this test env (matches a real local `npm start` with no
  // Mongo running) -- exercises the degraded path client systems/db.ts §
  // ArenaRoom.ts both promise: a signed-in join and a saveProgress message
  // must behave exactly like a guest, never throw or drop the connection.
  it("degrades to no-op persistence when Mongo is unreachable", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room, { userId: "bloxity-user-1" });

    client1.send("saveProgress", {
      power: 42,
      rebirth: 1,
      wins: 7,
      ownedHexPads: [0, 1],
      equippedHexPad: 1,
      ownedAuras: [],
      equippedAura: null,
    });
    await room.waitForNextPatch();

    // Nothing crashed and the connection is still alive.
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "");
  });

  // The bug this was written for: a player who joins as a guest (no
  // `userId` yet -- the SDK's auth hasn't settled), then signs in, then logs
  // back out -- all in the same room session, never rejoining. Without the
  // `identify` message, ArenaRoom.userIds stays empty forever and
  // saveProgress silently no-ops for that whole session even while "signed
  // in", which is exactly what made progress never survive a refresh.
  it("registers/clears the room's userId mapping via identify, independent of join", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    // Joined as a guest -- no userId in the join options.
    const client1 = await colyseus.connectTo(room, { username: "Epic86" });
    assert.strictEqual(room.userIds.has(client1.sessionId), false);

    // Signs in mid-session: client systems/net.js sendIdentityNow().
    client1.send("identify", { username: "RealBloxityName", userId: "bloxity-user-1" });
    await room.waitForNextPatch();
    assert.strictEqual(room.userIds.get(client1.sessionId), "bloxity-user-1");
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "RealBloxityName");

    // saveProgress now actually registers against the signed-in id (still
    // exercising the "Mongo unreachable" degraded path -- see the test
    // above -- but the mapping itself is what we're asserting here).
    client1.send("saveProgress", { power: 99 });
    await room.waitForNextPatch();

    // Logs out without reloading: the mapping is dropped and the displayed
    // name reverts, so a leaderboard reading this row stops attributing
    // further play to the signed-in account.
    client1.send("identify", { username: "Epic86", userId: "" });
    await room.waitForNextPatch();
    assert.strictEqual(room.userIds.has(client1.sessionId), false);
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "Epic86");
  });

  // Feature: the 3 in-world leaderboards must show every account that has
  // EVER saved to Mongo, not just who's connected right now. This is the
  // Mongo-write half of that: saveProgress must persist the player's CURRENT
  // display name (read off their own PlayerState, not the incoming message),
  // so refreshLeaderboard() below has something to show once they go offline.
  it("saveProgress persists the connection's own username, not the message body", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room, { username: "Zoe", userId: "bloxity-zoe" });

    // A forged/stale username in the payload must be ignored -- the room's
    // own PlayerState.username (already validated at join/identify) wins.
    client1.send("saveProgress", { power: 50, username: "NotZoe" });
    await room.waitForNextPatch();

    const doc = await fake.findOne({ _id: "bloxity-zoe" } as any);
    assert.strictEqual(doc?.username, "Zoe");
    assert.strictEqual(doc?.power, 50);
  });

  // The core new server behavior: an online session (live, freshest) merged
  // with a DIFFERENT account's all-time saved doc (offline right now).
  it("refreshLeaderboard merges an online session with a distinct offline Mongo doc", async () => {
    const fake = fakePlayersCollection([
      { _id: "ghost", username: "Ghost", power: 500, rebirth: 0, wins: 0, ownedHexPads: [0], equippedHexPad: 0, ownedAuras: [], equippedAura: null, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);

    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room, { username: "Online1" });
    client1.send("stats", { power: 10 });
    await room.waitForNextPatch();

    const leaderboardPromise = client1.waitForMessage("leaderboard");
    await (room as any).refreshLeaderboard();
    const payload = await leaderboardPromise;

    const names = payload.power.map((row: any) => row.name);
    assert.ok(names.includes("Ghost"), "offline saved account should appear");
    assert.ok(names.includes("Online1"), "online session should appear");
    // Ghost (500) outranks Online1 (10).
    assert.ok(payload.power.findIndex((r: any) => r.name === "Ghost") < payload.power.findIndex((r: any) => r.name === "Online1"));
  });

  // Dedup: an online, signed-in player's LIVE value must replace -- not sit
  // alongside -- their own stale Mongo snapshot for the same account.
  it("refreshLeaderboard: an online logged-in player's live value suppresses their own stale Mongo doc", async () => {
    const fake = fakePlayersCollection([
      { _id: "bloxity-dup", username: "Old", power: 5, rebirth: 0, wins: 0, ownedHexPads: [0], equippedHexPad: 0, ownedAuras: [], equippedAura: null, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);

    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room, { username: "Fresh", userId: "bloxity-dup" });
    client1.send("stats", { power: 999 });
    await room.waitForNextPatch();

    const leaderboardPromise = client1.waitForMessage("leaderboard");
    await (room as any).refreshLeaderboard();
    const payload = await leaderboardPromise;

    const rowsForAccount = payload.power.filter((r: any) => r.value === 999 || r.value === 5);
    assert.strictEqual(rowsForAccount.length, 1, "exactly one row for this account, not one per source");
    assert.strictEqual(rowsForAccount[0].value, 999, "the live value wins over the stale Mongo snapshot");
  });

  // Mongo unreachable (this file's default test env -- no MONGODB_URI) must
  // still broadcast, just with online-only rows, same degrade-to-no-op
  // posture as every other Mongo path in ArenaRoom.
  it("refreshLeaderboard degrades to online-only rows when Mongo is unreachable", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    const client1 = await colyseus.connectTo(room, { username: "Solo" });
    client1.send("stats", { power: 7 });
    await room.waitForNextPatch();

    const leaderboardPromise = client1.waitForMessage("leaderboard");
    await (room as any).refreshLeaderboard();
    const payload = await leaderboardPromise;

    assert.strictEqual(payload.power.length, 1);
    assert.strictEqual(payload.power[0].name, "Solo");
    assert.strictEqual(payload.power[0].value, 7);
  });
});
