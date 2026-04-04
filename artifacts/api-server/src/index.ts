import app from "./app";
import { logger } from "./lib/logger";
import { startWhatsApp, stopWhatsApp } from "./whatsapp.js";

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

  // Start WhatsApp bot after server is up
  startWhatsApp().catch((err) => {
    logger.error({ err }, "[whatsapp] Failed to start");
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
