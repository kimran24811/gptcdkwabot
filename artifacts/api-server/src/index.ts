import app from "./app";
import { logger } from "./lib/logger";
import { waManager } from "./wa-manager.js";
import { initDb, getAllTenants } from "./db.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  initDb()
    .then(async () => {
      logger.info("[startup] DB ready — reconnecting tenant WhatsApp sessions");
      const tenants = await getAllTenants();
      await waManager.initAllSessions(tenants.map((t) => t.id));
      logger.info({ count: tenants.length }, "[startup] Session init complete");
    })
    .catch((err) => {
      logger.error({ err }, "Startup failed");
      process.exit(1);
    });
});

function shutdown() {
  logger.info("Shutting down...");
  waManager.stopAll().catch(() => {});
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
