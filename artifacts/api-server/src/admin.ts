import { Router, type IRouter, type Request, type Response } from "express";
import { getWhatsAppState } from "./whatsapp.js";
import {
  getAllSettings,
  setSetting,
  listKeys,
  addKeys,
  deleteKey,
  getKeyStats,
  listPayments,
} from "./db.js";
import { PLAN_LABELS, PLAN_CODES } from "./handler.js";

const router: IRouter = Router();

function isAuthorized(req: Request): boolean {
  const adminToken = process.env["ADMIN_TOKEN"] ?? "";
  if (!adminToken) return false;
  const q = req.query["token"];
  if (q === adminToken) return true;
  const auth = req.headers["authorization"] ?? "";
  if (auth === `Bearer ${adminToken}`) return true;
  return false;
}

function authMiddleware(req: Request, res: Response, next: () => void): void {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

// ── Root redirect ─────────────────────────────────────────────────────────────
router.get("/", (_req: Request, res: Response) => {
  const token = process.env["ADMIN_TOKEN"] ?? "";
  res.redirect(token ? `/api/admin?token=${encodeURIComponent(token)}` : "/api/admin");
});

// ── JSON API routes ───────────────────────────────────────────────────────────

router.get("/admin/settings", (req, res) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  getAllSettings().then((s) => res.json(s)).catch((e) => res.status(500).json({ error: String(e) }));
});

router.post("/admin/settings", (req, res) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, string>;
  const allowed = ["account_number", "bank_name", "account_title", "price_1mo_plus", "price_12mo_plus", "price_12mo_go"];
  Promise.all(
    Object.entries(body)
      .filter(([k]) => allowed.includes(k))
      .map(([k, v]) => setSetting(k, String(v)))
  )
    .then(() => res.json({ ok: true }))
    .catch((e) => res.status(500).json({ error: String(e) }));
});

router.get("/admin/keys", (req, res) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const plan = typeof req.query["plan"] === "string" ? req.query["plan"] : undefined;
  Promise.all([listKeys(plan), getKeyStats()])
    .then(([keys, stats]) => res.json({ keys, stats }))
    .catch((e) => res.status(500).json({ error: String(e) }));
});

router.post("/admin/keys", (req, res) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { plan, keys_text } = req.body as { plan: string; keys_text: string };
  if (!plan || !PLAN_CODES.includes(plan as never)) {
    res.status(400).json({ error: "Invalid plan" }); return;
  }
  if (!keys_text?.trim()) { res.status(400).json({ error: "No keys provided" }); return; }
  const keysList = keys_text.split(/[\n,]+/).map((k: string) => k.trim()).filter(Boolean);
  addKeys(plan, keysList)
    .then((added) => res.json({ ok: true, added }))
    .catch((e) => res.status(500).json({ error: String(e) }));
});

router.delete("/admin/keys/:id", (req, res) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  deleteKey(Number(req.params["id"]))
    .then(() => res.json({ ok: true }))
    .catch((e) => res.status(500).json({ error: String(e) }));
});

router.get("/admin/payments", (req, res) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  listPayments()
    .then((payments) => res.json(payments))
    .catch((e) => res.status(500).json({ error: String(e) }));
});

// ── Health ────────────────────────────────────────────────────────────────────
router.get("/health", (_req: Request, res: Response) => {
  const { connected } = getWhatsAppState();
  res.json({ status: "ok", connected });
});

