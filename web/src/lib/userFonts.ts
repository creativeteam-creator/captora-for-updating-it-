/**
 * Custom user-uploaded fonts. Backed by the `user_fonts` table + the
 * `captora-fonts` storage bucket (see supabase/migrations/002_user_fonts.sql).
 *
 * Flow:
 *   1. user picks a .ttf / .otf / .woff / .woff2 file
 *   2. uploadFont(file, family) writes to storage + inserts a row
 *   3. listUserFonts() pulls a fresh list with signed URLs for @font-face
 *   4. when the user picks the font in the editor, the URL is injected
 *      via @font-face on the web side (live preview) and forwarded to the
 *      Remotion render via inputProps.customFonts
 */

"use client";

import { createClient } from "./supabase/client";

export interface UserFont {
  id: string;
  family: string;             // e.g. "Acme Display"
  storagePath: string;        // "<user_id>/<font_id>.ttf"
  format: "ttf" | "otf" | "woff" | "woff2";
  url: string | null;         // signed URL for @font-face / fetch
  createdAt: number;
}

const FONTS_BUCKET = "captora-fonts";

/** Map a file extension to the CSS `format()` token used in @font-face. */
const EXT_TO_FORMAT: Record<string, UserFont["format"]> = {
  ttf: "ttf",
  otf: "otf",
  woff: "woff",
  woff2: "woff2",
};

export async function listUserFonts(): Promise<UserFont[]> {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb
    .from("user_fonts")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[userFonts] list failed:", error.message);
    return [];
  }
  type Row = {
    id: string;
    family: string;
    storage_path: string;
    format: UserFont["format"];
    created_at: string;
  };
  const rows = (data ?? []) as Row[];

  // Resolve signed URLs in parallel.
  const fonts: UserFont[] = await Promise.all(
    rows.map(async (row) => {
      const { data: signed } = await sb.storage
        .from(FONTS_BUCKET)
        .createSignedUrl(row.storage_path, 60 * 60 * 24); // 24 h
      return {
        id: row.id,
        family: row.family,
        storagePath: row.storage_path,
        format: row.format,
        url: signed?.signedUrl ?? null,
        createdAt: new Date(row.created_at).getTime(),
      };
    })
  );
  return fonts;
}

/**
 * Upload a font file. The display `family` is what the user types into the
 * editor's "Family name" prompt — captions reference fonts by this name,
 * so it must match how they're embedded in @font-face. We don't try to
 * extract the family from the file's metadata (would need an OpenType
 * parser); user-supplied is safer.
 */
export async function uploadFont(file: File, family: string): Promise<UserFont> {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data: userRes } = await sb.auth.getUser();
  const userId = userRes?.user?.id as string | undefined;
  if (!userId) throw new Error("Not signed in");

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const format = EXT_TO_FORMAT[ext];
  if (!format) {
    throw new Error(`Unsupported font format ".${ext}". Use .ttf / .otf / .woff / .woff2`);
  }
  const trimmedFamily = family.trim();
  if (!trimmedFamily) throw new Error("Font family name is required");

  // Generate the row id up-front so the storage path matches the DB row.
  const id = crypto.randomUUID();
  const storagePath = `${userId}/${id}.${ext}`;

  // 1. Upload bytes
  const { error: uploadErr } = await sb.storage
    .from(FONTS_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || `font/${ext}`,
      upsert: false,
    });
  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

  // 2. Insert row
  const { error: insertErr } = await sb.from("user_fonts").insert({
    id,
    user_id: userId,
    family: trimmedFamily,
    storage_path: storagePath,
    format,
  });
  if (insertErr) {
    // Best-effort cleanup of the orphaned storage object.
    sb.storage.from(FONTS_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(`DB insert failed: ${insertErr.message}`);
  }

  // 3. Return the freshly-uploaded font with a signed URL.
  const { data: signed } = await sb.storage
    .from(FONTS_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24);

  return {
    id,
    family: trimmedFamily,
    storagePath,
    format,
    url: signed?.signedUrl ?? null,
    createdAt: Date.now(),
  };
}

export async function deleteUserFont(id: string, storagePath: string): Promise<void> {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { error } = await sb.from("user_fonts").delete().eq("id", id);
  if (error) throw new Error(`deleteUserFont: ${error.message}`);
  // Best-effort storage cleanup.
  sb.storage.from(FONTS_BUCKET).remove([storagePath]).catch(() => {});
}

/**
 * Build a CSS @font-face block for a user font. Used by the editor to
 * inject custom fonts into the document head live as the user picks them.
 */
export function fontFaceCss(font: UserFont): string {
  if (!font.url) return "";
  const cssFormat =
    font.format === "ttf" ? "truetype" :
    font.format === "otf" ? "opentype" :
    font.format === "woff" ? "woff" :
    "woff2";
  return `@font-face {
  font-family: '${font.family.replace(/'/g, "\\'")}';
  src: url('${font.url}') format('${cssFormat}');
  font-display: swap;
}`;
}
