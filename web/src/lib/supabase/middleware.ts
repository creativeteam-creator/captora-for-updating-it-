/**
 * Helpers for the Next.js middleware to refresh the Supabase session and
 * route unauthenticated users to /login.
 *
 * The middleware runs on every request — its job is to:
 *   1. Refresh the auth tokens stored in cookies (Supabase rotates them)
 *   2. Redirect to /login if the user is not signed in and the route is
 *      protected (everything except /login, /signup, /auth/*, public assets)
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./types";

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",   // request a recovery email — no session yet
  "/auth",              // /auth/callback, /auth/confirm, etc.
  // /reset-password is intentionally NOT public — by the time the user
  // gets there, /auth/callback has already exchanged the recovery code
  // for a session, so the standard auth gate works.
  //
  // Internal server-side API routes — called from the editor JS which
  // may fire before the Supabase cookie is refreshed (e.g. glossary saves).
  "/api/glossary",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}


export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do NOT remove getUser() — it's what refreshes the cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublic = isPublicPath(pathname);

  if (!user && !isPublic) {
    // Anonymous → /login, with the original target as `next` so we can
    // bounce them back after sign-in.
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    // Already signed in → don't show the auth screens, send them home.
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}
