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

export async function activateKey(
  key: string,
  sessionToken: string
): Promise<ActivateKeyResult> {
  try {
    const url = `${getBase()}/key/activate`;

    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key, sessionToken }),
    });

    const json = (await res.json()) as {
      success: boolean;
      data?: {
        email?: string;
        subscription?: string;
        product?: string;
      };
      message?: string;
      error?: string;
    };

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
