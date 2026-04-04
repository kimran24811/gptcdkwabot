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
  userToken: string
): Promise<ActivateKeyResult> {
  try {
    const url = `${getBase()}/activate`;

    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key, user_token: userToken, async: true }),
    });

    const json = (await res.json()) as {
      success: boolean;
      activation_id?: string;
      data?: {
        email?: string;
        product?: string;
        subscription?: string;
        status?: string;
        error?: string;
        message?: string;
      };
      error?: string;
      message?: string;
    };

    if (!res.ok || !json.success) {
      return {
        success: false,
        errorMessage: json.message ?? json.error ?? "Activation failed",
      };
    }

    const activationId = json.activation_id;
    if (!activationId) {
      return { success: false, errorMessage: "No activation ID returned" };
    }

    return await pollActivation(activationId);
  } catch (err) {
    logger.error({ err }, "[cdk] activateKey failed");
    return { success: false, errorMessage: "Network error during activation" };
  }
}

async function pollActivation(
  activationId: string
): Promise<ActivateKeyResult> {
  const url = `${getBase()}/activation/${encodeURIComponent(activationId)}/status`;
  const maxAttempts = 40;
  const intervalMs = 4000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    try {
      const res = await fetch(url, { headers: authHeaders() });
      const json = (await res.json()) as {
        success: boolean;
        data?: {
          status?: string;
          email?: string;
          product?: string;
          subscription?: string;
          error?: string;
          message?: string;
        };
      };

      const status = json.data?.status;

      if (status === "success") {
        return {
          success: true,
          email: json.data?.email,
          product: json.data?.product,
          subscription: json.data?.subscription,
        };
      }

      if (status === "failed") {
        return {
          success: false,
          errorMessage: json.data?.message ?? json.data?.error ?? "Activation failed",
        };
      }

      // status === "processing" — keep polling
    } catch (err) {
      logger.warn({ err, activationId }, "[cdk] poll attempt failed");
    }
  }

  return { success: false, errorMessage: "Activation timed out" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
