import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";

interface BotStatus {
  connected: boolean;
  qr: string | null;
  phone: string | null;
}
interface KeyStat { plan: string; total: number; available: number; }

const PLAN_LABELS: Record<string, string> = {
  "1mo_plus": "1 Month Plus",
  "12mo_plus": "12 Month Plus",
  "12mo_go": "12 Month Go",
};

export default function DashboardPage() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [stats, setStats] = useState<KeyStat[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [botMsg, setBotMsg] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getBotStatus();
      setStatus(s);
    } catch {}
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const { stats } = await api.getKeys();
      setStats(stats);
    } catch {}
  }, []);

  useEffect(() => {
    loadStatus();
    loadStats();
    const iv = setInterval(loadStatus, 3000);
    return () => clearInterval(iv);
  }, [loadStatus, loadStats]);

  async function startBot() {
    setActionLoading(true);
    setError("");
    setBotMsg("");
    try {
      const r = await api.startBot();
      setBotMsg(r.message);
      setTimeout(loadStatus, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start bot");
    } finally {
      setActionLoading(false);
    }
  }

  async function stopBot() {
    setActionLoading(true);
    setError("");
    setBotMsg("");
    try {
      const r = await api.stopBot();
      setBotMsg(r.message);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop bot");
    } finally {
      setActionLoading(false);
    }
  }

  const totalKeys = stats.reduce((a, s) => a + s.total, 0);
  const availableKeys = stats.reduce((a, s) => a + s.available, 0);

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Dashboard</h1>
      <p className="text-gray-500 text-sm mb-8">Manage your WhatsApp bot and monitor sales</p>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard icon="🔑" label="Available Keys" value={availableKeys} sub={`of ${totalKeys} total`} color="green" />
        {stats.map((s) => (
          <StatCard
            key={s.plan}
            icon="📦"
            label={PLAN_LABELS[s.plan] ?? s.plan}
            value={s.available}
            sub={`${s.total} total`}
            color="blue"
          />
        ))}
      </div>

      {/* WhatsApp Connection Card */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📱</span>
            <div>
              <h2 className="font-semibold text-gray-900">WhatsApp Connection</h2>
              <p className="text-sm text-gray-500">
                {status?.connected
                  ? `Connected${status.phone ? ` · ${status.phone.split(":")[0].replace("@s.whatsapp.net", "")}` : ""}`
                  : "Not connected"}
              </p>
            </div>
          </div>
          <StatusBadge connected={status?.connected ?? false} />
        </div>

        {/* QR Code */}
        {!status?.connected && status?.qr && (
          <div className="flex flex-col items-center py-6 border-t border-gray-100">
            <p className="text-sm text-gray-600 mb-4">
              Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
            </p>
            <img src={status.qr} alt="WhatsApp QR Code" className="w-56 h-56 rounded-xl border border-gray-200 shadow-sm" />
            <p className="text-xs text-gray-400 mt-3">Scan this QR code to link your number</p>
          </div>
        )}

        {!status?.connected && !status?.qr && (
          <div className="flex flex-col items-center py-8 border-t border-gray-100 text-center">
            <span className="text-4xl mb-3">📲</span>
            <p className="text-gray-600 text-sm mb-1">Your bot is not connected</p>
            <p className="text-gray-400 text-xs">Click "Start Bot" to generate a QR code</p>
          </div>
        )}

        {status?.connected && (
          <div className="border-t border-gray-100 pt-5 flex items-center gap-3">
            <span className="text-2xl">✅</span>
            <div>
              <p className="text-sm font-medium text-gray-800">Bot is running</p>
              <p className="text-xs text-gray-500">Customers can now message your WhatsApp number to buy keys</p>
            </div>
          </div>
        )}

        {(error || botMsg) && (
          <div className={`mt-4 text-sm px-4 py-3 rounded-lg ${error ? "bg-red-50 text-red-700 border border-red-200" : "bg-green-50 text-green-700 border border-green-200"}`}>
            {error || botMsg}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 mt-5 border-t border-gray-100 pt-5">
          <button
            onClick={startBot}
            disabled={actionLoading}
            className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors"
          >
            {actionLoading ? "..." : status?.connected ? "Restart Bot" : "Start Bot"}
          </button>
          {status?.connected && (
            <button
              onClick={stopBot}
              disabled={actionLoading}
              className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 disabled:opacity-60 transition-colors"
            >
              Stop Bot
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-400 mt-4">
        QR code refreshes automatically. Keep this page open while scanning.
      </p>
    </div>
  );
}

function StatCard({ icon, label, value, sub, color }: { icon: string; label: string; value: number; sub: string; color: "green" | "blue" }) {
  const colors = {
    green: "bg-green-50 text-green-600",
    blue: "bg-blue-50 text-blue-600",
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className={`w-9 h-9 rounded-lg ${colors[color]} flex items-center justify-center text-lg mb-3`}>{icon}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-sm font-medium text-gray-700 mt-0.5">{label}</div>
      <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
      connected ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-gray-400"}`} />
      {connected ? "Online" : "Offline"}
    </span>
  );
}
