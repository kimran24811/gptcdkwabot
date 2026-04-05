import { useState, useEffect, useCallback } from "react";
import { api, type OrderRow } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  pending:   "bg-yellow-100 text-yellow-700",
  confirmed: "bg-blue-100 text-blue-700",
  delivered: "bg-green-100 text-green-700",
  cancelled: "bg-gray-100 text-gray-500",
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string; id: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getOrders(filter !== "all" ? filter : undefined);
      setOrders(data);
    } catch {}
    setLoading(false);
  }, [filter]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  async function confirm(id: number) {
    if (!confirm("Confirm this payment and deliver keys?")) return;
    setActionId(id);
    setMsg(null);
    try {
      const r = await api.confirmOrder(id);
      setMsg({
        type: "ok",
        text: `${r.keysDelivered} key${r.keysDelivered !== 1 ? "s" : ""} delivered via WhatsApp!${r.shortfall > 0 ? ` (${r.shortfall} pending — not enough stock)` : ""}`,
        id,
      });
      load();
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "Failed", id });
    } finally {
      setActionId(null);
    }
  }

  async function cancel(id: number) {
    if (!confirm("Cancel this order?")) return;
    setActionId(id);
    try {
      await api.cancelOrder(id);
      load();
    } catch {}
    setActionId(null);
  }

  const pending = orders.filter((o) => o.status === "pending").length;

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">
          Orders
          {pending > 0 && (
            <span className="ml-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">
              {pending} pending
            </span>
          )}
        </h1>
        <button onClick={() => load()} className="text-sm text-gray-500 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          ↻ Refresh
        </button>
      </div>
      <p className="text-gray-500 text-sm mb-6">Verify Binance payments and deliver keys to customers</p>

      {msg && (
        <div className={`mb-4 px-4 py-3 rounded-lg text-sm border ${msg.type === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.type === "ok" ? "✅ " : "❌ "}{msg.text}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit mb-6">
        {["all", "pending", "delivered", "cancelled"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${filter === s ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-gray-400 py-8">Loading...</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">#</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Order</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">TX ID</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {orders.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-10 text-center text-gray-400">No orders found.</td></tr>
              )}
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-700">#{o.id}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {o.jid.replace(/@s\.whatsapp\.net|@lid/, "")}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-gray-800">{o.quantity} key{o.quantity > 1 ? "s" : ""}</span>
                    <span className="text-gray-400 text-xs ml-1">@ ${parseFloat(o.price_per_key).toFixed(2)}</span>
                    <div className="text-green-700 font-semibold text-xs">${parseFloat(o.total_usd).toFixed(2)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-gray-600 break-all max-w-[140px] block truncate" title={o.tx_id}>
                      {o.tx_id}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[o.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {o.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {new Date(o.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {o.status === "pending" && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => confirm(o.id)}
                          disabled={actionId === o.id}
                          className="px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors"
                        >
                          {actionId === o.id ? "..." : "Confirm & Deliver"}
                        </button>
                        <button
                          onClick={() => cancel(o.id)}
                          disabled={actionId === o.id}
                          className="px-3 py-1.5 text-red-500 text-xs font-medium rounded-lg hover:bg-red-50 disabled:opacity-60 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {o.status === "delivered" && o.keys_delivered && (
                      <span className="text-xs text-gray-400">{o.keys_delivered.length} keys sent</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
