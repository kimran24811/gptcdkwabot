import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  createTenant,
  findTenantByEmail,
  getTenantById,
  getAllTenantSettings,
  setTenantSetting,
  listKeys,
  addKeys,
  deleteKey,
  getKeyStats,
  listOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
} from "./db.js";
import { waManager } from "./wa-manager.js";
import { deliverKeys } from "./handler.js";
import { logger } from "./lib/logger.js";

const router: IRouter = Router();

const JWT_SECRET = process.env["JWT_SECRET"] ?? "whatsapp-bot-platform-secret-key-change-me";

interface AuthPayload {
  tenantId: number;
  email: string;
}

interface AuthRequest extends Request {
  tenant?: AuthPayload;
}

function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query["token"] as string ?? "");
  if (!token) { res.status(401).json({ error: "Authorization required" }); return; }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.tenant = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────────

router.post("/register", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) { res.status(400).json({ error: "Email and password are required" }); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: "Invalid email address" }); return; }
  if (password.length < 8) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }
  try {
    const existing = await findTenantByEmail(email.toLowerCase());
    if (existing) { res.status(409).json({ error: "An account with this email already exists" }); return; }
    const passwordHash = await bcrypt.hash(password, 12);
    const tenantId = await createTenant(email.toLowerCase(), passwordHash);
    const token = jwt.sign({ tenantId, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, tenantId, email: email.toLowerCase() });
  } catch (err) {
    logger.error({ err }, "[platform] Register error");
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) { res.status(400).json({ error: "Email and password are required" }); return; }
  try {
    const tenant = await findTenantByEmail(email.toLowerCase());
    if (!tenant) { res.status(401).json({ error: "Invalid email or password" }); return; }
    const valid = await bcrypt.compare(password, tenant.password_hash);
    if (!valid) { res.status(401).json({ error: "Invalid email or password" }); return; }
    const token = jwt.sign({ tenantId: tenant.id, email: tenant.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, tenantId: tenant.id, email: tenant.email });
  } catch (err) {
    logger.error({ err }, "[platform] Login error");
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const tenant = await getTenantById(req.tenant!.tenantId);
    if (!tenant) { res.status(404).json({ error: "Account not found" }); return; }
    const botState = waManager.getState(req.tenant!.tenantId);
    res.json({ tenantId: tenant.id, email: tenant.email, createdAt: tenant.created_at, connected: botState.connected, phone: botState.phone });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Bot management ─────────────────────────────────────────────────────────────

router.get("/bot/status", authMiddleware, (req: AuthRequest, res: Response) => {
  const state = waManager.getState(req.tenant!.tenantId);
  res.json({ connected: state.connected, qr: state.qrDataUrl, phone: state.phone });
});

router.post("/bot/start", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await waManager.startSession(req.tenant!.tenantId);
    res.json({ ok: true, message: "Bot session starting. Scan the QR code." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/bot/stop", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await waManager.stopSession(req.tenant!.tenantId);
    res.json({ ok: true, message: "Bot session stopped." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Settings ───────────────────────────────────────────────────────────────────

router.get("/settings", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await getAllTenantSettings(req.tenant!.tenantId);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/settings", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const allowed = ["bot_name", "binance_id", "binance_user", "bsc_address"];
  try {
    const body = req.body as Record<string, string>;
    await Promise.all(
      Object.entries(body)
        .filter(([k]) => allowed.includes(k))
        .map(([k, v]) => setTenantSetting(tenantId, k, String(v)))
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Keys ───────────────────────────────────────────────────────────────────────

router.get("/keys", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  try {
    const [keys, stats] = await Promise.all([listKeys(tenantId), getKeyStats(tenantId)]);
    res.json({ keys, stats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/keys", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { keys_text } = req.body as { keys_text?: string };
  if (!keys_text?.trim()) { res.status(400).json({ error: "No keys provided" }); return; }
  try {
    const keysList = keys_text.split(/[\n,]+/).map((k: string) => k.trim()).filter(Boolean);
    const added = await addKeys(tenantId, "chatgpt_plus", keysList);
    res.json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/keys/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await deleteKey(req.tenant!.tenantId, Number(req.params["id"]));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Orders ─────────────────────────────────────────────────────────────────────

router.get("/orders", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  try {
    res.json(await listOrders(tenantId, status));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/orders/:id/confirm", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const orderId = Number(req.params["id"]);
  try {
    const order = await getOrderById(tenantId, orderId);
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    if (order.status !== "pending") { res.status(400).json({ error: `Order is already ${order.status}` }); return; }

    const sendFn = async (msg: string) => {
      await waManager.sendMessage(tenantId, order.jid, msg);
    };

    const { keys, shortfall } = await deliverKeys(tenantId, order.jid, order.quantity, sendFn);

    const newStatus = shortfall === order.quantity ? "confirmed" : "delivered";
    await updateOrderStatus(tenantId, orderId, newStatus, keys.length > 0 ? keys : undefined);

    logger.info({ tenantId, orderId, keysDelivered: keys.length, shortfall }, "[platform] Order confirmed");
    res.json({ ok: true, keysDelivered: keys.length, shortfall });
  } catch (err) {
    logger.error({ err, tenantId, orderId }, "[platform] Order confirm failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/orders/:id/cancel", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const orderId = Number(req.params["id"]);
  try {
    const order = await getOrderById(tenantId, orderId);
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    if (order.status !== "pending") { res.status(400).json({ error: `Order is already ${order.status}` }); return; }
    await cancelOrder(tenantId, orderId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
