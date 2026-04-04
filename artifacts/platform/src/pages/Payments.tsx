import { useState, useEffect } from "react";
import { api } from "@/lib/api";

const PLAN_LABELS: Record<string, string> = {
  "1mo_plus": "1 Month Plus",
  "12mo_plus": "12 Month Plus",
  "12mo_go": "12 Month Go",
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Awaited<ReturnType<typeof api.getPayments>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPayments().then((p) => { setPayments(p); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const verified = payments.filter((p) => p.verified).length;
  const revenue = payments
    .filter((p) => p.verified && p.amount)
    .reduce((sum, p) => sum + (parseFloat(p.amount ?? "0") || 0), 0);

  if (loading) return <div className="p-8 text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Payments</h1>
      <p className="text-gray-500 text-sm mb-6">All payment transactions from your customers</p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard icon="💰" label="Total Revenue" value={`Rs. ${revenue.toLocaleString("en-PK")}`} sub="from verified payments" />
        <StatCard icon="✅" label="Verified" value={String(verified)} sub="payments" />
        <StatCard icon="📋" label="Total" value={String(payments.length)} sub="transactions" />
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Plan</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Keys</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Account Title</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {payments.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400">No payments yet. Once customers start buying, their payments will appear here.</td></tr>
              )}
              {payments.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 text-xs text-gray-600 font-mono">
                    {p.jid.replace(/@s\.whatsapp\.net|@lid/, "")}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {p.amount ? `Rs. ${parseInt(p.amount).toLocaleString("en-PK")}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.plan ? (PLAN_LABELS[p.plan] ?? p.plan) : "—"}</td>
                  <td className="px-4 py-3 text-gray-600 text-center">{p.quantity ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{p.raast_last4 ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      p.verified ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                    }`}>
                      {p.verified ? "✓ Verified" : "⏳ Pending"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {new Date(p.created_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
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

function StatCard({ icon, label, value, sub }: { icon: string; label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-2xl mb-2">{icon}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-sm font-medium text-gray-700 mt-0.5">{label}</div>
      <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}
