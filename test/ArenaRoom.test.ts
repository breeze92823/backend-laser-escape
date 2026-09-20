import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { ArenaState } from "../src/rooms/schema/ArenaState.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

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
});
