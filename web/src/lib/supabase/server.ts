/**
 * Server-side Supabase client. Used by:
 *   - API routes (`/api/*`) that need to verify the user's session and
 *     query/mutate on their behalf
 *   - Server Components / Actions that read user data
 *
 * Cookies bridge the auth session between Next.js's req/res and Supabase
 * SDK. The `@supabase/ssr` package wires this up so RLS-scoped queries
 * "just work" — `auth.uid()` in policies maps to the logged-in user.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./types";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // `setAll` was called from a Server Component — Next.js doesn't
            // allow cookie writes there. Middleware refreshes the session
            // separately, so this is non-fatal.
          }
        },
      },
    }
  );
}

/**
 * Service-role client for trusted server-only operations that must bypass
 * RLS (e.g. background workers, admin tasks). Uses the service role key
 * — NEVER expose this to the browser or commit to git.
 */
export function createServiceClient() {
  // Lazy import the JS-only SDK because it doesn't need cookie handling.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient: createJsClient } = require("@supabase/supabase-js");
  return createJsClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
