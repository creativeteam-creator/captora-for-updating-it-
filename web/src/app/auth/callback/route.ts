/**
 * Email-confirm + magic-link callback. Supabase's confirmation email links
 * here with `?code=...&next=...`. We exchange the code for a session
 * cookie, then redirect to `next` (defaults to home).
 */

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("[/auth/callback] exchange failed:", error.message);
  }

  // Fall through to login on any error.
  return NextResponse.redirect(`${origin}/login`);
}
