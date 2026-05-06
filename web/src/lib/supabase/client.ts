/**
 * Browser-side Supabase client. Used by client components / hooks for
 * realtime subscriptions, auth state, and direct queries scoped to the
 * logged-in user via Row Level Security.
 *
 * Reads the public anon key — safe to expose to the browser. RLS policies
 * defined in the schema enforce per-user access.
 */

"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./types";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
