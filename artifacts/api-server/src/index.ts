import app from "./app";
import { logger } from "./lib/logger";
import { startWhatsApp, stopWhatsApp } from "./whatsapp.js";
import { initDb } from "./db.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
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

  // Init database then start WhatsApp
  initDb()
    .then(() => startWhatsApp())
    .catch((err) => {
      logger.error({ err }, "Startup failed");
      process.exit(1);
    });
});

function shutdown() {
  logger.info("Shutting down...");
  stopWhatsApp();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  // Force-exit after 10s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
