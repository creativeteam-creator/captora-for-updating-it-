"use client";

/**
 * /forgot-password — user enters their email, Supabase sends a magic
 * recovery link. Clicking the link in their inbox routes them through
 * /auth/callback (which exchanges the code for a session) and lands them
 * on /reset-password where they pick a new password.
 *
 * Public route — gated by the middleware's PUBLIC_PATHS allowlist.
 */

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    try {
      // After clicking the email, Supabase sends user to
      // /auth/callback?code=… ; we forward to /reset-password via `next`.
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-4 text-sm">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="text-xs text-[var(--text-muted)]">
          We sent a recovery link to <span className="text-[var(--text)] font-medium">{email}</span>.
          Click it to set a new password. The link expires in 1 hour.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Didn&apos;t get the email? Check your spam folder or{" "}
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
            className="font-medium text-[var(--accent)] hover:underline"
          >
            try a different address
          </button>
          .
        </p>
        <div className="text-center text-xs text-[var(--text-muted)] pt-2">
          <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
            ← Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Reset your password</h1>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Enter the email you signed up with — we&apos;ll send a recovery link.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          Email
        </label>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
          placeholder="you@example.com"
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
        {busy ? "Sending…" : "Send recovery link"}
      </button>

      <div className="text-center text-xs text-[var(--text-muted)]">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
          Sign in
        </Link>
      </div>
    </form>
  );
}
