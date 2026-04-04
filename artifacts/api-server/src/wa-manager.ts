import { rm, access } from "node:fs/promises";
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
import { getTenantSetting } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_BASE = path.resolve(__dirname, "../wa-auth");

interface SessionState {
  connected: boolean;
  qrDataUrl: string | null;
  phone: string | null;
}

class WAManager {
  private sockets = new Map<number, WASocket>();
  private states = new Map<number, SessionState>();

  getState(tenantId: number): SessionState {
    return this.states.get(tenantId) ?? { connected: false, qrDataUrl: null, phone: null };
  }

  isConnected(tenantId: number): boolean {
    return this.states.get(tenantId)?.connected ?? false;
  }

  getQR(tenantId: number): string | null {
    return this.states.get(tenantId)?.qrDataUrl ?? null;
  }

  getPhone(tenantId: number): string | null {
    return this.states.get(tenantId)?.phone ?? null;
  }

  getAllConnected(): number[] {
    const connected: number[] = [];
    for (const [id, s] of this.states.entries()) {
      if (s.connected) connected.push(id);
    }
    return connected;
  }

  async startSession(tenantId: number): Promise<void> {
    await this.stopSession(tenantId);

    const authDir = path.join(AUTH_BASE, String(tenantId));
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const baileysLogger = logger.child({ module: "baileys", tenantId }, { level: "warn" });

    const sock: WASocket = makeWASocket({
      version,
      auth: authState,
      logger: baileysLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
    });

    this.sockets.set(tenantId, sock);
    this.states.set(tenantId, { connected: false, qrDataUrl: null, phone: null });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          this.states.set(tenantId, { connected: false, qrDataUrl, phone: null });
          logger.info({ tenantId }, "[wa-manager] QR code generated");
        } catch (err) {
          logger.error({ err, tenantId }, "[wa-manager] Failed to generate QR");
        }
      }

      if (connection === "open") {
        const phone = sock.user?.id ?? null;
        this.states.set(tenantId, { connected: true, qrDataUrl: null, phone });
        logger.info({ tenantId, phone }, "[wa-manager] Connected");

        try {
          const botName = (await getTenantSetting(tenantId, "bot_name")) ?? "ChatGPT Bot";
          await sock.updateProfileName(botName);
          logger.info({ tenantId, botName }, "[wa-manager] Profile name set");
        } catch (err) {
          logger.warn({ err, tenantId }, "[wa-manager] Could not set profile name");
        }
      }

      if (connection === "close") {
        const prev = this.states.get(tenantId);
        this.states.set(tenantId, { connected: false, qrDataUrl: null, phone: prev?.phone ?? null });
        this.sockets.delete(tenantId);

        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          logger.warn({ tenantId }, "[wa-manager] Logged out — clearing auth");
          try { await rm(authDir, { recursive: true, force: true }); } catch {}
          this.states.delete(tenantId);
        } else {
          logger.info({ tenantId, statusCode }, "[wa-manager] Disconnected — reconnecting in 3s");
          setTimeout(() => this.startSession(tenantId).catch(() => {}), 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        const jid = msg.key.remoteJid ?? "";
        if (msg.key.fromMe) continue;

        const isDM = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
        if (!isDM) continue;

        const msgId = msg.key.id ?? "";
        if (isDuplicate(tenantId, msgId)) continue;

        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.ephemeralMessage?.message?.conversation ??
          msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
          "";

        if (!text) continue;

        logger.info({ tenantId, jid, msgId }, "[wa-manager] Incoming message");

        await handleMessage(tenantId, jid, text, async (reply) => {
          try {
            await sock.sendMessage(jid, { text: reply });
          } catch (err) {
            logger.error({ err, jid, tenantId }, "[wa-manager] Failed to send reply");
          }
        });
      }
    });
  }

  async stopSession(tenantId: number): Promise<void> {
    const sock = this.sockets.get(tenantId);
    if (sock) {
      try { sock.end(undefined); } catch {}
      this.sockets.delete(tenantId);
    }
    this.states.delete(tenantId);
  }

  async stopAll(): Promise<void> {
    for (const tenantId of this.sockets.keys()) {
      await this.stopSession(tenantId);
    }
  }

  /** On startup: reconnect all tenants that have auth data stored on disk */
  async initAllSessions(tenantIds: number[]): Promise<void> {
    for (const tenantId of tenantIds) {
      const authDir = path.join(AUTH_BASE, String(tenantId));
      const hasAuth = await access(authDir).then(() => true).catch(() => false);
      if (hasAuth) {
        logger.info({ tenantId }, "[wa-manager] Reconnecting tenant session");
        await this.startSession(tenantId).catch((err) =>
          logger.error({ err, tenantId }, "[wa-manager] Failed to start session on startup")
        );
      }
    }
  }
}

export const waManager = new WAManager();
