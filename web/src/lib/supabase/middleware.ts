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
  // /api/glossary used to be listed here. It was exempted so the editor's
  // fetch wouldn't be REDIRECTED to /login and get HTML back — but the
  // exemption also let unauthenticated callers reach the route, which
  // falls back to writing a JSON file on the server when there's no user.
  // The real problem was the redirect, not the gate, and API routes now
  // get a 401 instead (see below). So nothing needs exempting.
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * API routes must never be answered with a redirect. A `fetch()` follows
 * a 302 transparently, so the caller ends up parsing the login page's
 * HTML as JSON and reports a confusing syntax error instead of "you're
 * signed out". A 401 says exactly what happened and matches what every
 * route handler already returns for itself.
 */
function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}


export async function updateSession(request: NextRequest) {
  // Defensive: if env vars aren't bundled correctly (Electron build with
  // missing .env.production, or a misconfigured server), don't try to
  // construct the Supabase client — that would throw mid-middleware and
  // produce the dreaded ERR_HTTP_HEADERS_SENT cascade. Instead, let the
  // request through; the page will then show its own error UI that the
  // user can read.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error(
      "[middleware] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY — auth gate disabled"
    );
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  try {
    const supabase = createServerClient<Database>(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    });

    // IMPORTANT: do NOT remove getUser() — it's what refreshes the cookies.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const pathname = request.nextUrl.pathname;
    const isPublic = isPublicPath(pathname);

    if (!user && !isPublic) {
      if (isApiPath(pathname)) {
        return NextResponse.json(
          { ok: false, error: "Not signed in" },
          { status: 401 }
        );
      }
      // Anonymous → /login, with the original target as `next` so we can
      // bounce them back after sign-in.
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(redirectUrl);
    }

    if (user && (pathname === "/login" || pathname === "/signup")) {
      // Already signed in → don't show the auth screens, send them home.
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/";
      return NextResponse.redirect(redirectUrl);
    }

    return response;
  } catch (err) {
    // Belt-and-suspenders — any unhandled error in the auth flow falls
    // through to letting the page render its own state. Better than a
    // 500 with ERR_HTTP_HEADERS_SENT that gives users no clue what's
    // wrong.
    console.error("[middleware] auth flow failed:", err);
    return response;
  }
}
