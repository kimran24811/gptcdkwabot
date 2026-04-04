import { useState, useEffect } from "react";
import { api } from "@/lib/api";

const FIELDS = [
  { key: "bot_name", label: "Bot Name", placeholder: "ChatGPT Bot", hint: "Shown as your WhatsApp profile name" },
  { key: "bank_name", label: "Bank / Payment Method", placeholder: "Nayapay" },
  { key: "account_number", label: "Account Number / Phone", placeholder: "03XXXXXXXXX" },
  { key: "account_title", label: "Account Title", placeholder: "Your full name" },
  { key: "gmail_user", label: "Gmail Address (for payment verification)", placeholder: "you@gmail.com" },
  { key: "gmail_password", label: "Gmail App Password", placeholder: "16-char app password", type: "password" },
];

const PRICE_FIELDS = [
  { key: "price_1mo_plus", label: "1 Month Plus — price per key (PKR)", placeholder: "620" },
  { key: "price_12mo_plus", label: "12 Month Plus — price per key (PKR)", placeholder: "7500" },
  { key: "price_12mo_go", label: "12 Month Go — price per key (PKR)", placeholder: "1400" },
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
      setMsg({ type: "ok", text: "Settings saved successfully!" });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-8 text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-gray-500 text-sm mb-8">Configure your bot name, payment details, and prices</p>

      <form onSubmit={save} className="space-y-6">
        {/* Bot & Payment */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-800 mb-4">Bot & Payment Settings</h2>
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {f.label}
                  {f.hint && <span className="text-gray-400 font-normal ml-1.5">({f.hint})</span>}
                </label>
                <input
                  type={f.type ?? "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
            ))}
          </div>

          <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
            <p className="text-xs text-blue-700">
              <strong>Gmail setup:</strong> Use a Gmail App Password (not your regular password).
              Enable 2FA → Google Account → Security → App Passwords → Generate one for "Mail".
            </p>
          </div>
        </section>

        {/* Prices */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-800 mb-4">Plan Prices (PKR)</h2>
          <div className="space-y-4">
            {PRICE_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{f.label}</label>
                <input
                  type="number"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  min="1"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
            ))}
          </div>
        </section>

        {msg && (
          <div className={`px-4 py-3 rounded-lg text-sm border ${
            msg.type === "ok"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}>
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
