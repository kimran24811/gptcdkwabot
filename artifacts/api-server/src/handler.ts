import { checkKey, activateKey } from "./cdk.js";
import { verifyPaymentByEmail } from "./gmail.js";
import {
  getTenantSetting,
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
    const old = processedIdQueue.shift()!;
    processedIds.delete(old);
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

function isCdkKeyFormat(text: string): boolean {
  return text.length >= 6 && /^[a-zA-Z0-9\-_]+$/.test(text);
}

function isSessionToken(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  // Try strict JSON parse first
  try {
    const p = JSON.parse(t) as Record<string, unknown>;
    if (typeof p["accessToken"] === "string") return true;
    if (typeof p["user"] === "object" && p["user"] !== null) return true;
  } catch { /* may be truncated — fall through to pattern match */ }
  // Fallback: pattern match for key fields that appear early in the JSON
  // (handles WhatsApp truncating very long messages)
  return (
    t.includes('"accessToken"') ||
    (t.includes('"user"') && t.includes('"email"') && t.includes('"idp"'))
  );
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

// ── Message template helpers ──────────────────────────────────────────────────

async function getMsg(
  tenantId: number,
  key: string,
  fallback: string,
  vars?: Record<string, string>
): Promise<string> {
  try {
    const stored = await getTenantSetting(tenantId, key);
    let msg = (stored && stored.trim()) ? stored.trim() : fallback;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        msg = msg.split(`{{${k}}}`).join(v);
      }
    }
    return msg;
  } catch {
    return fallback;
  }
}

// ── Default message strings (used as fallbacks) ───────────────────────────────

export const MSG_DEFAULTS = {
  msg_welcome: `👋 *Welcome to ChatGPT Bot!*

What would you like to do?

1️⃣ Activate existing key
2️⃣ Purchase a new key

Reply with *1* or *2*`,

  msg_activate_prompt: `🔑 Please send your CDK activation key.`,

  msg_invalid_key: `❌ That doesn't look like a valid CDK key. Please send your key.

Type * for the main menu.`,

  msg_key_verified: `✅ Key verified!{{plan_info}}

🔐 Now I need your ChatGPT *session token* to activate your account.

📋 How to get it:
1️⃣ Open a browser and go to:
   chat.openai.com/api/auth/session
2️⃣ You'll see a JSON page starting with {"user":...
3️⃣ Select *ALL* the text and send it here

⚠️ This is a long JSON string, NOT your CDK key.`,

  msg_bad_session: `⚠️ That doesn't look like a session token. Please send the full JSON from chat.openai.com/api/auth/session`,

  msg_activation_ok: `🎉 *Activation Successful!*
📧 Account: {{email}}
📦 Plan: {{plan}}

Enjoy your subscription! 🚀

Type * for the main menu.`,

  msg_activation_fail: `❌ Activation failed: {{error}}

Make sure you copied the complete JSON from chat.openai.com/api/auth/session and try again.`,

  msg_qty_prompt: `✅ *{{plan_label}}* selected! 🎯

🔢 How many keys do you need? _(1–50)_`,

  msg_payment_ask_title: `✅ Amount: Rs. *{{amount}}*

👤 Now please send your *NayaPay account title* (the name on your account).

Example: *Muhammad Ali*`,

  msg_payment_retry: `❌ Could not verify your payment yet.

NayaPay emails sometimes take 1–2 minutes to arrive. Please wait a moment, then:

👤 *Resend your NayaPay account title* to try again.

Or type * to return to the main menu.`,

  msg_payment_noconfig: `⚠️ Payment verification is temporarily unavailable.

Please send your NayaPay account title again in a minute to retry, or type * for the main menu.`,

  msg_keys_delivered: `🎉 *Here {{are_is}} your {{plan_label}} key{{plural}}:* 🔑

{{keys_list}}

💰 Total paid: Rs. {{total}}

Thank you for your purchase! 🙏
Type * for the main menu.`,

  msg_no_keys: `😔 Sorry, no keys are available right now. Please contact support.

Type * for the main menu.`,

  msg_duplicate_email: `❌ This payment has already been used for a previous order.

If you believe this is an error, please contact support.

Type * for the main menu.`,
};

// ── Auto-generated messages (built from dynamic pricing/calc) ─────────────────

