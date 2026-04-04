import pg from "pg";
import { logger } from "./lib/logger.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ssl: process.env["NODE_ENV"] === "production" ? { rejectUnauthorized: false } : false,
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS key_pool (
      id SERIAL PRIMARY KEY,
      plan TEXT NOT NULL,
      key_value TEXT NOT NULL UNIQUE,
      is_used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMP,
      used_by_jid TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      jid TEXT NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      raast_last4 TEXT,
      amount TEXT,
      verified BOOLEAN DEFAULT FALSE,
      verified_at TIMESTAMP,
      plan TEXT,
      quantity INTEGER,
      keys_delivered TEXT[],
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_balances (
      jid TEXT PRIMARY KEY,
      total_spent NUMERIC(12,2) DEFAULT 0,
      total_keys INTEGER DEFAULT 0,
      last_purchase_at TIMESTAMP,
      first_purchase_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Add email_message_id column for fraud prevention (idempotent)
  await pool.query(`
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS email_message_id TEXT;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_email_message_id
    ON payments (email_message_id)
    WHERE email_message_id IS NOT NULL;
  `);

  // Non-price defaults (only insert if missing)
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('account_number', '03022000761'),
      ('bank_name', 'Nayapay'),
      ('account_title', 'Khalid Imran'),
      ('bot_name', 'ChatGPT Bot')
    ON CONFLICT (key) DO NOTHING;
  `);

  // Always apply latest price defaults
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('price_1mo_plus', '620'),
      ('price_12mo_plus', '7500'),
      ('price_12mo_go', '1400')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  `);

  logger.info("[db] Database initialized");
}

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

export async function getAvailableKeys(
  plan: string,
  quantity: number
): Promise<Array<{ id: number; key_value: string }>> {
  const { rows } = await pool.query<{ id: number; key_value: string }>(
    "SELECT id, key_value FROM key_pool WHERE plan = $1 AND is_used = FALSE ORDER BY created_at LIMIT $2",
    [plan, quantity]
  );
  return rows;
}

export async function markKeysUsed(ids: number[], jid: string): Promise<void> {
  await pool.query(
    "UPDATE key_pool SET is_used = TRUE, used_at = NOW(), used_by_jid = $2 WHERE id = ANY($1::int[])",
    [ids, jid]
  );
}

export async function addKeys(plan: string, keys: string[]): Promise<number> {
  let added = 0;
  for (const rawKey of keys) {
    const k = rawKey.trim();
    if (!k) continue;
    try {
      const result = await pool.query(
        "INSERT INTO key_pool (plan, key_value) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [plan, k]
      );
      added += result.rowCount ?? 0;
    } catch {
      // skip duplicates
    }
  }
  return added;
}

export async function deleteKey(id: number): Promise<void> {
  await pool.query("DELETE FROM key_pool WHERE id = $1 AND is_used = FALSE", [id]);
}

export async function getKeyStats(): Promise<
  Array<{ plan: string; total: number; available: number }>
> {
  const { rows } = await pool.query<{ plan: string; total: string; available: string }>(`
    SELECT plan,
      COUNT(*)::int as total,
      SUM(CASE WHEN is_used = FALSE THEN 1 ELSE 0 END)::int as available
    FROM key_pool
    GROUP BY plan
    ORDER BY plan
  `);
  return rows.map((r) => ({
    plan: r.plan,
    total: Number(r.total),
    available: Number(r.available),
  }));
}

export async function listKeys(plan?: string): Promise<
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
        "SELECT id, plan, key_value, is_used, used_at, used_by_jid, created_at FROM key_pool WHERE plan = $1 ORDER BY created_at DESC LIMIT 200",
        [plan]
      )
    : await pool.query(
        "SELECT id, plan, key_value, is_used, used_at, used_by_jid, created_at FROM key_pool ORDER BY created_at DESC LIMIT 200"
      );
  return rows;
}

export async function createPayment(jid: string, txid: string): Promise<void> {
  await pool.query(
    "INSERT INTO payments (jid, txid) VALUES ($1, $2) ON CONFLICT (txid) DO NOTHING",
    [jid, txid]
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

/**
 * Atomically claims an email message ID for a payment.
 * Returns true if claimed successfully, false if that email was already used.
 */
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

export async function updateCustomerBalance(jid: string, amount: number, keys: number): Promise<void> {
  await pool.query(
    `INSERT INTO customer_balances (jid, total_spent, total_keys, last_purchase_at, first_purchase_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (jid) DO UPDATE
     SET total_spent = customer_balances.total_spent + $2,
         total_keys  = customer_balances.total_keys + $3,
         last_purchase_at = NOW()`,
    [jid, amount, keys]
  );
}

export async function listCustomerBalances(): Promise<
  Array<{
    jid: string;
    total_spent: string;
    total_keys: number;
    last_purchase_at: string | null;
    first_purchase_at: string | null;
  }>
> {
  const { rows } = await pool.query(
    "SELECT jid, total_spent, total_keys, last_purchase_at, first_purchase_at FROM customer_balances ORDER BY total_spent DESC LIMIT 500"
  );
  return rows;
}

export async function listPayments(): Promise<
  Array<{
    id: number;
    jid: string;
    txid: string;
    raast_last4: string | null;
    verified: boolean;
    plan: string | null;
    quantity: number | null;
    created_at: string;
  }>
> {
  const { rows } = await pool.query(
    "SELECT id, jid, txid, raast_last4, verified, plan, quantity, created_at FROM payments ORDER BY created_at DESC LIMIT 100"
  );
  return rows;
}

export default pool;
