import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Awaited<ReturnType<typeof api.getCustomers>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getCustomers().then((c) => { setCustomers(c); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const totalRevenue = customers.reduce((s, c) => s + parseFloat(c.total_spent), 0);
  const totalKeys = customers.reduce((s, c) => s + c.total_keys, 0);

  if (loading) return <div className="p-8 text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Customers</h1>
      <p className="text-gray-500 text-sm mb-6">All customers who have purchased keys from your bot</p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard icon="👥" label="Total Customers" value={String(customers.length)} />
        <StatCard icon="💰" label="Total Revenue" value={`Rs. ${totalRevenue.toLocaleString("en-PK")}`} />
        <StatCard icon="🔑" label="Keys Sold" value={String(totalKeys)} />
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">WhatsApp Number</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Spent</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Keys Bought</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">First Purchase</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Purchase</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {customers.length === 0 && (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400">No customers yet. Once someone buys a key, they will appear here.</td></tr>
              )}
              {customers.map((c) => (
                <tr key={c.jid} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-mono text-xs text-gray-700">
                    {c.jid.replace(/@s\.whatsapp\.net|@lid/, "")}
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-800">
                    Rs. {parseFloat(c.total_spent).toLocaleString("en-PK")}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center justify-center w-7 h-7 bg-green-100 text-green-700 text-xs font-bold rounded-full">
                      {c.total_keys}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {c.first_purchase_at ? new Date(c.first_purchase_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {c.last_purchase_at ? new Date(c.last_purchase_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" }) : "—"}
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

function StatCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-2xl mb-2">{icon}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-sm font-medium text-gray-700 mt-0.5">{label}</div>
    </div>
  );
}