async function getPlanMenuMsg(tenantId: number): Promise<string> {
  const prices = await Promise.all(
    PLAN_CODES.map((c) =>
      getTenantSetting(tenantId, `price_${c}`).then((v) => v ?? PLAN_DEFAULT_PRICES[c])
    )
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

async function calcOrder(tenantId: number, plan: PlanCode, qty: number): Promise<{
  basePrice: number;
  discountPct: number;
  discountAmt: number;
  total: number;
}> {
  const priceStr = (await getTenantSetting(tenantId, `price_${plan}`)) ?? PLAN_DEFAULT_PRICES[plan];
  const basePrice = parseInt(priceStr, 10);
  const rate = discountRate(qty);
  const discountAmt = Math.round(basePrice * qty * rate);
  const total = basePrice * qty - discountAmt;
  return { basePrice, discountPct: Math.round(rate * 100), discountAmt, total };
}

async function getOrderMsg(
  tenantId: number,
  plan: PlanCode,
  qty: number
): Promise<{ msg: string; total: number; configured: boolean }> {
  const account = (await getTenantSetting(tenantId, "account_number")) ?? "";
  const bank = (await getTenantSetting(tenantId, "bank_name")) ?? "Nayapay";
  const { basePrice, discountPct, discountAmt, total } = await calcOrder(tenantId, plan, qty);
  const label = PLAN_LABELS[plan];

  const configured = !!(account.trim());

  let priceLines: string;
  if (discountPct > 0) {
    priceLines =
      `Rs. ${fmt(basePrice)} × ${qty} = Rs. ${fmt(basePrice * qty)}\n` +
      `🏷️ Discount: ${discountPct}% = -Rs. ${fmt(discountAmt)}\n` +
      `💵 *Total: Rs. ${fmt(total)}*`;
  } else {
    priceLines = `💵 Rs. ${fmt(basePrice)} × ${qty} = *Rs. ${fmt(total)}*`;
  }

  const accountLine = account.trim()
    ? `📱 Account: *${account.trim()}*`
    : `📱 Account: _(contact support for payment details)_`;

  const msg =
    `🧾 *Order Summary*\n` +
    `📦 ${label} × ${qty} key${qty > 1 ? "s" : ""}\n` +
    `💰 ${priceLines}\n\n` +
    `📲 Please send *Rs. ${fmt(total)}* to:\n` +
    `🏦 Bank: ${bank}\n` +
    `${accountLine}\n\n` +
    `💬 After payment, reply with the *amount* you paid (numbers only).`;

  return { msg, total, configured };
}

// ── Main message handler ──────────────────────────────────────────────────────

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

  if (["*", "menu", "start", "hi", "hello", "/start"].includes(lc)) {
    state = { stage: "idle", lastActivity: now };
    userStates.set(stateKey, state);
    await sendReply(await getMsg(tenantId, "msg_welcome", MSG_DEFAULTS.msg_welcome));
    return;
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────
  if (state.stage === "idle") {
    if (trimmed === "1") {
      state.stage = "activate_awaiting_key";
      userStates.set(stateKey, state);
      await sendReply(await getMsg(tenantId, "msg_activate_prompt", MSG_DEFAULTS.msg_activate_prompt));
      return;
    }
    if (trimmed === "2") {
      state.stage = "purchase_select_plan";
      userStates.set(stateKey, state);
      await sendReply(await getPlanMenuMsg(tenantId));
      return;
    }
    await sendReply(await getMsg(tenantId, "msg_welcome", MSG_DEFAULTS.msg_welcome));
    userStates.set(stateKey, state);
    return;
  }

  // ── ACTIVATE: awaiting CDK key ────────────────────────────────────────────
  if (state.stage === "activate_awaiting_key") {
    // If they sent a session token JSON instead of CDK key, give a clear hint
    if (isSessionToken(trimmed)) {
      await sendReply(
        "⚠️ Please send your *CDK key* first (not the session token).\n\n" +
        "The CDK key is a short code (e.g. ABC-12345).\n" +
        "Type * to go back to the main menu and start over."
      );
      return;
    }
    if (!isCdkKeyFormat(trimmed)) {
      await sendReply(await getMsg(tenantId, "msg_invalid_key", MSG_DEFAULTS.msg_invalid_key));
      return;
    }
    await sendReply("⏳ Checking your key, please wait...");
    const result = await checkKey(trimmed);
    if (result.status === "invalid") {
      await sendReply(await getMsg(tenantId, "msg_invalid_key", MSG_DEFAULTS.msg_invalid_key));
      return;
    }
    if (result.status === "expired") {
      await sendReply("❌ This key has expired.\n\nType * for the main menu.");
      return;
    }
    if (result.status === "error") {
      await sendReply("⚠️ Could not reach the key server right now. Please try again in a moment.");
      return;
    }
    // Key is already used — inform the customer clearly and stop
    if (result.status === "used") {
      const when = result.activatedAt
        ? ` on ${new Date(result.activatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
        : "";
      const forEmail = result.activatedEmail ? ` for *${result.activatedEmail}*` : "";
      await sendReply(
        `❌ This key was already activated${when}${forEmail}.\n\n` +
        `Please use a different key or contact your seller.\n\nType * for the main menu.`
      );
      return;
    }
    // status is "available" — proceed to session token step
    state.stage = "activate_awaiting_session";
    state.cdkKey = trimmed;
    userStates.set(stateKey, state);
    const planInfo = (result.subscription ?? result.product)
      ? ` _(${result.subscription ?? result.product})_`
      : "";
    await sendReply(
      await getMsg(tenantId, "msg_key_verified", MSG_DEFAULTS.msg_key_verified, { plan_info: planInfo })
    );
    return;
  }

  // ── ACTIVATE: awaiting session token ─────────────────────────────────────
  if (state.stage === "activate_awaiting_session") {
    if (isCdkKeyFormat(trimmed) && !isSessionToken(trimmed)) {
      const result = await checkKey(trimmed);
      if (result.status === "invalid" || result.status === "expired") {
        await sendReply("❌ That key is not valid. Please send the session token JSON or a different CDK key.");
        return;
      }
      if (result.status === "used") {
        const when = result.activatedAt
          ? ` on ${new Date(result.activatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
          : "";
        const forEmail = result.activatedEmail ? ` for *${result.activatedEmail}*` : "";
        await sendReply(
          `❌ This key was already activated${when}${forEmail}.\n\nPlease use a different key.\n\nType * for the main menu.`
        );
        return;
      }
      // "available" — update stored key and ask for session token
      state.cdkKey = trimmed;
      userStates.set(stateKey, state);
      const planInfo = (result.subscription ?? result.product)
        ? ` _(${result.subscription ?? result.product})_`
        : "";
      await sendReply(
        await getMsg(tenantId, "msg_key_verified", MSG_DEFAULTS.msg_key_verified, { plan_info: planInfo })
      );
      return;
    }
    if (!isSessionToken(trimmed)) {
      await sendReply(await getMsg(tenantId, "msg_bad_session", MSG_DEFAULTS.msg_bad_session));
      return;
    }
    await sendReply("⏳ Activating your account, please wait...");
    const activation = await activateKey(state.cdkKey!, trimmed);
    if (activation.success) {
      userStates.delete(stateKey);
      await sendReply(
        await getMsg(tenantId, "msg_activation_ok", MSG_DEFAULTS.msg_activation_ok, {
          email: activation.email ?? "N/A",
          plan: activation.subscription ?? activation.product ?? "N/A",
        })
      );
    } else {
      userStates.set(stateKey, state);

      // Special error cases get dedicated helpful messages
      const errCode = activation.errorMessage ?? "";
      if (errCode === "__truncated__") {
        await sendReply(
          `❌ *Your session JSON appears to be cut off.*\n\n` +
          `WhatsApp truncates very long messages. Please:\n` +
          `1. Open *chat.openai.com/api/auth/session* in your browser\n` +
          `2. Copy the *entire* page content (Select All → Copy)\n` +
          `3. Paste it here again\n\n` +
          `Make sure the text ends with *}* and contains \`"accessToken"\`.`
        );
      } else if (
        errCode.toLowerCase().includes("token") ||
        errCode.toLowerCase().includes("invalid") ||
        errCode.toLowerCase().includes("validation")
      ) {
        await sendReply(
          `❌ *Session token rejected by the server.*\n\n` +
          `This usually means the token has *expired* (they last ~2 hours).\n\n` +
          `Please:\n` +
          `1. Open *chat.openai.com/api/auth/session* in your browser\n` +
          `2. Copy the full page content again (it will be fresh)\n` +
          `3. Paste it here\n\n` +
          `Type * to start over.`
        );
      } else {
        await sendReply(
          await getMsg(tenantId, "msg_activation_fail", MSG_DEFAULTS.msg_activation_fail, {
            error: errCode || "Unknown error",
          })
        );
      }
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
      await sendReply(`⚠️ Please reply with *1*, *2*, or *3*:\n\n${await getPlanMenuMsg(tenantId)}`);
      return;
    }
    state.selectedPlan = plan;
    state.stage = "purchase_awaiting_qty";
    userStates.set(stateKey, state);
    await sendReply(
      await getMsg(tenantId, "msg_qty_prompt", MSG_DEFAULTS.msg_qty_prompt, {
        plan_label: PLAN_LABELS[plan],
      })
    );
    return;
  }

  // ── PURCHASE: awaiting quantity ───────────────────────────────────────────
  if (state.stage === "purchase_awaiting_qty") {
    const qty = parseInt(trimmed, 10);
    if (isNaN(qty) || qty < 1 || qty > 50) {
      await sendReply("⚠️ Please enter a number between *1* and *50*.");
      return;
    }
    const { msg, total } = await getOrderMsg(tenantId, state.selectedPlan!, qty);
    state.expectedQty = qty;
    state.expectedTotal = total;
    state.internalRef = randomUUID();
    state.stage = "purchase_awaiting_amount";
    userStates.set(stateKey, state);
    await createPayment(tenantId, jid, state.internalRef).catch(() => {});
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
    userStates.set(stateKey, state);
    await sendReply(
      await getMsg(tenantId, "msg_payment_ask_title", MSG_DEFAULTS.msg_payment_ask_title, {
        amount: fmt(paid),
      })
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

    const gmailUser = (await getTenantSetting(tenantId, "gmail_user")) ?? "";
    const gmailPass = (await getTenantSetting(tenantId, "gmail_password")) ?? "";
    const envUser = process.env["GMAIL_USER"] ?? "";
    const envPass = process.env["GMAIL_APP_PASSWORD"] ?? "";
    const effectiveUser = gmailUser || envUser;
    const effectivePass = gmailPass || envPass;
    const gmailAvailable = !!(effectiveUser && effectivePass);

    if (!gmailAvailable) {
      await sendReply(await getMsg(tenantId, "msg_payment_noconfig", MSG_DEFAULTS.msg_payment_noconfig));
      state.stage = "purchase_awaiting_title";
      userStates.set(stateKey, state);
      return;
    }

    const result = await verifyPaymentByEmail(
      trimmed,
      String(state.expectedTotal ?? ""),
      { user: effectiveUser, pass: effectivePass }
    );

    if (!result.verified) {
      await sendReply(await getMsg(tenantId, "msg_payment_retry", MSG_DEFAULTS.msg_payment_retry));
      state.stage = "purchase_awaiting_title";
      userStates.set(stateKey, state);
      return;
    }

    if (result.messageId) {
      const claimed = await claimEmailMessageId(state.internalRef!, result.messageId);
      if (!claimed) {
        logger.warn({ tenantId, jid, messageId: result.messageId }, "[handler] Duplicate email claim rejected");
        await sendReply(await getMsg(tenantId, "msg_duplicate_email", MSG_DEFAULTS.msg_duplicate_email));
        state = { stage: "idle", lastActivity: now };
        userStates.set(stateKey, state);
        return;
      }
    }

    const keys = await getAvailableKeys(tenantId, state.selectedPlan!, state.expectedQty!);
    if (keys.length === 0) {
      await sendReply(await getMsg(tenantId, "msg_no_keys", MSG_DEFAULTS.msg_no_keys));
      state = { stage: "idle", lastActivity: now };
      userStates.set(stateKey, state);
      return;
    }
    if (keys.length < state.expectedQty!) {
      await sendReply(`⚠️ Only ${keys.length} key${keys.length > 1 ? "s" : ""} available. Sending what we have!`);
    }

    await markKeysUsed(tenantId, keys.map((k) => k.id), jid);
    await verifyPayment(
      state.internalRef!,
      state.selectedPlan!,
      keys.length,
      keys.map((k) => k.key_value)
    ).catch(() => {});
    await updateCustomerBalance(tenantId, jid, state.expectedTotal!, keys.length).catch(() => {});

    const planLabel = PLAN_LABELS[state.selectedPlan!];
    const keyList = keys.map((k, i) => `${numEmoji(i)} *${k.key_value}*`).join("\n");

    userStates.delete(stateKey);
    await sendReply(
      await getMsg(tenantId, "msg_keys_delivered", MSG_DEFAULTS.msg_keys_delivered, {
        are_is: keys.length === 1 ? "is" : "are",
        plan_label: planLabel,
        plural: keys.length > 1 ? "s" : "",
        keys_list: keyList,
        total: fmt(state.expectedTotal!),
      })
    );
    return;
  }

  await sendReply(await getMsg(tenantId, "msg_welcome", MSG_DEFAULTS.msg_welcome));
  userStates.set(stateKey, { stage: "idle", lastActivity: now });
}
