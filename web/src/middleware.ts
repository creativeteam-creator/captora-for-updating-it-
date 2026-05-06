/**
 * Captora — Next.js middleware. Runs on every request matched by the
 * `matcher` config below. Delegates to `updateSession` which:
 *   - Refreshes Supabase auth cookies
 *   - Redirects unauthenticated users to /login
 *   - Bounces signed-in users away from /login + /signup
 */

import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on every path EXCEPT static assets, image optimisation, and
    // favicon — those don't need session refresh.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
