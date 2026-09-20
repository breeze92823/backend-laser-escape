/**
 * IMPORTANT:
 * ---------
 * Do not manually edit this file if you'd like to host your server on Colyseus Cloud
 *
 * If you're self-hosting, you can see "Raw usage" from the documentation.
 *
 * See: https://docs.colyseus.io/server
 */
import { listen } from "@colyseus/tools";

// Import Colyseus config
import app from "./app.config.js";
import { connectDb } from "./db.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players, but a slow/absent Mongo must never delay serving the game --
// connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Create and listen on 2567 (or PORT environment variable.)
listen(app);
