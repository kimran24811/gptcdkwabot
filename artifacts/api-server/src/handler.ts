import { checkKey, activateKey } from "./cdk.js";
import { logger } from "./lib/logger.js";

type Stage = "idle" | "awaiting_session";

interface UserState {
  stage: Stage;
  cdkKey?: string;
  lastActivity: number;
}

const userStates = new Map<string, UserState>();
const processedIds = new Set<string>();
const processedIdQueue: string[] = [];
const MAX_PROCESSED_IDS = 100;

// Rate limiting: { jid -> timestamps[] }
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const STATE_EXPIRY_MS = 30 * 60 * 1000;

// Clean up expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [jid, state] of userStates.entries()) {
    if (now - state.lastActivity > STATE_EXPIRY_MS) {
      userStates.delete(jid);
    }
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
  const timestamps = (rateLimitMap.get(jid) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (timestamps.length >= RATE_LIMIT) {
    rateLimitMap.set(jid, timestamps);
    return true;
  }
  timestamps.push(now);
  rateLimitMap.set(jid, timestamps);
  return false;
}

function isCdkKeyFormat(text: string): boolean {
  return text.length >= 6 && /^[a-zA-Z0-9\-_]+$/.test(text);
}

function isSessionToken(text: string): boolean {
  const t = text.trim();
  return t.includes("accessToken") || t.includes('"user"') || t.includes("'user'");
}

const WELCOME_MSG = `👋 Welcome to ChatGPT CDK Activation Bot!
Send me your CDK activation key to get started.`;

function keyVerifiedMsg(plan?: string): string {
  return `✅ Key verified!${plan ? ` (${plan})` : ""}
Now I need your ChatGPT session token to activate your account.
📋 How to get it:
1. Open a browser and go to:
   chat.openai.com/api/auth/session
2. You'll see a page with JSON text starting with {"user":...
3. Select ALL the text and send it here
⚠️ This is different from your CDK key — it's a long JSON from that URL.`;
}

const PROCESSING_MSG = `⏳ Activating your account, please wait...`;

function successMsg(email?: string, plan?: string): string {
  return `🎉 Your ChatGPT account has been activated successfully!
📧 Account: ${email ?? "N/A"}
📦 Plan: ${plan ?? "N/A"}
Enjoy your subscription! 🚀`;
}

function failureMsg(errorMsg: string): string {
  return `❌ Activation failed: ${errorMsg}
Please make sure you copied the complete JSON from chat.openai.com/api/auth/session and try again.
Or send a new CDK key to start over.`;
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
  const state = userStates.get(jid) ?? { stage: "idle", lastActivity: now };
  state.lastActivity = now;

  const trimmed = text.trim();

  if (state.stage === "idle") {
    if (!isCdkKeyFormat(trimmed)) {
      await sendReply(WELCOME_MSG);
      userStates.set(jid, state);
      return;
    }

    // Looks like a key — check it
    const result = await checkKey(trimmed);

    if (result.status === "available") {
      state.stage = "awaiting_session";
      state.cdkKey = trimmed;
      userStates.set(jid, state);
      await sendReply(keyVerifiedMsg(result.subscription ?? result.product));
    } else if (result.status === "used") {
      userStates.set(jid, state);
      await sendReply("❌ This key has already been activated.");
    } else if (result.status === "expired") {
      userStates.set(jid, state);
      await sendReply("❌ This key has expired.");
    } else if (result.status === "invalid") {
      userStates.set(jid, state);
      await sendReply("❌ Invalid key.");
    } else {
      userStates.set(jid, state);
      await sendReply("⚠️ Could not verify the key right now. Please try again.");
    }
    return;
  }

  // stage === "awaiting_session"
  if (isCdkKeyFormat(trimmed) && !isSessionToken(trimmed)) {
    // User sent another CDK key — check it and switch if valid
    const result = await checkKey(trimmed);
    if (result.status === "available") {
      state.cdkKey = trimmed;
      userStates.set(jid, state);
      await sendReply(keyVerifiedMsg(result.subscription ?? result.product));
    } else if (result.status === "used") {
      await sendReply("❌ This key has already been activated.");
    } else if (result.status === "expired") {
      await sendReply("❌ This key has expired.");
    } else if (result.status === "invalid") {
      await sendReply("❌ Invalid key. Please send your CDK key or the session token JSON.");
    } else {
      await sendReply("⚠️ Could not verify the key right now. Please try again.");
    }
    return;
  }

  // Treat as session token
  if (!isSessionToken(trimmed)) {
    await sendReply(keyVerifiedMsg()); // re-explain
    return;
  }

  // Activate
  await sendReply(PROCESSING_MSG);

  const activation = await activateKey(state.cdkKey!, trimmed);

  if (activation.success) {
    userStates.delete(jid);
    await sendReply(successMsg(activation.email, activation.subscription ?? activation.product));
  } else {
    // Keep state so user can retry
    userStates.set(jid, state);
    await sendReply(failureMsg(activation.errorMessage ?? "Unknown error"));
  }
}
