import { logger } from "./lib/logger.js";

const getBase = () => process.env["CDK_API_BASE"] ?? "https://keys.ovh/api/v1";
const getKey = () => process.env["CDK_API_KEY"] ?? "";

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getKey()}`,
    "Content-Type": "application/json",
  };
}

export type KeyStatus = "available" | "used" | "expired" | "invalid" | "error";

export interface CheckKeyResult {
  status: KeyStatus;
  product?: string;
  subscription?: string;
}

export interface ActivateKeyResult {
  success: boolean;
  email?: string;
  product?: string;
  subscription?: string;
  errorMessage?: string;
}

export async function checkKey(key: string): Promise<CheckKeyResult> {
  try {
    const url = `${getBase()}/key/${encodeURIComponent(key)}/status`;
    const res = await fetch(url, { headers: authHeaders() });
    const json = (await res.json()) as {
      success: boolean;
      data?: { status: string; product?: string; subscription?: string };
      error?: string;
    };

    if (!res.ok) {
      const errCode = json.error;
      if (errCode === "key_not_found") return { status: "invalid" };
      return { status: "error" };
    }

    const raw = json.data?.status ?? "";
    const status: KeyStatus =
      raw === "available" || raw === "used" || raw === "expired"
        ? raw
        : "invalid";

    return {
      status,
      product: json.data?.product,
      subscription: json.data?.subscription,
    };
  } catch (err) {
    logger.error({ err }, "[cdk] checkKey failed");
    return { status: "error" };
  }
}

/**
 * Extract just the accessToken JWT from what the user pasted.
 * The user pastes the full JSON from chat.openai.com/api/auth/session,
 * but the CDK API only wants the accessToken string.
 */
function extractAccessToken(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      if (typeof parsed["accessToken"] === "string") return parsed["accessToken"];
    } catch {
      // truncated JSON — try regex
      const m = t.match(/"accessToken"\s*:\s*"([^"]+)"/);
      if (m) return m[1]!;
    }
  }
  // Already a raw JWT or unknown format — use as-is
  return t;
}

export async function activateKey(
  key: string,
  sessionToken: string
): Promise<ActivateKeyResult> {
  try {
    // Correct endpoint: /api/v1/activate (not /key/activate)
    const url = `${getBase()}/activate`;
    // CDK API expects "user_token" = the accessToken JWT, not the full JSON blob
    const user_token = extractAccessToken(sessionToken);

    logger.info({ key, tokenLength: user_token.length }, "[cdk] activateKey calling API");

    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key, user_token }),
    });

    const text = await res.text();
    logger.info({ status: res.status, body: text.slice(0, 300) }, "[cdk] activateKey response");

    let json: { success: boolean; data?: { email?: string; subscription?: string; product?: string }; message?: string; error?: string };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      logger.error({ status: res.status, body: text.slice(0, 500) }, "[cdk] activateKey non-JSON response");
      return { success: false, errorMessage: `Server returned unexpected response (HTTP ${res.status})` };
    }

    if (!res.ok || !json.success) {
      return {
        success: false,
        errorMessage: json.message ?? json.error ?? "Activation failed",
      };
    }

    return {
      success: true,
      email: json.data?.email,
      product: json.data?.product,
      subscription: json.data?.subscription,
    };
  } catch (err) {
    logger.error({ err }, "[cdk] activateKey failed");
    return { success: false, errorMessage: "Network error during activation" };
  }
}
