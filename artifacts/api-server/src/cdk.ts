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
  // Populated when status === "used"
  activatedAt?: string;
  activatedEmail?: string;
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
      data?: {
        status: string;
        product?: string;
        subscription?: string;
        activated_at?: string;
        email?: string;
      };
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
      activatedAt: json.data?.activated_at,
      activatedEmail: json.data?.email,
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
function extractAccessToken(raw: string): { token: string; truncated: boolean } {
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      if (typeof parsed["accessToken"] === "string") {
        const token = parsed["accessToken"];
        const parts = token.split(".");
        return { token, truncated: parts.length < 3 };
      }
    } catch {
      // truncated JSON — try regex
      const m = t.match(/"accessToken"\s*:\s*"([^"]+)"/);
      if (m) {
        const token = m[1]!;
        const parts = token.split(".");
        // If JSON was truncated the JWT itself may be cut mid-segment
        const jsonTruncated = !t.trimEnd().endsWith("}");
        return { token, truncated: parts.length < 3 || jsonTruncated };
      }
    }
  }
  // Already a raw JWT or unknown format — use as-is
  const parts = t.split(".");
  return { token: t, truncated: parts.length < 3 };
}

export async function activateKey(
  key: string,
  sessionToken: string
): Promise<ActivateKeyResult> {
  try {
    // Correct endpoint: /api/v1/activate (not /key/activate)
    const url = `${getBase()}/activate`;
    // CDK API expects "user_token" = the accessToken JWT, not the full JSON blob
    const { token: user_token, truncated } = extractAccessToken(sessionToken);

    // Decode JWT payload (no signature verify) to log expiry for diagnostics
    let jwtExp: number | undefined;
    let jwtEmail: string | undefined;
    let jwtExpStr = "unknown";
    try {
      const parts = user_token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1]!, "base64url").toString("utf-8")
        ) as { exp?: number; email?: string; "https://api.openai.com/profile"?: { email?: string } };
        jwtExp = payload.exp;
        jwtEmail = payload.email ?? payload["https://api.openai.com/profile"]?.email;
        if (jwtExp) {
          const expDate = new Date(jwtExp * 1000);
          const nowMs = Date.now();
          const diffSec = Math.round((jwtExp * 1000 - nowMs) / 1000);
          jwtExpStr = diffSec > 0
            ? `valid for ${diffSec}s more (expires ${expDate.toISOString()})`
            : `EXPIRED ${Math.abs(diffSec)}s ago (expired ${expDate.toISOString()})`;
        }
      }
    } catch { /* ignore decode errors */ }

    logger.info(
      {
        key,
        tokenLength: user_token.length,
        truncated,
        jwtParts: user_token.split(".").length,
        jwtExpiry: jwtExpStr,
        jwtEmail,
      },
      "[cdk] activateKey calling API"
    );

    if (truncated) {
      return {
        success: false,
        errorMessage: "__truncated__",
      };
    }

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
