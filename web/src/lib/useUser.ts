"use client";

/**
 * Reactive hook around Supabase's auth state. Returns `null` while
 * loading, then the User (or null if signed out). Subscribes to auth
 * changes so logout / token refresh updates the UI immediately.
 */

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function useUser(): { user: User | null; loading: boolean } {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    let mounted = true;
    // `mounted` only guards against unmount — it says nothing about
    // ORDER. onAuthStateChange fires synchronously off Supabase's
    // cross-tab storage-event broadcast, so a sign-out in another tab
    // can land here before this tab's own initial getUser() network
    // round-trip resolves. Without this flag, that getUser() response
    // — now stale — would land afterward and unconditionally overwrite
    // the correct (signed-out) state with the cached user it fetched
    // before the sign-out happened. `receivedAuthEvent` makes the first
    // real auth event authoritative and makes the initial fetch a
    // no-op once one has arrived.
    let receivedAuthEvent = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted || receivedAuthEvent) return;
      setUser(data.user);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      receivedAuthEvent = true;
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}

/** Initials from email — falls back to "??" if no email. */
export function userInitials(user: User | null): string {
  if (!user?.email) return "??";
  const local = user.email.split("@")[0];
  // For emails like "ravi.kumar" we want "RK"; "tarun" → "TA"; "qhtclinic" → "QH".
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}
