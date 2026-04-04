import { useState } from "react";
import { useLocation } from "wouter";
import { api, setToken, setStoredEmail } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function AuthPage() {
  const [location, navigate] = useLocation();
  const isRegister = location.includes("register");
  const [tab, setTab] = useState<"login" | "register">(isRegister ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = tab === "login"
        ? await api.login(email, password)
        : await api.register(email, password);
      setToken(result.token);
      setStoredEmail(result.email);
      navigate(`${BASE}/dashboard`);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-white flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">🤖</div>
          <h1 className="text-2xl font-bold text-gray-900">WhatsApp Bot Platform</h1>
          <p className="text-gray-500 text-sm mt-1">Run your own ChatGPT key sales bot</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {/* Tabs */}
          <div className="flex rounded-lg bg-gray-100 p-1 mb-6">
            {(["login", "register"] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setTab(t); setError(""); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  tab === t ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tab === "register" ? "At least 8 characters" : "Your password"}
                required
                minLength={tab === "register" ? 8 : 1}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg text-sm transition-colors disabled:opacity-60"
            >
              {loading ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}
            </button>
          </form>

          {tab === "register" && (
            <p className="text-xs text-gray-500 mt-4 text-center">
              By creating an account, you agree to run your bot responsibly.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
