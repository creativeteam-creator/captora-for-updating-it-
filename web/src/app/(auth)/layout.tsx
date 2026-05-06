/**
 * Layout for /login + /signup. Centred Captora-branded card on a dark
 * background. Lives in a `(auth)` route group so it doesn't share the
 * sidebar+topbar shell of the main editor.
 */

import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-3xl font-bold tracking-tight">
            C<span className="text-[var(--accent)]">a</span>pt<span className="text-[var(--accent)]">o</span>ra
          </span>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Viral-style auto-captions for your videos
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-2xl">
          {children}
        </div>
      </div>
    </div>
  );
}