// ── Admin HTML page ───────────────────────────────────────────────────────────
router.get("/admin", (req: Request, res: Response) => {
  if (!isAuthorized(req)) { res.status(401).send("Unauthorized"); return; }

  const token = req.query["token"] as string ?? "";
  const { connected, qrDataUrl } = getWhatsAppState();

  const statusBadge = connected
    ? `<span class="badge green">● Connected</span>`
    : `<span class="badge orange">○ Waiting for QR</span>`;

  const qrSection = !connected && qrDataUrl
    ? `<img src="${qrDataUrl}" alt="QR" class="qr-img" />`
    : connected
      ? `<p style="color:#555;margin-top:16px;">WhatsApp is connected and ready to receive messages.</p>`
      : `<p style="color:#888;margin-top:16px;">Generating QR code, please wait...</p>`;

  const planOptions = PLAN_CODES.map(
    (c) => `<option value="${c}">${PLAN_LABELS[c]}</option>`
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Bot Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f5;min-height:100vh;padding:24px}
    h1{font-size:1.3rem;font-weight:700;color:#111}
    .subtitle{color:#888;font-size:.85rem;margin-bottom:20px}
    .tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid #e5e7eb;padding-bottom:0}
    .tab{padding:10px 18px;cursor:pointer;border-radius:6px 6px 0 0;font-size:.9rem;font-weight:500;color:#555;border:none;background:none;margin-bottom:-2px}
    .tab.active{background:#fff;color:#111;border:2px solid #e5e7eb;border-bottom:2px solid #fff}
    .panel{display:none;background:#fff;border-radius:0 8px 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:24px}
    .panel.active{display:block}
    .badge{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:600;font-size:.85rem;color:#fff}
    .badge.green{background:#22c55e}
    .badge.orange{background:#f97316}
    .qr-img{margin-top:16px;border:1px solid #ddd;border-radius:8px;padding:10px;background:#fff;max-width:260px}
    .form-row{margin-bottom:14px}
    label{display:block;font-size:.85rem;font-weight:500;color:#444;margin-bottom:4px}
    input,select,textarea{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;outline:none}
    input:focus,select:focus,textarea:focus{border-color:#6366f1}
    textarea{resize:vertical;min-height:100px;font-family:monospace}
    .btn{padding:9px 20px;border:none;border-radius:6px;cursor:pointer;font-size:.9rem;font-weight:600}
    .btn-primary{background:#6366f1;color:#fff}
    .btn-danger{background:#ef4444;color:#fff;padding:4px 10px;font-size:.8rem}
    .btn:hover{opacity:.88}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th{background:#f9fafb;padding:8px 12px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb}
    td{padding:7px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle}
    tr:hover td{background:#fafafa}
    .tag{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.78rem;font-weight:600}
    .tag-green{background:#dcfce7;color:#166534}
    .tag-red{background:#fee2e2;color:#991b1b}
    .tag-blue{background:#dbeafe;color:#1d4ed8}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px}
    .stat-card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px}
    .stat-label{font-size:.78rem;color:#888;margin-bottom:4px}
    .stat-val{font-size:1.4rem;font-weight:700;color:#111}
    .stat-sub{font-size:.78rem;color:#6366f1}
    .filter-row{display:flex;gap:10px;margin-bottom:14px;align-items:center}
    .filter-row select{width:auto}
    .notice{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 14px;font-size:.85rem;color:#92400e;margin-bottom:16px}
    #toast{position:fixed;bottom:24px;right:24px;background:#333;color:#fff;padding:10px 20px;border-radius:8px;font-size:.9rem;display:none;z-index:999}
  </style>
</head>
<body>
<h1>WhatsApp CDK Bot</h1>
<p class="subtitle">Admin Panel</p>

<div class="tabs">
  <button class="tab active" onclick="showTab('status')">📶 Status</button>
  <button class="tab" onclick="showTab('settings')">⚙️ Settings</button>
  <button class="tab" onclick="showTab('keys')">🔑 Key Pool</button>
  <button class="tab" onclick="showTab('payments')">💳 Payments</button>
</div>

<!-- STATUS TAB -->
<div id="tab-status" class="panel active">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
    <span style="font-size:.9rem;color:#555">WhatsApp Status:</span>
    ${statusBadge}
  </div>
  ${qrSection}
</div>

<!-- SETTINGS TAB -->
<div id="tab-settings" class="panel">
  <p class="notice">These are the payment details shown to customers when they choose to purchase a key.</p>
  <form id="settings-form">
    <div class="form-row"><label>Bank Name</label><input name="bank_name" /></div>
    <div class="form-row"><label>Account Title</label><input name="account_title" /></div>
    <div class="form-row"><label>Account Number</label><input name="account_number" /></div>
    <hr style="margin:16px 0;border-color:#f3f4f6" />
    <p style="font-size:.85rem;font-weight:600;color:#555;margin-bottom:12px">Plan Prices (PKR)</p>
    <div class="form-row"><label>1 Month Plus Plan</label><input name="price_1mo_plus" type="number" /></div>
    <div class="form-row"><label>12 Month Plus Plan</label><input name="price_12mo_plus" type="number" /></div>
    <div class="form-row"><label>12 Month Go Plan</label><input name="price_12mo_go" type="number" /></div>
    <button class="btn btn-primary" type="submit">Save Settings</button>
  </form>
</div>

<!-- KEYS TAB -->
<div id="tab-keys" class="panel">
  <div id="key-stats" class="stats-grid"></div>

  <h3 style="font-size:.95rem;margin-bottom:12px">Add Keys</h3>
  <form id="add-keys-form" style="margin-bottom:24px">
    <div class="form-row">
      <label>Plan</label>
      <select name="plan">${planOptions}</select>
    </div>
    <div class="form-row">
      <label>Keys (one per line or comma-separated)</label>
      <textarea name="keys_text" placeholder="KEY1&#10;KEY2&#10;KEY3"></textarea>
    </div>
    <button class="btn btn-primary" type="submit">Add Keys</button>
  </form>

  <h3 style="font-size:.95rem;margin-bottom:10px">Key Inventory</h3>
  <div class="filter-row">
    <label style="margin:0;color:#555;font-size:.85rem">Filter:</label>
    <select id="key-filter" onchange="loadKeys()">
      <option value="">All Plans</option>
      ${planOptions}
    </select>
  </div>
  <div id="keys-table"></div>
</div>

<!-- PAYMENTS TAB -->
<div id="tab-payments" class="panel">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <span style="font-size:.9rem;color:#555">Last 100 payments</span>
    <button class="btn btn-primary" onclick="loadPayments()" style="padding:6px 14px;font-size:.82rem">↻ Refresh</button>
  </div>
  <div id="payments-table"></div>
</div>

<div id="toast"></div>

<script>
const TOKEN = ${JSON.stringify(token)};
const API = (path) => path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['status','settings','keys','payments'][i] === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'settings') loadSettings();
  if (name === 'keys') { loadKeyStats(); loadKeys(); }
  if (name === 'payments') loadPayments();
}

function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = ok ? '#166534' : '#991b1b';
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

async function loadSettings() {
  const r = await fetch(API('/api/admin/settings'));
  const s = await r.json();
  const form = document.getElementById('settings-form');
  Object.entries(s).forEach(([k,v]) => {
    const el = form.querySelector('[name="'+k+'"]');
    if (el) el.value = v;
  });
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const r = await fetch(API('/api/admin/settings'), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const j = await r.json();
  toast(j.ok ? '✅ Settings saved' : '❌ ' + j.error, j.ok);
});

async function loadKeyStats() {
  const r = await fetch(API('/api/admin/keys'));
  const { stats } = await r.json();
  const planLabels = ${JSON.stringify(PLAN_LABELS)};
  const el = document.getElementById('key-stats');
  if (!stats.length) { el.innerHTML = '<p style="color:#888;font-size:.85rem">No keys added yet.</p>'; return; }
  el.innerHTML = stats.map(s => \`
    <div class="stat-card">
      <div class="stat-label">\${planLabels[s.plan] ?? s.plan}</div>
      <div class="stat-val">\${s.available}</div>
      <div class="stat-sub">of \${s.total} available</div>
    </div>
  \`).join('');
}

async function loadKeys() {
  const plan = document.getElementById('key-filter').value;
  const r = await fetch(API('/api/admin/keys' + (plan ? '?plan=' + plan : '')));
  const { keys } = await r.json();
  const planLabels = ${JSON.stringify(PLAN_LABELS)};
  const el = document.getElementById('keys-table');
  if (!keys.length) { el.innerHTML = '<p style="color:#888;font-size:.85rem;margin-top:8px">No keys found.</p>'; return; }
  el.innerHTML = '<table><thead><tr><th>Plan</th><th>Key</th><th>Status</th><th>Used By</th><th>Added</th><th></th></tr></thead><tbody>' +
    keys.map(k => \`<tr>
      <td><span class="tag tag-blue">\${planLabels[k.plan] ?? k.plan}</span></td>
      <td style="font-family:monospace;font-size:.82rem">\${k.key_value}</td>
      <td>\${k.is_used ? '<span class="tag tag-red">Used</span>' : '<span class="tag tag-green">Available</span>'}</td>
      <td style="font-size:.8rem;color:#888">\${k.used_by_jid ? k.used_by_jid.replace('@s.whatsapp.net','').replace('@lid','') : '—'}</td>
      <td style="font-size:.8rem;color:#888">\${new Date(k.created_at).toLocaleDateString()}</td>
      <td>\${!k.is_used ? \`<button class="btn btn-danger" onclick="deleteKey(\${k.id})">Delete</button>\` : ''}</td>
    </tr>\`).join('') + '</tbody></table>';
}

document.getElementById('add-keys-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const r = await fetch(API('/api/admin/keys'), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const j = await r.json();
  if (j.ok) {
    toast('✅ Added ' + j.added + ' key(s)');
    e.target.querySelector('[name="keys_text"]').value = '';
    loadKeyStats(); loadKeys();
  } else toast('❌ ' + j.error, false);
});

async function deleteKey(id) {
  if (!confirm('Delete this key?')) return;
  const r = await fetch(API('/api/admin/keys/' + id), { method:'DELETE' });
  const j = await r.json();
  toast(j.ok ? '✅ Key deleted' : '❌ ' + j.error, j.ok);
  if (j.ok) { loadKeyStats(); loadKeys(); }
}

async function loadPayments() {
  const r = await fetch(API('/api/admin/payments'));
  const payments = await r.json();
  const planLabels = ${JSON.stringify(PLAN_LABELS)};
  const el = document.getElementById('payments-table');
  if (!payments.length) { el.innerHTML = '<p style="color:#888;font-size:.85rem">No payments yet.</p>'; return; }
  el.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>JID</th><th>TxID</th><th>Raast Last4</th><th>Status</th><th>Plan</th><th>Qty</th></tr></thead><tbody>' +
    payments.map(p => \`<tr>
      <td style="font-size:.8rem;white-space:nowrap">\${new Date(p.created_at).toLocaleString()}</td>
      <td style="font-size:.8rem">\${p.jid.replace('@s.whatsapp.net','').replace('@lid','')}</td>
      <td style="font-family:monospace;font-size:.78rem">\${p.txid}</td>
      <td style="text-align:center">\${p.raast_last4 ?? '—'}</td>
      <td>\${p.verified ? '<span class="tag tag-green">Verified</span>' : '<span class="tag tag-red">Pending</span>'}</td>
      <td style="font-size:.82rem">\${p.plan ? (planLabels[p.plan] ?? p.plan) : '—'}</td>
      <td style="text-align:center">\${p.quantity ?? '—'}</td>
    </tr>\`).join('') + '</tbody></table></div>';
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

export default router;
