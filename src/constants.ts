// Wall health is NOT shared between players -- each client tracks and breaks
// its own walls independently (client src/systems/wallHealth.js). The room
// has no wall state at all.

export const TARGET_IDS = ["target-a", "target-b", "target-c"];

// ArenaRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster. The query limit is comfortably larger
// than the client's FIXED_ROW_SLOTS (8, client data/leaderboardBoard.js) so
// there's still enough rows left after removing online-duplicate accounts.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
