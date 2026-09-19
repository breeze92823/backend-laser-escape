import { Room, Client, CloseCode } from "colyseus";
import { ArenaState, PlayerState } from "./schema/ArenaState.js";
import { TARGET_IDS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";

// Cap on the JSON avatar blob (see ArenaState.ts PlayerState.avatar). A full
// equipped set + 7 proportions serialises to a few hundred bytes; 4 KB is
// generous headroom and still bounds a misbehaving client.
const AVATAR_MAX_LEN = 4096;

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

// Generous cap on an owned-tier list (client data/hexPowerPad.js /
// data/aura.js each ship well under this many tiers today).
const OWNED_LIST_MAX = 64;

// Same client-trusted model as every other message here (move/username/
// avatar/stats) -- no server-side game-logic validation. What IS enforced:
// shape and bounds, so a malformed/hostile payload can never corrupt this
// player's own Mongo document. A forged number can only ever affect the
// sender's own save, never another player's -- there is no cross-player
// read here, unlike `playerDamage`.
function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<PlayerDoc> = {};

  for (const key of ["power", "rebirth", "wins"] as const) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.max(0, v);
  }
  for (const key of ["ownedHexPads", "ownedAuras"] as const) {
    const v = src[key];
    if (Array.isArray(v)) {
      out[key] = v
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .slice(0, OWNED_LIST_MAX);
    }
  }
  if (typeof src.equippedHexPad === "number" && Number.isFinite(src.equippedHexPad)) {
    out.equippedHexPad = src.equippedHexPad;
  }
  if (src.equippedAura === null || (typeof src.equippedAura === "number" && Number.isFinite(src.equippedAura))) {
    out.equippedAura = src.equippedAura as number | null;
  }
  return out;
}

/**
 * Single global room every client joins via `client.joinOrCreate("arena")`.
 * No server-side hit validation -- clients report events (as they already do
 * locally), this room just relays/stores them so other clients see them too.
 */
export class ArenaRoom extends Room<{ state: ArenaState }> {
  state = new ArenaState();

  // sessionId -> Bloxity user id, for whichever connected clients are signed
  // in. Deliberately NOT part of ArenaState: unlike username/avatar this has
  // no reason to be broadcast to other players, it only gates this room's own
  // Mongo reads/writes for the owning connection.
  userIds = new Map<string, string>();

