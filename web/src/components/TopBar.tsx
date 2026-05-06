"use client";

/**
 * Top header — global search box on the left, user-initials avatar on the
 * right. Search is a stub: it filters the in-memory recent-videos list when
 * a callback is wired but does no remote search.
 */

import { useEffect, useState } from "react";
import { useUser, userInitials } from "@/lib/useUser";

interface Props {
  onSearch?: (query: string) => void;
}

export function TopBar({ onSearch }: Props) {
  const [query, setQuery] = useState("");
  const { user } = useUser();
  const initials = userInitials(user);

  useEffect(() => {
    onSearch?.(query);
  }, [query, onSearch]);

  return (
    <div className="flex h-16 items-center gap-4 border-b border-[var(--border)] bg-[var(--bg)] px-6">
      <div className="relative flex-1 max-w-2xl">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.5-4.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title.."
          className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-10 pr-16 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
          ⌘K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-xs font-bold text-[var(--text)] hover:bg-[var(--bg-hover)]"
        >
          {initials}
        </button>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-[var(--text-muted)]">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
