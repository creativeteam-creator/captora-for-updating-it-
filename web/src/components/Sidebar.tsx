"use client";

/**
 * Left navigation rail. Captora home layout:
 *   - Brand at top
 *   - Primary nav (Home / Recent / Academy / Manage / Help)
 *   - Plan + storage card pinned at the bottom
 *
 * Routes are stubs for now — only Home is actually wired up. Clicking the
 * other items keeps the page at "/" but updates the active tab visually so
 * the user doesn't think the buttons are dead.
 */

import { useState } from "react";
import { useUser, userInitials } from "@/lib/useUser";

type NavId = "home" | "recent" | "academy" | "manage" | "help";

const NAV_ITEMS: Array<{ id: NavId; label: string; icon: string; badge?: string }> = [
  { id: "home",    label: "Home",                icon: "home" },
  { id: "recent",  label: "Recent Projects",     icon: "clock" },
  { id: "academy", label: "Academy",             icon: "book", badge: "NEW" },
  { id: "manage",  label: "Manage Subscription", icon: "card" },
  { id: "help",    label: "Help & Support",      icon: "ring" },
];

function NavIcon({ name }: { name: string }) {
  const common = "h-5 w-5";
  switch (name) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={common}>
          <path d="M3 11l9-8 9 8M5 10v10h14V10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "clock":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" strokeLinecap="round" />
        </svg>
      );
    case "book":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={common}>
          <path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2V5z" strokeLinejoin="round" />
          <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round" />
        </svg>
      );
    case "card":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={common}>
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M3 10h18M7 15h3" strokeLinecap="round" />
        </svg>
      );
    case "ring":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}

interface PlanInfo {
  name: string;
  storageUsedGb: number;
  storageTotalGb: number;
  translationHrsRemaining: number;
  transcriptionHrsRemaining: number;
  transcriptionMinsRemaining: number;
}

const MOCK_PLAN: PlanInfo = {
  name: "Local Dev",
  storageUsedGb: 0.1,
  storageTotalGb: 5,
  translationHrsRemaining: 99,
  transcriptionHrsRemaining: 99,
  transcriptionMinsRemaining: 0,
};

export function Sidebar() {
  const [active, setActive] = useState<NavId>("home");
  const { user } = useUser();

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border)]">
      {/* Brand */}
      <div className="flex h-16 items-center px-6">
        <span className="text-2xl font-bold tracking-tight">
          C<span className="text-[var(--accent)]">a</span>pt<span className="text-[var(--accent)]">o</span>ra
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const selected = active === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActive(item.id)}
              className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${
                selected
                  ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              }`}
            >
              <NavIcon name={item.icon} />
              <span className="flex-1">{item.label}</span>
              {item.badge && (
                <span className="rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold text-white">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Plan card */}
      <div className="px-4 pb-4">
        <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-muted)] uppercase tracking-wide">Plan</span>
            <span className="font-semibold text-[var(--text)]">{MOCK_PLAN.name}</span>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[var(--text-muted)]">
              <span>Storage</span>
              <span>
                <span className="text-[var(--text)] font-medium">{MOCK_PLAN.storageUsedGb.toFixed(1)} GB</span>
                {" "}/ {MOCK_PLAN.storageTotalGb.toFixed(1)} GB
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg)]">
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${(MOCK_PLAN.storageUsedGb / MOCK_PLAN.storageTotalGb) * 100}%` }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[var(--text-muted)]">
              <span>Translation</span>
              <span className="text-[var(--text)] font-medium">{MOCK_PLAN.translationHrsRemaining} hrs left</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg)]">
              <div className="h-full w-full rounded-full bg-[var(--accent)]" />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[var(--text-muted)]">
              <span>Transcription</span>
              <span className="text-[var(--text)] font-medium">
                {MOCK_PLAN.transcriptionHrsRemaining}h left
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg)]">
              <div className="h-full w-full rounded-full bg-[var(--accent)]" />
            </div>
          </div>
        </div>
      </div>

      {/* User row + logout — pinned below the plan card. Real user data
          from Supabase via useUser(); falls back to "?" while loading. */}
      <div className="border-t border-[var(--border)] px-4 py-3">
        <form action="/auth/signout" method="post" className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-xs font-bold text-[var(--text)]">
            {userInitials(user)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-[var(--text)]">
              {user?.email ?? "Loading…"}
            </div>
            <div className="text-[10px] text-[var(--text-muted)]">Signed in</div>
          </div>
          <button
            type="submit"
            title="Sign out"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-rose-400"
            aria-label="Sign out"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>
    </aside>
  );
}
