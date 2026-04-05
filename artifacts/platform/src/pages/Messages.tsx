import { useState, useEffect } from "react";
import { api } from "@/lib/api";

interface MsgDef {
  key: string;
  label: string;
  description: string;
  variables?: string[];
}

const MESSAGE_DEFS: MsgDef[] = [
  {
    key: "msg_welcome",
    label: "Welcome / Main Menu",
    description: "Shown when a user sends 'hi', 'start', or '*'. This is the first message users see.",
  },
  {
    key: "msg_activate_prompt",
    label: "Activate — Ask for CDK Key",
    description: "Sent after user picks option 1 (activate). Asks them to send their CDK key.",
  },
  {
    key: "msg_invalid_key",
    label: "Invalid CDK Key Format",
    description: "Shown when the user sends text that doesn't look like a valid CDK key.",
  },
  {
    key: "msg_key_verified",
    label: "Key Verified — Ask for Session Token",
    description: "Sent when the CDK key checks out. Asks the user for their ChatGPT session token JSON.",
    variables: ["{{plan_info}}"],
  },
  {
    key: "msg_bad_session",
    label: "Bad Session Token",
    description: "Shown when the user sends something that isn't a valid session token JSON.",
  },
  {
    key: "msg_activation_ok",
    label: "Activation Successful",
    description: "Sent after a CDK key is successfully activated.",
    variables: ["{{email}}", "{{plan}}"],
  },
  {
    key: "msg_activation_fail",
    label: "Activation Failed",
    description: "Sent when CDK activation returns an error.",
    variables: ["{{error}}"],
  },
  {
    key: "msg_qty_prompt",
    label: "Purchase — Ask for Quantity",
    description: "Sent after a plan is selected. Asks how many keys the user wants.",
    variables: ["{{plan_label}}"],
  },
  {
    key: "msg_payment_ask_title",
    label: "Payment — Ask for Account Title",
    description: "Sent after the user confirms the amount paid. Asks for their NayaPay account title.",
    variables: ["{{amount}}"],
  },
  {
    key: "msg_payment_retry",
    label: "Payment — Verification Failed (Retry)",
    description: "Shown when no matching NayaPay email is found. The user can resend their title to retry.",
  },
  {
    key: "msg_payment_noconfig",
    label: "Payment — Gmail Not Configured",
    description: "Shown when no Gmail credentials are set. Tells the user verification is temporarily unavailable.",
  },
  {
    key: "msg_keys_delivered",
    label: "Keys Delivered",
    description: "Sent after payment is verified and keys are delivered.",
    variables: ["{{are_is}}", "{{plan_label}}", "{{plural}}", "{{keys_list}}", "{{total}}"],
  },
  {
    key: "msg_no_keys",
    label: "No Keys Available",
    description: "Shown when a plan has no keys in stock at the time of purchase.",
  },
  {
    key: "msg_duplicate_email",
    label: "Duplicate Payment Email",
    description: "Shown when the same NayaPay email is used for a second order (fraud prevention).",
  },
];

type MsgData = Record<string, { current: string; default: string }>;

export default function MessagesPage() {
  const [data, setData] = useState<MsgData>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [resetKey, setResetKey] = useState<string | null>(null);

  useEffect(() => {
    api.getMessages()
      .then((d) => {
        setData(d);
        // Populate with current value, or default if blank
        const initial: Record<string, string> = {};
        for (const def of MESSAGE_DEFS) {
          initial[def.key] = d[def.key]?.current || d[def.key]?.default || "";
        }
        setValues(initial);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      await api.saveMessages(values);
      setStatus({ type: "ok", text: "All messages saved successfully!" });
    } catch (err) {
      setStatus({ type: "err", text: err instanceof Error ? err.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  function resetToDefault(key: string) {
    const def = data[key]?.default ?? "";
    setValues((v) => ({ ...v, [key]: def }));
    setResetKey(key);
    setTimeout(() => setResetKey(null), 1500);
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-3 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-green-500 rounded-full animate-spin" />
        Loading messages...
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Bot Messages</h1>
      <p className="text-gray-500 text-sm mb-2">
        Customize every message your bot sends. Use <code className="bg-gray-100 px-1 rounded text-xs text-gray-700">{"{{variable}}"}</code> placeholders where shown — they will be filled in automatically.
      </p>
      <div className="mb-8 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
        <strong>Tip:</strong> Leave a field blank to use the built-in default. Click <em>Reset to default</em> on any message to restore it.
      </div>

      <form onSubmit={save} className="space-y-5">
        {MESSAGE_DEFS.map((def) => {
          const isChanged = (values[def.key] ?? "") !== (data[def.key]?.current ?? "") &&
                            (values[def.key] ?? "") !== "";
          const isReset = resetKey === def.key;

          return (
            <div key={def.key} className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm">{def.label}</h3>
                  <p className="text-xs text-gray-400 mt-0.5">{def.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => resetToDefault(def.key)}
                  className="shrink-0 text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
                >
                  {isReset ? "✓ Reset" : "Reset to default"}
                </button>
              </div>

              {def.variables && (
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {def.variables.map((v) => (
                    <span key={v} className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-mono border border-blue-100">
                      {v}
                    </span>
                  ))}
                </div>
              )}

              <textarea
                value={values[def.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [def.key]: e.target.value }))}
                rows={Math.max(3, (values[def.key] ?? "").split("\n").length + 1)}
                placeholder={data[def.key]?.default ?? ""}
                className={`w-full px-3.5 py-2.5 rounded-lg border text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent transition-colors ${
                  isChanged ? "border-green-300 bg-green-50/30" : "border-gray-300"
                }`}
              />
            </div>
          );
        })}

        {status && (
          <div className={`px-4 py-3 rounded-lg text-sm border ${
            status.type === "ok"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}>
            {status.type === "ok" ? "✅ " : "❌ "}{status.text}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg text-sm transition-colors disabled:opacity-60"
        >
          {saving ? "Saving..." : "💾 Save All Messages"}
        </button>
      </form>
    </div>
  );
}
