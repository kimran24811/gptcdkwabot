import { checkKey, activateKey } from "./cdk.js";
import { verifyPaymentByEmail } from "./gmail.js";
import {
  getSetting,
  getAvailableKeys,
  markKeysUsed,
  createPayment,
  updatePaymentDetails,
  verifyPayment,
  updateCustomerBalance,
  claimEmailMessageId,
} from "./db.js";
import { logger } from "./lib/logger.js";
import { randomUUID } from "crypto";

type Stage =
  | "idle"
  | "activate_awaiting_key"
  | "activate_awaiting_session"
  | "purchase_select_plan"
  | "purchase_awaiting_qty"
  | "purchase_awaiting_amount"
  | "purchase_awaiting_title";

export const PLAN_CODES = ["1mo_plus", "12mo_plus", "12mo_go"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const PLAN_LABELS: Record<PlanCode, string> = {
  "1mo_plus": "1 Month Plus Plan",
  "12mo_plus": "12 Month Plus Plan",
  "12mo_go": "12 Month Go Plan",
};

const PLAN_DEFAULT_PRICES: Record<PlanCode, string> = {
  "1mo_plus": "620",
  "12mo_plus": "7500",
  "12mo_go": "1400",
};

const NUM_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

interface UserState {
  stage: Stage;
  cdkKey?: string;
  internalRef?: string;
  selectedPlan?: PlanCode;
  expectedQty?: number;
  expectedTotal?: number;
  lastActivity: number;
}

const userStates = new Map<string, UserState>();
const processedIds = new Set<string>();
const processedIdQueue: string[] = [];
const MAX_PROCESSED_IDS = 500;

const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const STATE_EXPIRY_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [jid, st] of userStates.entries()) {
    if (now - st.lastActivity > STATE_EXPIRY_MS) userStates.delete(jid);
  }
}, 5 * 60 * 1000);

export function isDuplicate(msgId: string): boolean {
  if (processedIds.has(msgId)) return true;
  processedIds.add(msgId);
  processedIdQueue.push(msgId);
  if (processedIdQueue.length > MAX_PROCESSED_IDS) {
    const old = processedIdQueue.shift()!;
    processedIds.delete(old);
  }
  return false;
}

function isRateLimited(jid: string): boolean {
  const now = Date.now();
  const ts = (rateLimitMap.get(jid) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (ts.length >= RATE_LIMIT) { rateLimitMap.set(jid, ts); return true; }
  ts.push(now);
  rateLimitMap.set(jid, ts);
  return false;
}

function isCdkKeyFormat(text: string): boolean {
  return text.length >= 6 && /^[a-zA-Z0-9\-_]+$/.test(text);
}

function isSessionToken(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const p = JSON.parse(t) as Record<string, unknown>;
    return (
      typeof p["accessToken"] === "string" ||
      (typeof p["user"] === "object" && p["user"] !== null)
    );
  } catch { return false; }
}

function discountRate(qty: number): number {
  if (qty >= 30) return 0.15;
  if (qty >= 20) return 0.08;
  if (qty >= 10) return 0.05;
  return 0;
}

function fmt(n: number): string {
  return n.toLocaleString("en-PK");
}

function numEmoji(i: number): string {
  return NUM_EMOJI[i] ?? `${i + 1}.`;
}

async function getPlanMenuMsg(): Promise<string> {
  const prices = await Promise.all(
    PLAN_CODES.map((c) => getSetting(`price_${c}`).then((v) => v ?? PLAN_DEFAULT_PRICES[c]))
  );
  return `🛒 *Select a Plan:*

1️⃣ 1 Month Plus — Rs. ${parseInt(prices[0]).toLocaleString("en-PK")}/key
2️⃣ 12 Month Plus — Rs. ${parseInt(prices[1]).toLocaleString("en-PK")}/key
3️⃣ 12 Month Go — Rs. ${parseInt(prices[2]).toLocaleString("en-PK")}/key

📦 *Bulk Discounts (all plans):*
🔹 10–19 keys → 5% off
🔹 20–29 keys → 8% off
🔹 30–50 keys → 15% off

Reply with *1*, *2*, or *3*`;
}

