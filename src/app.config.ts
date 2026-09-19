import cors from "cors";
import {
  defineServer,
  defineRoom,
  monitor,
  playground,
} from "colyseus";

/**
 * Import your Room files
 */
import { ArenaRoom } from "./rooms/ArenaRoom.js";

const server = defineServer({

  /**
   * Define your room handlers:
   */
  rooms: {
    arena: defineRoom(ArenaRoom),
  },

  /**
   * Bind your custom express routes here:
   * Read more: https://expressjs.com/en/starter/basic-routing.html
   */
  express: (app) => {

    // Readiness/liveness probe required by Bloxity Legion.
    app.get("/health", (_req, res) => {
      res.sendStatus(200);
    });

    // Bloxity injects CLIENT_ORIGIN in deployed environments; wildcard
    // remains for local dev where the var isn't set.
    app.use(cors({
      origin: process.env.CLIENT_ORIGIN || "*",
    }));

    /**
     * Use @colyseus/monitor
     * If you expose it in production, make sure to protect it with a password:
     * https://docs.colyseus.io/tools/monitoring#password-protection
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     * (It is not recommended to expose this route in a production environment)
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }
  }
});

export default server;

