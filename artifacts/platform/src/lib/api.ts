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

export type OrderRow = {
  id: number;
  jid: string;
  quantity: number;
  price_per_key: string;
  total_usd: string;
  tx_id: string;
  status: string;
  keys_delivered: string[] | null;
  created_at: string;
};

export const api = {
  register: (email: string, password: string) =>
    request<{ token: string; tenantId: number; email: string }>("/register", {
      method: "POST", body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ token: string; tenantId: number; email: string }>("/login", {
      method: "POST", body: JSON.stringify({ email, password }),
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

  getKeys: () =>
    request<{
      keys: Array<{ id: number; plan: string; key_value: string; is_used: boolean; used_at: string | null; used_by_jid: string | null; created_at: string }>;
      stats: Array<{ plan: string; total: number; available: number }>;
    }>("/keys"),

  addKeys: (keys_text: string) =>
    request<{ ok: boolean; added: number }>("/keys", { method: "POST", body: JSON.stringify({ keys_text }) }),

  deleteKey: (id: number) =>
    request<{ ok: boolean }>(`/keys/${id}`, { method: "DELETE" }),

  getOrders: (status?: string) =>
    request<OrderRow[]>(`/orders${status ? `?status=${status}` : ""}`),

  confirmOrder: (id: number) =>
    request<{ ok: boolean; keysDelivered: number; shortfall: number }>(`/orders/${id}/confirm`, { method: "POST" }),

  cancelOrder: (id: number) =>
    request<{ ok: boolean }>(`/orders/${id}/cancel`, { method: "POST" }),
};
