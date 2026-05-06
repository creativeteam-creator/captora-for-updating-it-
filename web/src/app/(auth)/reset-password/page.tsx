"use client";

/**
 * /reset-password — user lands here after clicking the recovery link in
 * their email. By this point they're signed in via the recovery code
 * (handled by /auth/callback). They pick a new password, we call
 * `supabase.auth.updateUser({ password })`, then bounce them home.
 *
 * Auth-gated by the middleware (recovery code flow leaves them
 * authenticated). Direct visits without a recovery session redirect to
 * /forgot-password.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [authedEmail, setAuthedEmail] = useState<string | null>(null);

  // Confirm we have a session — the recovery code was already exchanged
  // for cookies by /auth/callback before getting here. If not, the user
  // hit this URL directly and should be redirected.
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setAuthedEmail(data.user.email ?? null);
        setSessionReady(true);
      } else {
        router.replace("/forgot-password");
      }
    });
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sessionReady) {
    return (
      <div className="text-center text-xs text-[var(--text-muted)] py-8">
        Verifying recovery link…
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Set a new password</h1>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {authedEmail
            ? `Pick a new password for ${authedEmail}.`
            : "Pick a new password for your account."}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          New password
        </label>
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
          placeholder="At least 6 characters"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          Confirm password
        </label>
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={6}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
          className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
          placeholder="Re-enter new password"
        />
      </div>

      {error && (
        <div className="rounded-md border border-rose-700 bg-rose-950/40 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="flex h-10 w-full items-center justify-center rounded-md bg-[var(--accent)] text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Saving…" : "Update password"}
      </button>

      <div className="text-center text-xs text-[var(--text-muted)]">
        <Link href="/" className="font-medium text-[var(--accent)] hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
