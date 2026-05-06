"use client";

/**
 * Shared email + password form used by /login and /signup. The two pages
 * differ only in submit behaviour (signInWithPassword vs signUp) — keeping
 * the form here avoids duplicating layout / validation / error handling.
 */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface Props {
  mode: "login" | "signup";
}

export function AuthForm({ mode }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);

    const supabase = createClient();
    try {
      if (mode === "signup") {
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (err) throw err;
        // Supabase free tier may require email confirmation. In dev we
        // also auto-sign-in if the project's email confirmation is OFF.
        const { data: session } = await supabase.auth.getSession();
        if (session.session) {
          router.replace(next);
        } else {
          setInfo("Account created. Check your email to confirm and then sign in.");
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (err) throw err;
        router.replace(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const isLogin = mode === "login";

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{isLogin ? "Sign in" : "Create your account"}</h1>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {isLogin
            ? "Welcome back. Enter your credentials to continue."
            : "Free forever — no credit card needed."}
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

      <div className="space-y-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          Password
        </label>
        <input
          type="password"
          required
          autoComplete={isLogin ? "current-password" : "new-password"}
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
          placeholder={isLogin ? "Your password" : "At least 6 characters"}
        />
      </div>

      {error && (
        <div className="rounded-md border border-rose-700 bg-rose-950/40 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}
      {info && (
        <div className="rounded-md border border-emerald-700 bg-emerald-950/40 p-3 text-xs text-emerald-300">
          {info}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="flex h-10 w-full items-center justify-center rounded-md bg-[var(--accent)] text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (isLogin ? "Signing in…" : "Creating account…") : isLogin ? "Sign in" : "Create account"}
      </button>

      {isLogin && (
        <div className="text-center text-xs">
          <Link
            href="/forgot-password"
            className="text-[var(--text-muted)] hover:text-[var(--accent)] hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
      )}

      <div className="text-center text-xs text-[var(--text-muted)]">
        {isLogin ? (
          <>
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-[var(--accent)] hover:underline">
              Sign up
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
              Sign in
            </Link>
          </>
        )}
      </div>
    </form>
  );
}
