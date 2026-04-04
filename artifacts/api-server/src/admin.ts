import { Router, type IRouter, type Request, type Response } from "express";
import { getWhatsAppState } from "./whatsapp.js";

const router: IRouter = Router();

function isAuthorized(req: Request): boolean {
  const adminToken = process.env["ADMIN_TOKEN"] ?? "";
  if (!adminToken) return false; // no token configured = deny by default

  const queryToken = req.query["token"];
  if (queryToken === adminToken) return true;

  const authHeader = req.headers["authorization"] ?? "";
  if (authHeader === `Bearer ${adminToken}`) return true;

  return false;
}

router.get("/", (_req: Request, res: Response) => {
  const token = process.env["ADMIN_TOKEN"] ?? "";
  if (token) {
    res.redirect(`/api/admin?token=${encodeURIComponent(token)}`);
  } else {
    res.redirect("/api/admin");
  }
});

router.get("/admin", (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const { connected, qrDataUrl } = getWhatsAppState();

  const statusBadge = connected
    ? `<span style="background:#22c55e;color:#fff;padding:4px 14px;border-radius:20px;font-weight:600;">● Connected</span>`
    : `<span style="background:#f97316;color:#fff;padding:4px 14px;border-radius:20px;font-weight:600;">○ Waiting for QR</span>`;

  const qrSection = !connected && qrDataUrl
    ? `<div style="margin-top:24px;">
        <p style="margin-bottom:12px;color:#555;">Scan this QR code with WhatsApp on your phone:</p>
        <img src="${qrDataUrl}" alt="WhatsApp QR Code" style="border:1px solid #ddd;border-radius:8px;padding:12px;background:#fff;" />
      </div>`
    : connected
      ? `<p style="margin-top:24px;color:#555;">WhatsApp is connected and ready to receive messages.</p>`
      : `<p style="margin-top:24px;color:#888;">Generating QR code, please wait and refresh...</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="4" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Bot Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); padding: 36px 40px; max-width: 420px; width: 100%; }
    h1 { font-size: 1.25rem; font-weight: 700; color: #111; margin-bottom: 6px; }
    .subtitle { color: #888; font-size: 0.875rem; margin-bottom: 24px; }
    .status-row { display: flex; align-items: center; gap: 12px; }
    .label { font-size: 0.875rem; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WhatsApp CDK Bot</h1>
    <p class="subtitle">Admin Panel &mdash; auto-refreshes every 4 seconds</p>
    <div class="status-row">
      <span class="label">Status:</span>
      ${statusBadge}
    </div>
    ${qrSection}
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

router.get("/health", (_req: Request, res: Response) => {
  const { connected } = getWhatsAppState();
  res.json({ status: "ok", connected });
});

export default router;
