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
import { getSetting } from "./db.js";

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

// Suppress noisy Baileys trace/debug logs by forcing the child to 'info' level,
// regardless of the global LOG_LEVEL. This prevents debug/trace noise even
// when the root logger is set to a lower level in development.
const baileysLogger = logger.child({ module: "baileys" }, { level: "info" });

async function connect(): Promise<void> {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock: WASocket = makeWASocket({
    version,
    auth: authState,
    logger: baileysLogger,
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

      // Set profile name so it shows to anyone who messages, even unsaved contacts
      try {
        const botName = (await getSetting("bot_name")) ?? "ChatGPT Bot";
        await sock.updateProfileName(botName);
        logger.info({ botName }, "[whatsapp] Profile name updated");
      } catch (err) {
        logger.warn({ err }, "[whatsapp] Could not update profile name");
      }
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
    logger.info({ type, count: messages.length }, "[whatsapp] messages.upsert received");

    // Accept both 'notify' (real-time) and 'append' (catch-up after reconnect)
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid ?? "";
      const fromMe = msg.key.fromMe ?? false;

      logger.info({ jid, fromMe, hasMsg: !!msg.message }, "[whatsapp] raw message");

      if (fromMe) continue;

      // Only handle direct messages — accept both @s.whatsapp.net and @lid (WhatsApp LID addressing)
      const isDM = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
      if (!isDM) continue;

      const msgId = msg.key.id ?? "";
      if (isDuplicate(msgId)) {
        logger.info({ msgId }, "[whatsapp] Skipping duplicate message");
        continue;
      }

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.ephemeralMessage?.message?.conversation ??
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
        "";

      if (!text) {
        logger.info({ msgId, keys: Object.keys(msg.message ?? {}) }, "[whatsapp] No text in message");
        continue;
      }

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
