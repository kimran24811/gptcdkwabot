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
  listPayments,
  listCustomerBalances,
} from "./db.js";
import { waManager } from "./wa-manager.js";
import { PLAN_CODES, PLAN_LABELS, MSG_DEFAULTS } from "./handler.js";
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

  if (!token) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

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

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  try {
    const existing = await findTenantByEmail(email.toLowerCase());
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

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

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const tenant = await findTenantByEmail(email.toLowerCase());
    if (!tenant) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, tenant.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

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
    res.json({
      tenantId: tenant.id,
      email: tenant.email,
      createdAt: tenant.created_at,
      connected: botState.connected,
      phone: botState.phone,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Bot management ─────────────────────────────────────────────────────────────

router.get("/bot/status", authMiddleware, (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const state = waManager.getState(tenantId);
  res.json({
    connected: state.connected,
    qr: state.qrDataUrl,
    phone: state.phone,
  });
});

router.post("/bot/start", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  try {
    await waManager.startSession(tenantId);
    res.json({ ok: true, message: "Bot session starting. Scan the QR code." });
  } catch (err) {
    logger.error({ err, tenantId }, "[platform] Failed to start session");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/bot/stop", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  try {
    await waManager.stopSession(tenantId);
    res.json({ ok: true, message: "Bot session stopped." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Settings ───────────────────────────────────────────────────────────────────

router.get("/settings", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await getAllTenantSettings(req.tenant!.tenantId);
    // Never expose gmail password to frontend
    const safe = { ...settings, gmail_password: settings.gmail_password ? "••••••••" : "" };
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/settings", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const allowed = [
    "bot_name", "account_number", "bank_name", "account_title",
    "price_1mo_plus", "price_12mo_plus", "price_12mo_go",
    "gmail_user", "gmail_password",
  ];
  try {
    const body = req.body as Record<string, string>;
    await Promise.all(
      Object.entries(body)
        .filter(([k, v]) => allowed.includes(k) && v !== "••••••••")
        .map(([k, v]) => setTenantSetting(tenantId, k, String(v)))
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Messages ───────────────────────────────────────────────────────────────────

const MSG_KEYS = Object.keys(MSG_DEFAULTS) as Array<keyof typeof MSG_DEFAULTS>;

router.get("/messages", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await getAllTenantSettings(req.tenant!.tenantId);
    // Return current value if set, otherwise the default (so frontend always has something to display)
    const messages: Record<string, { current: string; default: string }> = {};
    for (const key of MSG_KEYS) {
      messages[key] = {
        current: settings[key] ?? "",
        default: MSG_DEFAULTS[key],
      };
    }
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/messages", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  try {
    const body = req.body as Record<string, string>;
    await Promise.all(
      Object.entries(body)
        .filter(([k]) => (MSG_KEYS as string[]).includes(k))
        .map(([k, v]) => setTenantSetting(tenantId, k, String(v)))
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, tenantId }, "[platform] Failed to save messages");
    res.status(500).json({ error: String(err) });
  }
});

// ── Keys ───────────────────────────────────────────────────────────────────────

router.get("/keys", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const plan = typeof req.query["plan"] === "string" ? req.query["plan"] : undefined;
  try {
    const [keys, stats] = await Promise.all([listKeys(tenantId, plan), getKeyStats(tenantId)]);
    res.json({ keys, stats, planLabels: PLAN_LABELS });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/keys", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { plan, keys_text } = req.body as { plan?: string; keys_text?: string };
  if (!plan || !PLAN_CODES.includes(plan as never)) {
    res.status(400).json({ error: "Invalid plan" }); return;
  }
  if (!keys_text?.trim()) {
    res.status(400).json({ error: "No keys provided" }); return;
  }
  try {
    const keysList = keys_text.split(/[\n,]+/).map((k: string) => k.trim()).filter(Boolean);
    const added = await addKeys(tenantId, plan, keysList);
    res.json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/keys/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  try {
    await deleteKey(tenantId, Number(req.params["id"]));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Payments & Customers ──────────────────────────────────────────────────────

router.get("/payments", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listPayments(req.tenant!.tenantId));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/customers", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listCustomerBalances(req.tenant!.tenantId));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