  messages = {
    // Throttled client-side -- not sent every physics frame.
    move: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = msg.x;
      p.y = msg.y;
      p.z = msg.z;
      p.yaw = msg.yaw;
      p.speed = msg.speed;
      p.firing = !!msg.firing;
      p.beamToX = msg.beamToX;
      p.beamToY = msg.beamToY;
      p.beamToZ = msg.beamToZ;
    },
    // The player's Bloxity avatar (equipped cosmetics + proportions) as a JSON
    // string. Sent once on connect and again whenever the portal reports the
    // avatar changed -- a human-speed event, not a per-frame one. Stored as-is
    // so every other client can build the real character; never parsed here.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const avatar = sanitizeAvatar(msg?.avatar);
      if (avatar) p.avatar = avatar;
    },
    // The player's own live stats (client store/useGameStore.js power/
    // rebirth/wins), so an in-world leaderboard (client components/
    // LeaderboardBoard.jsx) can rank currently-connected players. Sent
    // debounced on change (client systems/net.js scheduleStatsResend), not
    // per frame -- same "human-speed event" cadence as setAvatar above. No
    // validation beyond finite/non-negative, same trust model as every other
    // message here.
    stats: (client: Client, msg: { power?: number; rebirth?: number; wins?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.power === "number" && Number.isFinite(msg.power)) {
        p.power = Math.max(0, msg.power);
      }
      if (typeof msg?.rebirth === "number" && Number.isFinite(msg.rebirth)) {
        p.rebirth = Math.max(0, msg.rebirth);
      }
      if (typeof msg?.wins === "number" && Number.isFinite(msg.wins)) {
        p.wins = Math.max(0, msg.wins);
      }
    },
    targetHit: (client: Client, msg: { targetId: string }) => {
      if (!TARGET_IDS.includes(msg.targetId)) return;
      this.state.targetsHit.set(msg.targetId, true);
    },
    // A client reporting a PVP hit it landed on another player (client
    // src/systems/playerCombat.js strikeTarget()) -- client-trusted, same as
    // `move`/`username`. No self-damage, and a dead target stays dead until
    // its own client sends playerRespawn.
    playerDamage: (client: Client, msg: { targetId: string; hp: number }) => {
      if (!msg || msg.targetId === client.sessionId) return;
      const target = this.state.players.get(msg.targetId);
      if (!target || target.dead) return;
      if (typeof msg.hp !== "number" || !Number.isFinite(msg.hp)) return;
      target.hp = Math.max(0, Math.min(msg.hp, target.maxHp));
      if (target.hp === 0) target.dead = true;
    },
    // The dead player's own client, once its local respawn timer elapses
    // (client src/systems/playerHealth.js). Restores this one player to full
    // hp and clears `dead`.
    playerRespawn: (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.hp = p.maxHp;
      p.dead = false;
    },
    // Client systems/net.js's debounced push of the durable half of
    // store/useGameStore.js (power/rebirth/wins/owned+equipped hex pads and
    // auras) -- a human-speed event, same cadence family as `stats`/
    // `setAvatar`. Only a signed-in client has a userId (see onJoin); a
    // guest's progress has nowhere durable to live and this simply no-ops.
    // Upserts, so a brand-new player's first save creates their document.
    saveProgress: async (client: Client, msg: unknown) => {
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const patch = sanitizeProgress(msg);
      if (!patch) return;
      try {
        await players.updateOne(
          { _id: userId },
          { $set: { ...patch, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[ArenaRoom] saveProgress failed", err);
      }
    },
  };

  onJoin(client: Client, options?: { username?: string; avatar?: string; userId?: string }) {
    // No spawn assignment -- the client already hardcodes spawnPosition
    // and reports its real position in its first "move" message.
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    // Seed the avatar from the join options too, so a client that joins is
    // rendered as the right character even before its first `setAvatar`.
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);

    // Bloxity user id (client systems/bloxity.js getStableUserId(), same
    // `_id` shape already used for a friend entry) -- client-trusted, same
    // model as username/avatar above. A forged id can only ever read/overwrite
    // the SENDER's own save (there is no cross-player read in `saveProgress`),
    // so this carries no more risk than every other client-trusted field this
    // room already relays.
    const userId = typeof options?.userId === "string" ? options.userId.slice(0, 128) : "";
    if (userId) {
      this.userIds.set(client.sessionId, userId);
      this.loadProgress(client, userId, p);
    }
  }

  // Seeds this player's own leaderboard row immediately (rather than waiting
  // on their next `stats` packet) and sends the full saved doc back to just
  // this client, so client systems/net.js can hydrate the fields ArenaState
  // doesn't carry (owned/equipped hex pads and auras -- nobody else needs to
  // see those). A missing doc (brand-new player) or unreachable Mongo both
  // just leave the client on its own defaults.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    if (!players) return;
    try {
      const doc = await players.findOne({ _id: userId });
      if (!doc) return;
      p.power = doc.power ?? 0;
      p.rebirth = doc.rebirth ?? 0;
      p.wins = doc.wins ?? 0;
      client.send("progress", {
        power: doc.power ?? 0,
        rebirth: doc.rebirth ?? 0,
        wins: doc.wins ?? 0,
        ownedHexPads: doc.ownedHexPads ?? [0],
        equippedHexPad: doc.equippedHexPad ?? 0,
        ownedAuras: doc.ownedAuras ?? [],
        equippedAura: doc.equippedAura ?? null,
      });
    } catch (err) {
      console.warn("[ArenaRoom] loadProgress failed", err);
    }
  }

  // A deliberate `room.leave()` (client teardown()) closes with CONSENTED --
  // drop that player immediately, same as before. Anything else (WiFi blip,
  // backgrounded tab, mobile network switch) is exactly what the CLIENT's own
  // net.js already assumes rides out via "@colyseus/sdk's built-in Room
  // reconnection" (its own header comment) -- but that reconnection can only
  // succeed if THIS room still recognises the old session when the client
  // comes back. Without allowReconnection, every abnormal drop looked
  // consented to the room: the PlayerState was deleted on the spot, so a
  // client reconnecting moments later re-joined as a brand new player while
  // its OWN local remotePlayers bookkeeping (and everyone else's) still held
  // stale references to the old sessionId for a few seconds -- exactly the
  // kind of "some clients show a player, some don't" asymmetry that timing-
  // dependent double-bookkeeping produces. 20s matches the client's own
  // RETRY_BACKOFF_MS ceiling (data/net.js).
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.state.players.delete(client.sessionId);
      this.userIds.delete(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, 20);
      // Reconnected within the window -- same sessionId, PlayerState (and
      // userIds entry) untouched.
    } catch {
      this.state.players.delete(client.sessionId);
      this.userIds.delete(client.sessionId);
    }
  }
}
