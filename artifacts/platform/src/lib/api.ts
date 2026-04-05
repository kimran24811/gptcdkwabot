const API_BASE = "/api/platform";

function getToken(): string | null {
  return localStorage.getItem("platform_token");
}

export function setToken(token: string): void {
  localStorage.setItem("platform_token", token);
}

export function clearToken(): void {
  localStorage.removeItem("platform_token");
  localStorage.removeItem("platform_email");
}

export function getStoredEmail(): string {
  return localStorage.getItem("platform_email") ?? "";
}

export function setStoredEmail(email: string): void {
  localStorage.setItem("platform_email", email);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string> | undefined ?? {}) },
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ token: string; tenantId: number; email: string }>("/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ token: string; tenantId: number; email: string }>("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () =>
    request<{ tenantId: number; email: string; connected: boolean; phone: string | null; createdAt: string }>("/me"),

  getBotStatus: () =>
    request<{ connected: boolean; qr: string | null; phone: string | null }>("/bot/status"),

  startBot: () => request<{ ok: boolean; message: string }>("/bot/start", { method: "POST" }),

  stopBot: () => request<{ ok: boolean; message: string }>("/bot/stop", { method: "POST" }),

  getSettings: () => request<Record<string, string>>("/settings"),

  saveSettings: (settings: Record<string, string>) =>
    request<{ ok: boolean }>("/settings", { method: "POST", body: JSON.stringify(settings) }),

  getKeys: (plan?: string) =>
    request<{
      keys: Array<{ id: number; plan: string; key_value: string; is_used: boolean; used_at: string | null; used_by_jid: string | null; created_at: string }>;
      stats: Array<{ plan: string; total: number; available: number }>;
      planLabels: Record<string, string>;
    }>(`/keys${plan ? `?plan=${plan}` : ""}`),

  addKeys: (plan: string, keys_text: string) =>
    request<{ ok: boolean; added: number }>("/keys", { method: "POST", body: JSON.stringify({ plan, keys_text }) }),

  deleteKey: (id: number) =>
    request<{ ok: boolean }>(`/keys/${id}`, { method: "DELETE" }),

  getPayments: () =>
    request<Array<{ id: number; jid: string; txid: string; raast_last4: string | null; amount: string | null; verified: boolean; plan: string | null; quantity: number | null; created_at: string }>>("/payments"),

  getCustomers: () =>
    request<Array<{ jid: string; total_spent: string; total_keys: number; last_purchase_at: string | null; first_purchase_at: string | null }>>("/customers"),

  getMessages: () =>
    request<Record<string, { current: string; default: string }>>("/messages"),

  saveMessages: (messages: Record<string, string>) =>
    request<{ ok: boolean }>("/messages", { method: "POST", body: JSON.stringify(messages) }),
};
