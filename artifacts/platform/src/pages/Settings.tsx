import { useState, useEffect } from "react";
import { api } from "@/lib/api";

const FIELDS = [
  { key: "bot_name", label: "Bot Display Name", placeholder: "ChatGPT Bot", hint: "Shown in WhatsApp" },
  { key: "binance_id", label: "Binance Pay ID", placeholder: "552780449" },
  { key: "binance_user", label: "Binance Username", placeholder: "User-1d9f7" },
  { key: "bsc_address", label: "BSC Wallet Address", placeholder: "0x0c31c91ec2cbb607aeca28c1bc09c55352db2fea" },
];

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    api.getSettings()
      .then((s) => { setValues(s); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api.saveSettings(values);
      setMsg({ type: "ok", text: "Settings saved!" });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-8 text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-gray-500 text-sm mb-8">Bot name and Binance payment details shown to customers</p>

      <form onSubmit={save} className="space-y-6">
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-800 mb-5">Bot & Payment Settings</h2>
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {f.label}
                  {f.hint && <span className="text-gray-400 font-normal ml-1.5 text-xs">({f.hint})</span>}
                </label>
                <input
                  type="text"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
            ))}
          </div>

          <div className="mt-5 p-4 bg-amber-50 rounded-xl border border-amber-100">
            <p className="text-xs text-amber-800 font-medium mb-1">Tiered pricing (hardcoded USD)</p>
            <p className="text-xs text-amber-700">
              1–9 keys: $2.38 · 10–29: $2.15 · 30–49: $1.95 · 50–99: $1.75 · 100+: $1.55
            </p>
          </div>
        </section>

        {msg && (
          <div className={`px-4 py-3 rounded-lg text-sm border ${msg.type === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
            {msg.type === "ok" ? "✅ " : "❌ "}{msg.text}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg text-sm transition-colors disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </form>
    </div>
  );
}
