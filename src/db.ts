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