async function calcOrder(plan: PlanCode, qty: number): Promise<{
  basePrice: number;
  discountPct: number;
  discountAmt: number;
  total: number;
}> {
  const priceStr = (await getSetting(`price_${plan}`)) ?? PLAN_DEFAULT_PRICES[plan];
  const basePrice = parseInt(priceStr, 10);
  const rate = discountRate(qty);
  const discountAmt = Math.round(basePrice * qty * rate);
  const total = basePrice * qty - discountAmt;
  return { basePrice, discountPct: Math.round(rate * 100), discountAmt, total };
}

async function getOrderMsg(plan: PlanCode, qty: number): Promise<{ msg: string; total: number }> {
  const account = (await getSetting("account_number")) ?? "03022000761";
  const bank = (await getSetting("bank_name")) ?? "Nayapay";
  const { basePrice, discountPct, discountAmt, total } = await calcOrder(plan, qty);
  const label = PLAN_LABELS[plan];

  let priceLines: string;
  if (discountPct > 0) {
    priceLines =
      `Rs. ${fmt(basePrice)} × ${qty} = Rs. ${fmt(basePrice * qty)}\n` +
      `🏷️ Discount: ${discountPct}% = -Rs. ${fmt(discountAmt)}\n` +
      `💵 *Total: Rs. ${fmt(total)}*`;
  } else {
    priceLines = `💵 Rs. ${fmt(basePrice)} × ${qty} = *Rs. ${fmt(total)}*`;
  }

  const msg =
    `🧾 *Order Summary*\n` +
    `📦 ${label} × ${qty} key${qty > 1 ? "s" : ""}\n` +
    `💰 ${priceLines}\n\n` +
    `📲 Please send *Rs. ${fmt(total)}* to:\n` +
    `🏦 Bank: ${bank}\n` +
    `📱 Account: *${account}*\n\n` +
    `💬 After payment, reply with the *amount* you paid (numbers only).`;

  return { msg, total };
}

const MAIN_MENU = `👋 *Welcome to ChatGPT Bot!*

What would you like to do?

1️⃣ Activate existing key
2️⃣ Purchase a new key

Reply with *1* or *2*`;

function keyVerifiedMsg(plan?: string): string {
  return `✅ Key verified!${plan ? ` _(${plan})_` : ""}

🔐 Now I need your ChatGPT *session token* to activate your account.

📋 How to get it:
1️⃣ Open a browser and go to:
   chat.openai.com/api/auth/session
2️⃣ You'll see a JSON page starting with {"user":...
3️⃣ Select *ALL* the text and send it here

⚠️ This is a long JSON string, NOT your CDK key.`;
}

