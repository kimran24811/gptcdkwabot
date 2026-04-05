import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

interface KeyRow { id: number; plan: string; key_value: string; is_used: boolean; used_at: string | null; used_by_jid: string | null; created_at: string; }
interface StatRow { plan: string; total: number; available: number; }

export default function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<StatRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [keysText, setKeysText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "available" | "used">("all");

  const load = useCallback(async () => {
    try {
      const { keys: k, stats: s } = await api.getKeys();
      setKeys(k);
      setStats(s);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addKeys(e: React.FormEvent) {
    e.preventDefault();
    if (!keysText.trim()) return;
    setAdding(true);
    setAddMsg(null);
    try {
      const r = await api.addKeys(keysText);
      setAddMsg({ type: "ok", text: `Added ${r.added} key${r.added !== 1 ? "s" : ""}` });
      setKeysText("");
      load();
    } catch (err) {
      setAddMsg({ type: "err", text: err instanceof Error ? err.message : "Failed to add keys" });
    } finally {
      setAdding(false);
    }
  }

  async function deleteKey(id: number) {
    if (!confirm("Delete this key?")) return;
    try { await api.deleteKey(id); load(); } catch {}
  }

  const stat = stats.find((s) => s.plan === "chatgpt_plus") ?? { total: 0, available: 0 };
  const filtered = keys.filter((k) =>
    filter === "all" ? true : filter === "available" ? !k.is_used : k.is_used
  );

  if (loading) return <div className="p-8 text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Key Inventory</h1>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
        >
          + Add Keys
        </button>
      </div>
      <p className="text-gray-500 text-sm mb-6">ChatGPT Plus CDK keys available for delivery</p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-sm font-medium text-gray-500 mb-1">Available</div>
          <div className="text-3xl font-bold text-green-600">{stat.available}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-sm font-medium text-gray-500 mb-1">Used</div>
          <div className="text-3xl font-bold text-gray-400">{stat.total - stat.available}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-sm font-medium text-gray-500 mb-1">Total</div>
          <div className="text-3xl font-bold text-gray-700">{stat.total}</div>
        </div>
      </div>

      {/* Add keys form */}
      {showAdd && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-800 mb-4">Add Keys</h2>
          <form onSubmit={addKeys} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Keys — one per line or comma-separated
              </label>
              <textarea
                value={keysText}
                onChange={(e) => setKeysText(e.target.value)}
                rows={6}
                placeholder={"KEY1\nKEY2\nKEY3"}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
              />
            </div>
            {addMsg && (
              <div className={`px-4 py-3 rounded-lg text-sm border ${addMsg.type === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
                {addMsg.type === "ok" ? "✅ " : "❌ "}{addMsg.text}
              </div>
            )}
            <div className="flex gap-3">
              <button type="submit" disabled={adding} className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors">
                {adding ? "Adding..." : "Add Keys"}
              </button>
              <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Key list */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(["all", "available", "used"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-sm font-medium capitalize transition-colors ${filter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                {f}
              </button>
            ))}
          </div>
          <span className="text-sm text-gray-400 ml-auto">{filtered.length} keys</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Key</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Delivered To</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400">
                  {filter === "all" ? "No keys yet. Add some keys to get started." : `No ${filter} keys.`}
                </td></tr>
              )}
              {filtered.map((k) => (
                <tr key={k.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-mono text-xs text-gray-700">{k.key_value}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${k.is_used ? "bg-gray-100 text-gray-500" : "bg-green-100 text-green-700"}`}>
                      {k.is_used ? "Delivered" : "Available"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {k.used_by_jid ? k.used_by_jid.replace(/@s\.whatsapp\.net|@lid/, "") : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {k.used_at ? new Date(k.used_at).toLocaleDateString() : new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!k.is_used && (
                      <button onClick={() => deleteKey(k.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
