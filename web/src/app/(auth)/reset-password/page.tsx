"use client";

/**
 * /reset-password — user lands here after clicking the recovery link in
 * their email. By this point they're signed in via the recovery code
 * (handled by /auth/callback). They pick a new password, we call
 * `supabase.auth.updateUser({ password })`, then sign them back out and
 * send them to /login.
 *
 * Auth-gated by the middleware (recovery code flow leaves them
 * authenticated). Direct visits without a recovery session redirect to
 * /forgot-password.
 *
 * Why sign out instead of continuing into the app: Supabase's recovery
 * link exchanges for a completely normal, full session — there's no
 * "can only change password" scoped session in its model, and this app
 * (via /auth/callback exchanging the code server-side) never even sees
 * the client-side PASSWORD_RECOVERY event other Supabase apps key off
 * of to gate the UI further. Concretely, this used to mean: click the
 * recovery link on a shared computer and you're fully logged into the
 * account, browsing every project, not just handed a password field.
 * We can't make the session itself scoped, but we CAN make sure it
 * doesn't outlive this page — both the successful save and Cancel below
 * sign out rather than dropping the user into "/". The new password
 * still works immediately; they just sign in with it like normal,
 * which is also a reasonable "yes, that really was you" confirmation.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [authedEmail, setAuthedEmail] = useState<string | null>(null);
  const [sessionCheckFailed, setSessionCheckFailed] = useState(false);

  // Confirm we have a session — the recovery code was already exchanged
  // for cookies by /auth/callback before getting here. If not, the user
  // hit this URL directly and should be redirected.
  //
  // No .catch() here used to mean a rejected getUser() (network blip,
  // Supabase outage — plausible right after clicking an email link on a
  // switching connection) left sessionReady false forever: the user was
  // stuck on "Verifying recovery link…" with no error and no way forward.
  useEffect(() => {
    const supabase = createClient();
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (data.user) {
          setAuthedEmail(data.user.email ?? null);
          setSessionReady(true);
        } else {
          router.replace("/forgot-password");
        }
      })
      .catch(() => setSessionCheckFailed(true));
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
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
      // Sign out of the recovery-derived session rather than carrying
      // it into the app — see the file header comment for why. The
      // password change already succeeded; this only ends the current
      // session, not the account.
      await supabase.auth.signOut();
      router.replace("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    // Same reasoning as the success path — abandoning the form should
    // not leave a recovery-link session sitting logged into the app.
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
  };

  if (sessionCheckFailed) {
    return (
      <div className="space-y-3 text-center text-xs py-8">
        <p className="text-rose-300">
          Recovery link verify nahi ho paya — network issue ho sakta hai.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="font-medium text-[var(--accent)] hover:underline"
        >
          Dubara try karo
        </button>
      </div>
    );
  }

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
        <button
          type="button"
          onClick={() => void cancel()}
          className="font-medium text-[var(--accent)] hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