export async function handleMessage(
  jid: string,
  text: string,
  sendReply: (msg: string) => Promise<void>
): Promise<void> {
  if (isRateLimited(jid)) {
    logger.warn({ jid }, "[handler] rate limited");
    return;
  }

  const now = Date.now();
  let state: UserState = userStates.get(jid) ?? { stage: "idle", lastActivity: now };
  state.lastActivity = now;

  const trimmed = text.trim();
  const lc = trimmed.toLowerCase();

  // Global reset triggers — including * for menu
  if (["*", "menu", "start", "hi", "hello", "/start"].includes(lc)) {
    state = { stage: "idle", lastActivity: now };
    userStates.set(jid, state);
    await sendReply(MAIN_MENU);
    return;
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────
  if (state.stage === "idle") {
    if (trimmed === "1") {
      state.stage = "activate_awaiting_key";
      userStates.set(jid, state);
      await sendReply("🔑 Please send your CDK activation key.");
      return;
    }
    if (trimmed === "2") {
      state.stage = "purchase_select_plan";
      userStates.set(jid, state);
      await sendReply(await getPlanMenuMsg());
      return;
    }
    await sendReply(MAIN_MENU);
    userStates.set(jid, state);
    return;
  }

  // ── ACTIVATE: awaiting CDK key ────────────────────────────────────────────
  if (state.stage === "activate_awaiting_key") {
    if (!isCdkKeyFormat(trimmed)) {
      await sendReply("❌ That doesn't look like a valid CDK key. Please send your key (letters and numbers only).\n\nType * for the main menu.");
      return;
    }
    const result = await checkKey(trimmed);
    if (result.status === "available") {
      state.stage = "activate_awaiting_session";
      state.cdkKey = trimmed;
      userStates.set(jid, state);
      await sendReply(keyVerifiedMsg(result.subscription ?? result.product));
    } else if (result.status === "used") {
      await sendReply("❌ This key has already been activated.\n\nType * for the main menu.");
    } else if (result.status === "expired") {
      await sendReply("❌ This key has expired.\n\nType * for the main menu.");
    } else if (result.status === "invalid") {
      await sendReply("❌ Invalid key. Please check and try again.");
    } else {
      await sendReply("⚠️ Could not verify the key right now. Please try again in a moment.");
    }
    return;
  }

  // ── ACTIVATE: awaiting session token ─────────────────────────────────────
  if (state.stage === "activate_awaiting_session") {
    if (isCdkKeyFormat(trimmed) && !isSessionToken(trimmed)) {
      const result = await checkKey(trimmed);
      if (result.status === "available") {
        state.cdkKey = trimmed;
        userStates.set(jid, state);
        await sendReply(keyVerifiedMsg(result.subscription ?? result.product));
      } else {
        await sendReply("❌ Invalid key. Please send the session token JSON or a valid CDK key.");
      }
      return;
    }
    if (!isSessionToken(trimmed)) {
      await sendReply(keyVerifiedMsg());
      return;
    }
    await sendReply("⏳ Activating your account, please wait...");
    const activation = await activateKey(state.cdkKey!, trimmed);
    if (activation.success) {
      userStates.delete(jid);
      await sendReply(
        `🎉 *Activation Successful!*\n📧 Account: ${activation.email ?? "N/A"}\n📦 Plan: ${activation.subscription ?? activation.product ?? "N/A"}\n\nEnjoy your subscription! 🚀\n\nType * for the main menu.`
      );
    } else {
      userStates.set(jid, state);
      await sendReply(
        `❌ Activation failed: ${activation.errorMessage ?? "Unknown error"}\n\nMake sure you copied the complete JSON from chat.openai.com/api/auth/session and try again, or send a new CDK key.`
      );
    }
    return;
  }

  // ── PURCHASE: select plan ─────────────────────────────────────────────────
  if (state.stage === "purchase_select_plan") {
    const planByChoice: Record<string, PlanCode> = {
      "1": "1mo_plus",
      "2": "12mo_plus",
      "3": "12mo_go",
    };
    const plan = planByChoice[trimmed];
    if (!plan) {
      await sendReply(`⚠️ Please reply with *1*, *2*, or *3*:\n\n${await getPlanMenuMsg()}`);
      return;
    }
    state.selectedPlan = plan;
    state.stage = "purchase_awaiting_qty";
    userStates.set(jid, state);
    await sendReply(`✅ *${PLAN_LABELS[plan]}* selected! 🎯\n\n🔢 How many keys do you need? _(1–50)_`);
    return;
  }

  // ── PURCHASE: awaiting quantity ───────────────────────────────────────────
  if (state.stage === "purchase_awaiting_qty") {
    const qty = parseInt(trimmed, 10);
    if (isNaN(qty) || qty < 1 || qty > 50) {
      await sendReply("⚠️ Please enter a number between *1* and *50*.");
      return;
    }
    const { msg, total } = await getOrderMsg(state.selectedPlan!, qty);
    state.expectedQty = qty;
    state.expectedTotal = total;
    state.internalRef = randomUUID();
    state.stage = "purchase_awaiting_amount";
    userStates.set(jid, state);
    await createPayment(jid, state.internalRef).catch(() => {});
    await sendReply(msg);
    return;
  }

  // ── PURCHASE: awaiting amount ─────────────────────────────────────────────
  if (state.stage === "purchase_awaiting_amount") {
    const amountClean = trimmed.replace(/[^0-9]/g, "");
    const paid = parseInt(amountClean, 10);
    if (!amountClean || isNaN(paid) || paid <= 0) {
      await sendReply("⚠️ Please enter the amount you paid (numbers only).\n\nExample: *620*");
      return;
    }
    if (paid !== state.expectedTotal) {
      await sendReply(
        `⚠️ Amount doesn't match your order.\n\n💵 Your total is *Rs. ${fmt(state.expectedTotal!)}*.\n\nPlease send exactly Rs. ${fmt(state.expectedTotal!)} and reply with that amount.`
      );
      return;
    }
    state.stage = "purchase_awaiting_title";
    userStates.set(jid, state);
    await sendReply(
      `✅ Amount: Rs. *${fmt(paid)}*\n\n👤 Now please send your *NayaPay account title* (the name on your account).\n\nExample: *Muhammad Ali*`
    );
    return;
  }

  // ── PURCHASE: awaiting account title ─────────────────────────────────────
  if (state.stage === "purchase_awaiting_title") {
    if (trimmed.length < 2) {
      await sendReply("⚠️ Please enter your NayaPay account title (the name on your account).");
      return;
    }
    await updatePaymentDetails(state.internalRef!, trimmed, String(state.expectedTotal ?? "")).catch(() => {});
    await sendReply("⏳ Verifying your payment, please wait...");

    const result = await verifyPaymentByEmail(trimmed, String(state.expectedTotal ?? ""));

    if (!result.verified) {
      const gmailConfigured = !!(process.env["GMAIL_USER"] && process.env["GMAIL_APP_PASSWORD"]);
      if (!gmailConfigured) {
        logger.warn({ jid }, "[handler] Gmail not configured — skipping auto-verify");
        state.stage = "purchase_awaiting_title";
        userStates.set(jid, state);
        await sendReply("⚠️ Automatic verification is not available right now. Please contact support.\n\nType * for the main menu.");
      } else {
        await sendReply(
          `❌ Could not verify your payment.\n\nPlease double-check:\n• 💵 Amount paid: *Rs. ${fmt(state.expectedTotal!)}*\n• 👤 Your exact NayaPay account title\n\nResend your account title to try again, or type * for the main menu.`
        );
        state.stage = "purchase_awaiting_title";
        userStates.set(jid, state);
      }
      return;
    }

    // ── Fraud check: claim this email — prevents reuse ────────────────────
    if (result.messageId) {
      const claimed = await claimEmailMessageId(state.internalRef!, result.messageId);
      if (!claimed) {
        logger.warn({ jid, messageId: result.messageId }, "[handler] Duplicate email claim rejected");
        await sendReply(
          `❌ This payment has already been used for a previous order.\n\nIf you believe this is an error, please contact support.\n\nType * for the main menu.`
        );
        state = { stage: "idle", lastActivity: now };
        userStates.set(jid, state);
        return;
      }
    }

    // Payment verified and claimed — deliver keys
    logger.info({ jid, plan: state.selectedPlan, qty: state.expectedQty, total: state.expectedTotal }, "[handler] Payment verified and claimed");

    const keys = await getAvailableKeys(state.selectedPlan!, state.expectedQty!);
    if (keys.length === 0) {
      await sendReply("😔 Sorry, no keys are currently available for this plan. Please contact support.\n\nType * for the main menu.");
      state = { stage: "idle", lastActivity: now };
      userStates.set(jid, state);
      return;
    }
    if (keys.length < state.expectedQty!) {
      await sendReply(`⚠️ Only ${keys.length} key${keys.length > 1 ? "s" : ""} available for this plan. Sending what we have!`);
    }

    await markKeysUsed(keys.map((k) => k.id), jid);
    await verifyPayment(
      state.internalRef!,
      state.selectedPlan!,
      keys.length,
      keys.map((k) => k.key_value)
    ).catch(() => {});
    await updateCustomerBalance(jid, state.expectedTotal!, keys.length).catch(() => {});

    const planLabel = PLAN_LABELS[state.selectedPlan!];
    const keyList = keys.map((k, i) => `${numEmoji(i)} *${k.key_value}*`).join("\n");

    userStates.delete(jid);
    await sendReply(
      `🎉 *Here ${keys.length === 1 ? "is your" : "are your"} ${planLabel} key${keys.length > 1 ? "s" : ""}:* 🔑\n\n` +
      `${keyList}\n\n` +
      `💰 Total paid: Rs. ${fmt(state.expectedTotal!)}\n\n` +
      `Thank you for your purchase! 🙏\n` +
      `Type * for the main menu.`
    );
    return;
  }

  // Fallback
  await sendReply(MAIN_MENU);
  userStates.set(jid, { stage: "idle", lastActivity: now });
}
