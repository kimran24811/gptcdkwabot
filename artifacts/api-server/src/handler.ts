import { checkKey, activateKey } from "./cdk.js";
import { verifyPaymentByEmail } from "./gmail.js";
import {
  getSetting,
  getAvailableKeys,
  markKeysUsed,
  createPayment,
  updatePaymentRaast,
  verifyPayment,
} from "./db.js";
import { logger } from "./lib/logger.js";

type Stage =
  | "idle"
  | "activate_awaiting_key"
  | "activate_awaiting_session"
  | "purchase_awaiting_txid"
  | "purchase_awaiting_raast"
  | "purchase_select_plan"
  | "purchase_awaiting_qty";

export const PLAN_CODES = ["1mo_plus", "12mo_plus", "12mo_go"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const PLAN_LABELS: Record<PlanCode, string> = {
  "1mo_plus": "1 Month Plus Plan",
  "12mo_plus": "12 Month Plus Plan",
  "12mo_go": "12 Month Go Plan",
};

interface UserState {
  stage: Stage;
  cdkKey?: string;
  txid?: string;
  selectedPlan?: PlanCode;
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

const MAIN_MENU = `👋 *Welcome to ChatGPT Bot!*

What would you like to do?

1️⃣ Activate existing key
2️⃣ Purchase a new key

Reply with *1* or *2*`;

const PLAN_MENU = `🛒 *Select a Plan:*

1️⃣ 1 Month Plus Plan
2️⃣ 12 Month Plus Plan
3️⃣ 12 Month Go Plan

Reply with *1*, *2*, or *3*`;

async function getPaymentInfo(): Promise<string> {
  const account = (await getSetting("account_number")) ?? "03022000761";
  const bank = (await getSetting("bank_name")) ?? "Nayapay";
  const title = (await getSetting("account_title")) ?? "Khalid Imran";
  return `💳 *Payment Details*

🏦 Bank: ${bank}
👤 Account Title: ${title}
📱 Account Number: *${account}*

Please send your payment and reply with your *Transaction ID (TxID)*.

Example: TMICFBPK040426048010987751`;
}

function keyVerifiedMsg(plan?: string): string {
  return `✅ Key verified!${plan ? ` _(${plan})_` : ""}

Now I need your ChatGPT *session token* to activate your account.

📋 How to get it:
1. Open a browser and go to:
   chat.openai.com/api/auth/session
2. You'll see a JSON page starting with {"user":...
3. Select *ALL* the text and send it here

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

  // Global reset triggers
  if (["menu", "start", "hi", "hello", "/start"].includes(lc)) {
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
      state.stage = "purchase_awaiting_txid";
      userStates.set(jid, state);
      await sendReply(await getPaymentInfo());
      return;
    }
    await sendReply(MAIN_MENU);
    userStates.set(jid, state);
    return;
  }

  // ── ACTIVATE: awaiting CDK key ────────────────────────────────────────────
  if (state.stage === "activate_awaiting_key") {
    if (!isCdkKeyFormat(trimmed)) {
      await sendReply("❌ That doesn't look like a valid CDK key. Please send your key (letters and numbers only).");
      return;
    }
    const result = await checkKey(trimmed);
    if (result.status === "available") {
      state.stage = "activate_awaiting_session";
      state.cdkKey = trimmed;
      userStates.set(jid, state);
      await sendReply(keyVerifiedMsg(result.subscription ?? result.product));
    } else if (result.status === "used") {
      await sendReply("❌ This key has already been activated. Type *menu* to start over.");
    } else if (result.status === "expired") {
      await sendReply("❌ This key has expired. Type *menu* to start over.");
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
        `🎉 *Activation Successful!*\n📧 Account: ${activation.email ?? "N/A"}\n📦 Plan: ${activation.subscription ?? activation.product ?? "N/A"}\n\nEnjoy your subscription! 🚀`
      );
      await sendReply(MAIN_MENU);
    } else {
      userStates.set(jid, state);
      await sendReply(
        `❌ Activation failed: ${activation.errorMessage ?? "Unknown error"}\n\nPlease make sure you copied the complete JSON from chat.openai.com/api/auth/session and try again, or send a new CDK key.`
      );
    }
    return;
  }

  // ── PURCHASE: awaiting TxID ───────────────────────────────────────────────
  if (state.stage === "purchase_awaiting_txid") {
    if (trimmed.length < 8) {
      await sendReply("⚠️ That doesn't look like a valid Transaction ID. Please send the full TxID from your payment confirmation.");
      return;
    }
    state.txid = trimmed;
    state.stage = "purchase_awaiting_raast";
    userStates.set(jid, state);
    await createPayment(jid, trimmed).catch(() => {});
    await sendReply(
      `✅ Got it!\n\nNow please tell me the *last 4 digits* of your *Raast ID / IBAN* to verify your payment.\n\nThis is shown in your payment confirmation email as: ●●●●*XXXX*`
    );
    return;
  }

  // ── PURCHASE: awaiting Raast last 4 ──────────────────────────────────────
  if (state.stage === "purchase_awaiting_raast") {
    if (!/^\d{4}$/.test(trimmed)) {
      await sendReply("⚠️ Please enter exactly *4 digits* (the last 4 digits of your Raast ID / IBAN).");
      return;
    }
    await updatePaymentRaast(state.txid!, trimmed).catch(() => {});
    await sendReply("⏳ Verifying your payment, please wait...");

    const result = await verifyPaymentByEmail(state.txid!, trimmed);

    if (!result.verified) {
      const gmailConfigured = !!(process.env["GMAIL_USER"] && process.env["GMAIL_APP_PASSWORD"]);
      if (!gmailConfigured) {
        // Gmail not set up yet — allow manual fallthrough so admin can verify manually
        logger.warn({ jid, txid: state.txid, raast: trimmed }, "[handler] Gmail not configured — skipping auto-verify");
        state.stage = "purchase_select_plan";
        userStates.set(jid, state);
        await sendReply(
          `⚠️ Automatic verification is being set up. Your payment details have been recorded and will be reviewed shortly.\n\nMeanwhile, please select your plan:\n\n${PLAN_MENU}`
        );
      } else {
        await sendReply(
          `❌ Could not verify your payment.\n\nPlease double-check:\n• Transaction ID: *${state.txid}*\n• Last 4 digits of Raast ID\n\nType *menu* to start over or try again with your TxID.`
        );
        state.stage = "purchase_awaiting_txid";
        state.txid = undefined;
        userStates.set(jid, state);
      }
      return;
    }

    logger.info({ jid, txid: state.txid, ...result }, "[handler] Payment verified via email");
    state.stage = "purchase_select_plan";
    userStates.set(jid, state);
    await sendReply(
      `✅ *Payment Verified!*${result.senderName ? `\n👤 Received from: ${result.senderName}` : ""}${result.amount ? `\n💰 Amount: Rs. ${result.amount}` : ""}\n\n${PLAN_MENU}`
    );
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
      await sendReply(`Please reply with *1*, *2*, or *3*:\n\n${PLAN_MENU}`);
      return;
    }
    state.selectedPlan = plan;
    state.stage = "purchase_awaiting_qty";
    userStates.set(jid, state);
    await sendReply(`✅ Selected: *${PLAN_LABELS[plan]}*\n\nHow many keys do you need? _(Enter a number, max 10)_`);
    return;
  }

  // ── PURCHASE: awaiting quantity ───────────────────────────────────────────
  if (state.stage === "purchase_awaiting_qty") {
    const qty = parseInt(trimmed, 10);
    if (isNaN(qty) || qty < 1 || qty > 10) {
      await sendReply("⚠️ Please enter a number between *1* and *10*.");
      return;
    }

    const keys = await getAvailableKeys(state.selectedPlan!, qty);
    if (keys.length === 0) {
      await sendReply("❌ Sorry, no keys are currently available for this plan. Please contact support.");
      state = { stage: "idle", lastActivity: now };
      userStates.set(jid, state);
      return;
    }
    if (keys.length < qty) {
      await sendReply(`⚠️ Only ${keys.length} key(s) available. Sending what we have.`);
    }

    await markKeysUsed(keys.map((k) => k.id), jid);
    await verifyPayment(state.txid!, state.selectedPlan!, keys.length, keys.map((k) => k.key_value)).catch(() => {});

    const planLabel = PLAN_LABELS[state.selectedPlan!];
    const keyList = keys.map((k, i) => `${i + 1}. ${k.key_value}`).join("\n");

    userStates.delete(jid);
    await sendReply(`🎉 *Here are your ${planLabel} key(s):*\n\n${keyList}\n\nThank you for your purchase! 🚀\n\nType *menu* if you need anything else.`);
    return;
  }

  // Fallback
  await sendReply(MAIN_MENU);
  userStates.set(jid, { stage: "idle", lastActivity: now });
}
