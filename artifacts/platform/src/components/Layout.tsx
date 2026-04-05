import { Link, useLocation } from "wouter";
import { clearToken, getStoredEmail } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const navItems = [
  { path: "/dashboard", label: "Dashboard", icon: "📊" },
  { path: "/orders", label: "Orders", icon: "📋" },
  { path: "/keys", label: "Key Inventory", icon: "🔑" },
  { path: "/settings", label: "Settings", icon: "⚙️" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const qc = useQueryClient();

  function logout() {
    clearToken();
    qc.clear();
    navigate(`${BASE}/login`);
    window.location.reload();
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🤖</span>
            <div>
              <div className="font-bold text-gray-900 text-sm leading-tight">Bot Platform</div>
              <div className="text-xs text-gray-400">ChatGPT Plus CDK</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const active = location === item.path || location.startsWith(item.path + "/");
            return (
              <Link key={item.path} href={item.path}>
                <a className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? "bg-green-50 text-green-700"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}>
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </a>
              </Link>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="px-3 pb-4 border-t border-gray-100 pt-3">
          <div className="px-3 py-2 rounded-lg">
            <div className="text-xs text-gray-400 truncate">{getStoredEmail()}</div>
          </div>
          <button
            onClick={logout}
            className="mt-1 flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <span className="text-base">🚪</span>
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
