import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { logger } from "./lib/logger.js";
import { handleMessage, isDuplicate } from "./handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, "../wa-auth");

interface WhatsAppState {
  connected: boolean;
  qrDataUrl: string | null;
}

const state: WhatsAppState = { connected: false, qrDataUrl: null };
let _sock: WASocket | null = null;

export function getWhatsAppState(): WhatsAppState {
  return { ...state };
}

// Baileys logger shim: only emit info/warn/error to our pino logger
const baileysLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: (obj: unknown, msg?: string) => logger.info({ baileys: obj }, msg ?? ""),
  warn: (obj: unknown, msg?: string) => logger.warn({ baileys: obj }, msg ?? ""),
  error: (obj: unknown, msg?: string) => logger.error({ baileys: obj }, msg ?? ""),
  fatal: (obj: unknown, msg?: string) => logger.error({ baileys: obj }, msg ?? ""),
  child: () => baileysLogger,
};

async function connect(): Promise<void> {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock: WASocket = makeWASocket({
    version,
    auth: authState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: baileysLogger as any,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  _sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr);
        state.connected = false;
        logger.info("[whatsapp] QR code generated — visit /api/admin to scan");
      } catch (err) {
        logger.error({ err }, "[whatsapp] Failed to generate QR data URL");
      }
    }

    if (connection === "open") {
      state.connected = true;
      state.qrDataUrl = null;
      const id = sock.user?.id ?? "unknown";
      logger.info({ id }, "[whatsapp] Connected");
    }

    if (connection === "close") {
      state.connected = false;
      _sock = null;

      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.warn("[whatsapp] Logged out — clearing auth and restarting");
        try {
          await rm(AUTH_DIR, { recursive: true, force: true });
        } catch {
          // ignore
        }
      } else {
        logger.info({ statusCode }, "[whatsapp] Disconnected — reconnecting");
      }

      setTimeout(() => connect(), 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid ?? "";

      // Only handle direct messages
      if (!jid.endsWith("@s.whatsapp.net")) continue;

      const msgId = msg.key.id ?? "";
      if (isDuplicate(msgId)) {
        logger.debug({ msgId }, "[whatsapp] Skipping duplicate message");
        continue;
      }

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        "";

      if (!text) continue;

      logger.info({ jid, msgId }, "[whatsapp] Incoming message");

      await handleMessage(jid, text, async (reply: string) => {
        try {
          await sock.sendMessage(jid, { text: reply });
        } catch (err) {
          logger.error({ err, jid }, "[whatsapp] Failed to send reply");
        }
      });
    }
  });
}

export async function startWhatsApp(): Promise<void> {
  logger.info("[whatsapp] Starting WhatsApp connection...");
  await connect();
}

export function stopWhatsApp(): void {
  if (_sock) {
    try {
      _sock.end(undefined);
    } catch {
      // ignore
    }
    _sock = null;
  }
  state.connected = false;
}
