import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated
// database with scoped credentials, no provisioning (see
// https://hosting.bloxity.io/docs). A local `npm start` normally has no Mongo
// reachable at all, so a missing/unreachable URI must degrade this to "no
// persistence" rather than crash the room -- same stance every external
// dependency in this codebase already takes (client systems/bloxity.js §5.6,
// systems/net.js: a slow/absent service leaves the game fully playable).
export interface PlayerDoc {
  _id: string; // Bloxity user id (SDK.auth.getUser()._id) -- see ArenaRoom.ts
  // Display name as of the last save -- an older doc predating this field
  // simply lacks it; every reader falls back to "Player" (same convention
  // client systems/net.js already uses for a stat packet with no name yet).
  // Needed so an offline (not-currently-connected) leaderboard row still has
  // something to show -- ArenaRoom.ts's PlayerState.username only exists for
  // currently-connected sessions.
  username?: string;
  power: number;
  rebirth: number;
  wins: number;
  ownedHexPads: number[];
  equippedHexPad: number;
  ownedAuras: number[];
  equippedAura: number | null;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this
    // game+channel's own isolated database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // ArenaRoom.ts's refreshLeaderboard() sorts this collection by each of
    // these fields to build the all-time top-N lists -- without an index
    // that's a full collection scan per stat, per refresh. createIndex is
    // idempotent, so running this on every boot is safe. A failure here must
    // not block startup -- same degrade-to-no-op posture as everything else
    // in this file, it just means those queries stay unindexed (slower, not
    // broken).
    try {
      await players.createIndex({ power: -1 });
      await players.createIndex({ rebirth: -1 });
      await players.createIndex({ wins: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as
// "skip persistence for this request", never throw.
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: lets test/ArenaRoom.test.ts exercise refreshLeaderboard()'s
// merge/dedupe logic against a hand-rolled fake collection (find/sort/limit/
// toArray + updateOne/findOne over an in-memory array) without standing up a
// real MongoDB -- this repo has no other Mongo running in CI/local test runs.
// Never call this outside a test file.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
