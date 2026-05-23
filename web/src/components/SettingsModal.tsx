"use client";

/**
 * Per-user API keys modal. Opens from the round user-initials button in
 * the header.
 *
 * Each clinic user can plug in their own Gemini + Groq keys so the
 * pipeline uses their personal quota for Hinglish polish instead of the
 * shared bundled key. When the user hasn't set anything, the bundled
 * production key (from .env.production) is used as before — so this is
 * purely additive: existing behaviour stays for users who never visit
 * Settings.
 *
 * Keys live in `public.user_api_keys` under RLS — only the owning user
 * and Captora's own server can read them. The Settings panel mirrors the
 * server-side resolution logic (user key first, env fallback) so the
 * status badge ("Active" vs "Using shared key") always matches what
 * /api/transcribe will actually do on the next render.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserApiKeys, saveUserApiKeys } from "@/lib/userApiKeys";

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string | undefined;
  userEmail?: string | null;
}

export function SettingsModal({ open, onClose, userId, userEmail }: Props) {
  const [gemini, setGemini] = useState("");
  const [groq, setGroq] = useState("");
  const [showGemini, setShowGemini] = useState(false);
  const [showGroq, setShowGroq] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  // What was last fetched from the DB — drives the "Active" / "Not set"
  // status badge so the user can tell whether their key is being used.
  const [storedGemini, setStoredGemini] = useState<string | null>(null);
  const [storedGroq, setStoredGroq] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    setLoading(true);
    setSaveStatus({ kind: "idle" });
    const supabase = createClient();
    getUserApiKeys(supabase, userId)
      .then((keys) => {
        setGemini(keys.geminiApiKey ?? "");
        setGroq(keys.groqApiKey ?? "");
        setStoredGemini(keys.geminiApiKey);
        setStoredGroq(keys.groqApiKey);
      })
      .catch((err) => {
        setSaveStatus({ kind: "error", message: `Load failed: ${err.message}` });
      })
      .finally(() => setLoading(false));
  }, [open, userId]);

  if (!open) return null;

  const onSave = async () => {
    if (!userId) {
      setSaveStatus({ kind: "error", message: "Not signed in" });
      return;
    }
    setSaveStatus({ kind: "saving" });
    try {
      const supabase = createClient();
      // Empty string → null so the row clears the override and the
      // pipeline falls back to the bundled key.
      const saved = await saveUserApiKeys(supabase, userId, {
        geminiApiKey: gemini.trim() === "" ? null : gemini,
        groqApiKey: groq.trim() === "" ? null : groq,
      });
      setStoredGemini(saved.geminiApiKey);
      setStoredGroq(saved.groqApiKey);
      setSaveStatus({ kind: "saved" });
      setTimeout(() => setSaveStatus({ kind: "idle" }), 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus({ kind: "error", message: msg });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div>
            <div className="text-sm font-semibold">Settings · API Keys</div>
            {userEmail && (
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{userEmail}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 p-5">
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
            Apni khud ki Gemini / Groq API key yahaan dal sakte ho — phir
            transcribe ke time tumhari personal quota use hogi, shared
            bundled key ki jagah. Khali chhod doge toh shared key chalegi
            (jo aaj quota-hit ho gayi thi).
          </p>

          {loading ? (
            <div className="rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              Loading…
            </div>
          ) : (
            <>
              <KeyField
                label="Gemini API Key"
                helpText={
                  <>
                    Get key:{" "}
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--accent)] hover:underline"
                    >
                      aistudio.google.com/app/apikey
                    </a>{" "}
                    · Free tier: 1500 req/day · Paid: ~₹0.30/min
                  </>
                }
                value={gemini}
                onChange={setGemini}
                showValue={showGemini}
                onToggleShow={() => setShowGemini((v) => !v)}
                stored={storedGemini}
                placeholder="AIzaSy…"
              />

              <KeyField
                label="Groq API Key"
                helpText={
                  <>
                    Get key:{" "}
                    <a
                      href="https://console.groq.com/keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--accent)] hover:underline"
                    >
                      console.groq.com/keys
                    </a>{" "}
                    · Free tier: 100K tokens/day · Paid: $20/mo for 2M+
                  </>
                }
                value={groq}
                onChange={setGroq}
                showValue={showGroq}
                onToggleShow={() => setShowGroq((v) => !v)}
                stored={storedGroq}
                placeholder="gsk_…"
              />
            </>
          )}

          <div className="flex items-center justify-between pt-2">
            <div className="text-[11px]">
              {saveStatus.kind === "saved" && (
                <span className="text-green-400">✓ Saved — fresh transcribe me apply hogi</span>
              )}
              {saveStatus.kind === "saving" && (
                <span className="text-[var(--text-muted)]">Saving…</span>
              )}
              {saveStatus.kind === "error" && (
                <span className="text-red-400">⚠ {saveStatus.message}</span>
              )}
              {saveStatus.kind === "idle" && (
                <span className="text-[var(--text-muted)]">
                  Khali chhod ke save karoge toh shared key wapas chalegi
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={saveStatus.kind === "saving" || loading}
                className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-black hover:brightness-110 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyField({
  label,
  helpText,
  value,
  onChange,
  showValue,
  onToggleShow,
  stored,
  placeholder,
}: {
  label: string;
  helpText: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  showValue: boolean;
  onToggleShow: () => void;
  stored: string | null;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          {label}
        </label>
        <StatusBadge stored={stored} />
      </div>
      <div className="flex items-center gap-2">
        <input
          type={showValue ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="h-9 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 font-mono text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="rounded-md border border-[var(--border)] px-2 py-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text)]"
          title={showValue ? "Hide" : "Show"}
        >
          {showValue ? "Hide" : "Show"}
        </button>
      </div>
      <div className="text-[10px] text-[var(--text-muted)]">{helpText}</div>
    </div>
  );
}

function StatusBadge({ stored }: { stored: string | null }) {
  if (stored && stored.length > 0) {
    return (
      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-green-400">
        Active · Your key
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
      Using shared key
    </span>
  );
}
