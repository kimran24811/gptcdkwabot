import {
  getTenantSetting,
  getAvailableKeys,
  markKeysUsed,
  createOrder,
} from "./db.js";
import { logger } from "./lib/logger.js";

type Stage = "idle" | "awaiting_qty" | "awaiting_txid";

interface UserState {
  stage: Stage;
  quantity?: number;
  pricePerKey?: number;
  totalUsd?: number;
  lastActivity: number;
}

const userStates = new Map<string, UserState>();

const processedIds = new Set<string>();
const processedIdQueue: string[] = [];
const MAX_PROCESSED_IDS = 2000;

const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const STATE_EXPIRY_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, st] of userStates.entries()) {
    if (now - st.lastActivity > STATE_EXPIRY_MS) userStates.delete(k);
  }
}, 5 * 60 * 1000);

export function isDuplicate(tenantId: number, msgId: string): boolean {
  const key = `${tenantId}:${msgId}`;
  if (processedIds.has(key)) return true;
  processedIds.add(key);
  processedIdQueue.push(key);
  if (processedIdQueue.length > MAX_PROCESSED_IDS) {
    processedIds.delete(processedIdQueue.shift()!);
  }
  return false;
}

function isRateLimited(tenantId: number, jid: string): boolean {
  const key = `${tenantId}:${jid}`;
  const now = Date.now();
  const ts = (rateLimitMap.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (ts.length >= RATE_LIMIT) { rateLimitMap.set(key, ts); return true; }
  ts.push(now);
  rateLimitMap.set(key, ts);
  return false;
}

// ── Pricing tiers (USD per key) ───────────────────────────────────────────────

export function getPricePerKey(qty: number): number {
  if (qty >= 100) return 1.55;
  if (qty >= 50)  return 1.75;
  if (qty >= 30)  return 1.95;
  if (qty >= 10)  return 2.15;
  return 2.38;
}

function pricingTable(): string {
  return (
    `💰 *Pricing (ChatGPT Plus CDK):*\n` +
    `• 1–9 keys   → $2.38/key\n` +
    `• 10–29 keys → $2.15/key\n` +
    `• 30–49 keys → $1.95/key\n` +
    `• 50–99 keys → $1.75/key\n` +
    `• 100+ keys  → $1.55/key`
  );
}

async function getPaymentDetails(tenantId: number): Promise<string> {
  const id   = (await getTenantSetting(tenantId, "binance_id"))   ?? "552780449";
  const user = (await getTenantSetting(tenantId, "binance_user")) ?? "User-1d9f7";
  const bsc  = (await getTenantSetting(tenantId, "bsc_address"))  ?? "0x0c31c91ec2cbb607aeca28c1bc09c55352db2fea";
  return (
    `💳 *Pay via Binance:*\n` +
    `👤 ID: *${id}* (${user})\n` +
    `🔗 BSC: \`${bsc}\``
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleMessage(
  tenantId: number,
  jid: string,
  text: string,
  sendReply: (msg: string) => Promise<void>
): Promise<void> {
  if (isRateLimited(tenantId, jid)) {
    logger.warn({ tenantId, jid }, "[handler] rate limited");
    return;
  }

  const now = Date.now();
  const stateKey = `${tenantId}:${jid}`;
  let state: UserState = userStates.get(stateKey) ?? { stage: "idle", lastActivity: now };
  state.lastActivity = now;

  const trimmed = text.trim();
  const lc = trimmed.toLowerCase();

  // Reset / main menu
  if (["*", "menu", "start", "hi", "hello", "/start", "hello!", "hey"].includes(lc)) {
    state = { stage: "idle", lastActivity: now };
    userStates.set(stateKey, state);
    await sendReply(
      `👋 *Welcome! We sell ChatGPT Plus CDK keys.*\n\n` +
      `${pricingTable()}\n\n` +
      `📦 How many keys do you need? _(reply with a number)_`
    );
    return;
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────

  if (state.stage === "idle") {
    const qty = parseInt(trimmed, 10);
    if (!isNaN(qty) && qty >= 1 && qty <= 500 && String(qty) === trimmed) {
      const price = getPricePerKey(qty);
      const total = parseFloat((qty * price).toFixed(2));
      state.stage = "awaiting_txid";
      state.quantity = qty;
      state.pricePerKey = price;
      state.totalUsd = total;
      userStates.set(stateKey, state);

      const payDetails = await getPaymentDetails(tenantId);
      await sendReply(
        `🧾 *Order Summary*\n` +
        `${qty} key${qty > 1 ? "s" : ""} × $${price.toFixed(2)} = *$${total.toFixed(2)}*\n\n` +
        `${payDetails}\n\n` +
        `✅ After payment, send your *Binance transaction ID* here.`
      );
      return;
    }
    await sendReply(
      `👋 *Welcome! We sell ChatGPT Plus CDK keys.*\n\n` +
      `${pricingTable()}\n\n` +
      `📦 How many keys do you need? _(reply with a number)_`
    );
    userStates.set(stateKey, state);
    return;
  }

  // ── AWAITING TX ID ────────────────────────────────────────────────────────

  if (state.stage === "awaiting_txid") {
    // Allow customer to change quantity at this step
    const newQty = parseInt(trimmed, 10);
    if (!isNaN(newQty) && newQty >= 1 && newQty <= 500 && String(newQty) === trimmed) {
      const price = getPricePerKey(newQty);
      const total = parseFloat((newQty * price).toFixed(2));
      state.quantity = newQty;
      state.pricePerKey = price;
      state.totalUsd = total;
      userStates.set(stateKey, state);
      const payDetails = await getPaymentDetails(tenantId);
      await sendReply(
        `🧾 *Updated Order Summary*\n` +
        `${newQty} key${newQty > 1 ? "s" : ""} × $${price.toFixed(2)} = *$${total.toFixed(2)}*\n\n` +
        `${payDetails}\n\n` +
        `✅ After payment, send your *Binance transaction ID* here.`
      );
      return;
    }

    if (trimmed.length < 5) {
      await sendReply("⚠️ Please send your Binance transaction ID (the TX hash from your payment).");
      return;
    }

    const qty = state.quantity!;
    const total = state.totalUsd!;
    const txId = trimmed;

    const orderId = await createOrder(tenantId, jid, qty, state.pricePerKey!, total, txId);
    state = { stage: "idle", lastActivity: now };
    userStates.set(stateKey, state);

    logger.info({ tenantId, jid, orderId, qty, total, txId }, "[handler] order created");

    await sendReply(
      `✅ *Order Received!*\n\n` +
      `📋 Order #${orderId}\n` +
      `🔢 ${qty} key${qty > 1 ? "s" : ""} — *$${total.toFixed(2)}*\n` +
      `🔖 TX: \`${txId}\`\n\n` +
      `⏳ We'll verify your payment and send your keys shortly.\n` +
      `Type * to order more.`
    );
    return;
  }

  // Fallback
  await sendReply(
    `👋 *Welcome! We sell ChatGPT Plus CDK keys.*\n\n` +
    `${pricingTable()}\n\n` +
    `📦 How many keys do you need? _(reply with a number)_`
  );
  state = { stage: "idle", lastActivity: now };
  userStates.set(stateKey, state);
}

// ── Deliver keys (called from platform confirm endpoint) ──────────────────────

export async function deliverKeys(
  tenantId: number,
  jid: string,
  quantity: number,
  sendMessage: (msg: string) => Promise<void>
): Promise<{ keys: string[]; shortfall: number }> {
  const available = await getAvailableKeys(tenantId, "chatgpt_plus", quantity);

  if (available.length === 0) {
    await sendMessage(
      `⚠️ *Payment confirmed but no keys are available right now.*\n\n` +
      `You will receive your keys as soon as stock is restocked. We apologise for the delay.`
    );
    return { keys: [], shortfall: quantity };
  }

  const toSend = available.slice(0, quantity);
  await markKeysUsed(tenantId, toSend.map((k) => k.id), jid);

  const keyLines = toSend.map((k, i) => `${i + 1}. \`${k.key_value}\``).join("\n");
  const shortfall = quantity - toSend.length;

  await sendMessage(
    `🎉 *Your ChatGPT Plus CDK key${toSend.length > 1 ? "s" : ""}:*\n\n` +
    `${keyLines}\n\n` +
    (shortfall > 0 ? `⚠️ ${shortfall} key${shortfall > 1 ? "s" : ""} still pending — will be sent soon.\n\n` : "") +
    `Thank you for your purchase! 🙏\nType * to order more.`
  );

  return { keys: toSend.map((k) => k.key_value), shortfall };
}
