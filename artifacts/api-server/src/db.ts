import pg from "pg";
import { logger } from "./lib/logger.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ssl: process.env["NODE_ENV"] === "production" ? { rejectUnauthorized: false } : false,
});

export async function initDb(): Promise<void> {
  // ── Core platform tables ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );

    CREATE TABLE IF NOT EXISTS key_pool (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      plan TEXT NOT NULL,
      key_value TEXT NOT NULL,
      is_used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMP,
      used_by_jid TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (tenant_id, key_value)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      jid TEXT NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      raast_last4 TEXT,
      amount TEXT,
      verified BOOLEAN DEFAULT FALSE,
      verified_at TIMESTAMP,
      plan TEXT,
      quantity INTEGER,
      keys_delivered TEXT[],
      email_message_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_balances (
      tenant_id INTEGER NOT NULL DEFAULT 1,
      jid TEXT NOT NULL,
      total_spent NUMERIC(12,2) DEFAULT 0,
      total_keys INTEGER DEFAULT 0,
      last_purchase_at TIMESTAMP,
      first_purchase_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (tenant_id, jid)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_email_message_id
    ON payments (email_message_id)
    WHERE email_message_id IS NOT NULL;
  `);

  // Migrate old key_pool: add tenant_id column if missing
  await pool.query(`
    ALTER TABLE key_pool ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1;
  `).catch(() => {});
  // Add composite unique if old table existed without it
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_key_pool_tenant_key
    ON key_pool (tenant_id, key_value);
  `).catch(() => {});

  // Migrate old payments: add tenant_id column if missing
  await pool.query(`
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1;
  `).catch(() => {});

  // Legacy system settings defaults (for backward compat admin panel)
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('account_number', '03022000761'),
      ('bank_name', 'Nayapay'),
      ('account_title', 'Khalid Imran'),
      ('bot_name', 'ChatGPT Bot'),
      ('price_1mo_plus', '620'),
      ('price_12mo_plus', '7500'),
      ('price_12mo_go', '1400')
    ON CONFLICT (key) DO NOTHING;
  `);

  logger.info("[db] Database initialized");
}

// ── Tenant auth ────────────────────────────────────────────────────────────────

export async function createTenant(email: string, passwordHash: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO tenants (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, passwordHash]
  );
  const tenantId = rows[0]!.id;
  // Seed default settings
  await seedTenantSettings(tenantId);
  return tenantId;
}

export async function findTenantByEmail(email: string): Promise<{ id: number; password_hash: string; email: string } | null> {
  const { rows } = await pool.query<{ id: number; password_hash: string; email: string }>(
    "SELECT id, password_hash, email FROM tenants WHERE email = $1",
    [email]
  );
  return rows[0] ?? null;
}

export async function getTenantById(id: number): Promise<{ id: number; email: string; created_at: string } | null> {
  const { rows } = await pool.query<{ id: number; email: string; created_at: string }>(
    "SELECT id, email, created_at FROM tenants WHERE id = $1",
    [id]
  );
  return rows[0] ?? null;
}

export async function getAllTenants(): Promise<Array<{ id: number; email: string }>> {
  const { rows } = await pool.query<{ id: number; email: string }>(
    "SELECT id, email FROM tenants ORDER BY id"
  );
  return rows;
}

export async function seedFirstTenantIfEmpty(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM tenants");
  if (parseInt(rows[0]?.count ?? "0", 10) > 0) return;

  const seedEmail = process.env["SEED_EMAIL"] ?? "admin@bot.local";
  const seedPassword = process.env["ADMIN_TOKEN"] ?? process.env["SEED_PASSWORD"] ?? "changeme123";

  const bcrypt = await import("bcryptjs");
  const hash = await bcrypt.hash(seedPassword, 12);

  const { rows: inserted } = await pool.query<{ id: number }>(
    "INSERT INTO tenants (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
    [seedEmail, hash]
  );

  if (inserted.length > 0) {
    await seedTenantSettings(inserted[0]!.id);
    logger.info({ email: seedEmail, tenantId: inserted[0]!.id }, "[db] Seeded first tenant from ADMIN_TOKEN");
  }
}

async function seedTenantSettings(tenantId: number): Promise<void> {
  const defaults = [
    ["bot_name", "ChatGPT Bot"],
    ["account_number", ""],
    ["bank_name", "Nayapay"],
    ["account_title", ""],
    ["price_1mo_plus", "620"],
    ["price_12mo_plus", "7500"],
    ["price_12mo_go", "1400"],
    ["gmail_user", ""],
    ["gmail_password", ""],
    // Message templates — blank means use hardcoded defaults in handler.ts
    ["msg_welcome", ""],
    ["msg_activate_prompt", ""],
    ["msg_invalid_key", ""],
    ["msg_key_verified", ""],
    ["msg_bad_session", ""],
    ["msg_activation_ok", ""],
    ["msg_activation_fail", ""],
    ["msg_qty_prompt", ""],
    ["msg_payment_ask_title", ""],
    ["msg_payment_retry", ""],
    ["msg_payment_noconfig", ""],
    ["msg_keys_delivered", ""],
    ["msg_no_keys", ""],
    ["msg_duplicate_email", ""],
  ];
  for (const [key, value] of defaults) {
    await pool.query(
      "INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [tenantId, key, value]
    );
  }
}

// ── Tenant settings ────────────────────────────────────────────────────────────

export async function getTenantSetting(tenantId: number, key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = $2",
    [tenantId, key]
  );
  return rows[0]?.value ?? null;
}

export async function setTenantSetting(tenantId: number, key: string, value: string): Promise<void> {
  await pool.query(
    "INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3",
    [tenantId, key, value]
  );
}

export async function getAllTenantSettings(tenantId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    "SELECT key, value FROM tenant_settings WHERE tenant_id = $1",
    [tenantId]
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ── Keys ───────────────────────────────────────────────────────────────────────

export async function getAvailableKeys(
  tenantId: number,
  plan: string,
  quantity: number
): Promise<Array<{ id: number; key_value: string }>> {
  const { rows } = await pool.query<{ id: number; key_value: string }>(
    "SELECT id, key_value FROM key_pool WHERE tenant_id = $1 AND plan = $2 AND is_used = FALSE ORDER BY created_at LIMIT $3",
    [tenantId, plan, quantity]
  );
  return rows;
}

export async function markKeysUsed(tenantId: number, ids: number[], jid: string): Promise<void> {
  await pool.query(
    "UPDATE key_pool SET is_used = TRUE, used_at = NOW(), used_by_jid = $3 WHERE id = ANY($1::int[]) AND tenant_id = $2",
    [ids, tenantId, jid]
  );
}

export async function addKeys(tenantId: number, plan: string, keys: string[]): Promise<number> {
  let added = 0;
  for (const rawKey of keys) {
    const k = rawKey.trim();
    if (!k) continue;
    try {
      const result = await pool.query(
        "INSERT INTO key_pool (tenant_id, plan, key_value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [tenantId, plan, k]
      );
      added += result.rowCount ?? 0;
    } catch { /* skip duplicates */ }
  }
  return added;
}

export async function deleteKey(tenantId: number, id: number): Promise<void> {
  await pool.query(
    "DELETE FROM key_pool WHERE id = $1 AND tenant_id = $2 AND is_used = FALSE",
    [id, tenantId]
  );
}

export async function getKeyStats(tenantId: number): Promise<
  Array<{ plan: string; total: number; available: number }>
> {
  const { rows } = await pool.query<{ plan: string; total: string; available: string }>(`
    SELECT plan,
      COUNT(*)::int AS total,
      SUM(CASE WHEN is_used = FALSE THEN 1 ELSE 0 END)::int AS available
    FROM key_pool
    WHERE tenant_id = $1
    GROUP BY plan
    ORDER BY plan
  `, [tenantId]);
  return rows.map((r) => ({
    plan: r.plan,
    total: Number(r.total),
    available: Number(r.available),
  }));
}

export async function listKeys(tenantId: number, plan?: string): Promise<
  Array<{
    id: number;
    plan: string;
    key_value: string;
    is_used: boolean;
    used_at: string | null;
    used_by_jid: string | null;
    created_at: string;
  }>
> {
  const { rows } = plan
    ? await pool.query(
        "SELECT id, plan, key_value, is_used, used_at, used_by_jid, created_at FROM key_pool WHERE tenant_id = $1 AND plan = $2 ORDER BY created_at DESC LIMIT 200",
        [tenantId, plan]
      )
    : await pool.query(
        "SELECT id, plan, key_value, is_used, used_at, used_by_jid, created_at FROM key_pool WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200",
        [tenantId]
      );
  return rows;
}

// ── Payments ───────────────────────────────────────────────────────────────────

export async function createPayment(tenantId: number, jid: string, txid: string): Promise<void> {
  await pool.query(
    "INSERT INTO payments (tenant_id, jid, txid) VALUES ($1, $2, $3) ON CONFLICT (txid) DO NOTHING",
    [tenantId, jid, txid]
  );
}

export async function updatePaymentDetails(txid: string, acctLast4: string, amount: string): Promise<void> {
  await pool.query(
    "UPDATE payments SET raast_last4 = $2, amount = $3 WHERE txid = $1",
    [txid, acctLast4, amount]
  );
}

export async function verifyPayment(
  txid: string,
  plan: string,
  quantity: number,
  keys: string[]
): Promise<void> {
  await pool.query(
    "UPDATE payments SET verified = TRUE, verified_at = NOW(), plan = $2, quantity = $3, keys_delivered = $4 WHERE txid = $1",
    [txid, plan, quantity, keys]
  );
}

export async function claimEmailMessageId(txid: string, messageId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE payments SET email_message_id = $2
     WHERE txid = $1
       AND NOT EXISTS (
         SELECT 1 FROM payments p2 WHERE p2.email_message_id = $2
       )`,
    [txid, messageId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateCustomerBalance(
  tenantId: number,
  jid: string,
  amount: number,
  keys: number
): Promise<void> {
  await pool.query(
    `INSERT INTO customer_balances (tenant_id, jid, total_spent, total_keys, last_purchase_at, first_purchase_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (tenant_id, jid) DO UPDATE
     SET total_spent = customer_balances.total_spent + $3,
         total_keys  = customer_balances.total_keys + $4,
         last_purchase_at = NOW()`,
    [tenantId, jid, amount, keys]
  );
}

export async function listCustomerBalances(tenantId: number): Promise<
  Array<{
    jid: string;
    total_spent: string;
    total_keys: number;
    last_purchase_at: string | null;
    first_purchase_at: string | null;
  }>
> {
  const { rows } = await pool.query(
    "SELECT jid, total_spent, total_keys, last_purchase_at, first_purchase_at FROM customer_balances WHERE tenant_id = $1 ORDER BY total_spent DESC LIMIT 500",
    [tenantId]
  );
  return rows;
}

export async function listPayments(tenantId: number): Promise<
  Array<{
    id: number;
    jid: string;
    txid: string;
    raast_last4: string | null;
    amount: string | null;
    verified: boolean;
    plan: string | null;
    quantity: number | null;
    created_at: string;
  }>
> {
  const { rows } = await pool.query(
    "SELECT id, jid, txid, raast_last4, amount, verified, plan, quantity, created_at FROM payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100",
    [tenantId]
  );
  return rows;
}

// ── Legacy single-tenant helpers (admin panel compat) ─────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    [key, value]
  );
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    "SELECT key, value FROM settings"
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export default pool;
