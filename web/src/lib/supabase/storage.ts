/**
 * Supabase Storage helpers — uploading source media, thumbnails, and
 * rendered MP4s. Path convention enforced by RLS:
 *
 *     <bucket>/<user_id>/<project_id>.<ext>
 *
 * The user-id prefix is what the storage RLS policies check, so files are
 * scoped per-user automatically. `(storage.foldername(name))[1]` in the
 * SQL migration extracts the user-id from the path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const SOURCE_BUCKET = "captora-source";
export const RENDERS_BUCKET = "captora-renders";
export const THUMBNAILS_BUCKET = "captora-thumbnails";
export const MAX_SOURCE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Storage helpers don't need DB-schema typing — they only touch
// `supabase.storage.*`. Loosen the generics so both the browser client
// and the server (cookie-bridged) client satisfy the constraint without
// fighting TypeScript over @supabase/ssr generic mismatches.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = SupabaseClient<any, any, any>;

export function sourcePath(userId: string, projectId: string, ext: string): string {
  return `${userId}/${projectId}${normaliseExt(ext)}`;
}
/**
 * Rendered-output path. Takes the real extension because transparent
 * exports are ProRes in a `.mov` container, not H.264 in `.mp4`.
 *
 * This used to hard-code `.mp4`, so a transparent render was stored under
 * an .mp4 name with a `video/mp4` content type. Downloading it from
 * Recent Videos handed the user a ProRes file that most players refuse to
 * open, for no reason other than the label.
 *
 * Defaults to `.mp4` so existing callers and existing rows keep resolving
 * to the same key they always did.
 */
export function renderPath(
  userId: string,
  projectId: string,
  ext: string = ".mp4"
): string {
  return `${userId}/${projectId}${normaliseExt(ext)}`;
}

/** Extensions a render can be written as — used when cleaning up a
 *  deleted project, where we don't know which one was produced. */
export const RENDER_EXTS = [".mp4", ".mov"] as const;

/** Content type matching a rendered file's container. */
export function renderContentType(ext: string): string {
  return normaliseExt(ext) === ".mov" ? "video/quicktime" : "video/mp4";
}
export function thumbnailPath(userId: string, projectId: string): string {
  return `${userId}/${projectId}.jpg`;
}

function normaliseExt(ext: string): string {
  if (!ext) return "";
  return ext.startsWith(".") ? ext : `.${ext}`;
}

interface UploadResult {
  path: string;
}

/**
 * Upload a Blob/Buffer/File to a bucket. `upsert: true` so re-uploading
 * the same key (e.g. re-rendering a project) replaces cleanly.
 */
async function uploadBlob(
  supabase: Sb,
  bucket: string,
  path: string,
  body: Blob | Buffer | ArrayBuffer | Uint8Array,
  contentType: string
): Promise<UploadResult> {
  const { error } = await supabase.storage.from(bucket).upload(path, body, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`storage upload (${bucket}/${path}): ${error.message}`);
  return { path };
}

export async function uploadRender(
  supabase: Sb,
  userId: string,
  projectId: string,
  body: Blob | Buffer,
  /** Container the render was actually written as — ".mp4" for H.264,
   *  ".mov" for transparent ProRes. */
  ext: string = ".mp4"
): Promise<UploadResult> {
  return uploadBlob(
    supabase,
    RENDERS_BUCKET,
    renderPath(userId, projectId, ext),
    body,
    renderContentType(ext)
  );
}

export async function uploadThumbnail(
  supabase: Sb,
  userId: string,
  projectId: string,
  dataUrl: string
): Promise<UploadResult | null> {
  // Data URL → bytes. Skip silently if the input isn't a valid data URL —
  // thumbnails are nice-to-have, not load-bearing.
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  return uploadBlob(supabase, THUMBNAILS_BUCKET, thumbnailPath(userId, projectId), buf, m[1]);
}

/**
 * Time-limited signed URL for downloading from a private bucket. Buckets
 * are private by default in our schema; clients fetch via these URLs.
 */
export async function signedUrl(
  supabase: Sb,
  bucket: string,
  path: string,
  expiresInSec = 60 * 60 // 1 hour
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSec);
  if (error) {
    console.warn(`[storage] signedUrl failed (${bucket}/${path}):`, error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * Browser-side direct upload of the user's source file straight to
 * Supabase Storage. Bypasses /api/transcribe's body so we never push
 * gigabyte-sized multipart streams through Next.js — the dev server's
 * undici layer chokes on those with `expected CRLF` parser errors.
 *
 * Returns the storage path on success. The caller is responsible for
 * deleting the object if the subsequent transcribe call fails.
 *
 * `onProgress` (optional) reports bytes uploaded so the UI can show
 * a progress bar — supabase-js v2 emits these via the upload's
 * underlying XHR.
 */
export async function uploadSourceFromBrowser(
  supabase: Sb,
  userId: string,
  projectId: string,
  ext: string,
  file: File
): Promise<string> {
  if (file.size > MAX_SOURCE_UPLOAD_BYTES) {
    throw new Error("Source file is larger than 2 GB. Please upload a file up to 2 GB.");
  }

  // ── Local dev bypass (chunked) ────────────────────────────────────────
  // Next.js 15 dev server (undici) silently truncates raw binary request
  // bodies above a few MB — a 500 MB clinic recording was arriving as only
  // ~5 seconds of audio. Chunked upload splits the file into 8 MB pieces
  // so each POST body stays well under the limit, then the server
  // reassembles them into the full file before transcription.
  //
  // Enable with: NEXT_PUBLIC_LOCAL_UPLOAD=true in web/.env.local
  if (process.env.NEXT_PUBLIC_LOCAL_UPLOAD === "true") {
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
    const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    console.log(
      `[upload-local] uploading ${(file.size / 1024 / 1024).toFixed(1)} MB in ${total} chunk(s)`
    );

    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end   = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const qs =
        `?projectId=${encodeURIComponent(projectId)}` +
        `&ext=${encodeURIComponent(ext)}` +
        `&chunk=${i}` +
        `&total=${total}`;

      const res = await fetch(`/api/upload-local${qs}`, {
        method: "POST",
        body: chunk,
        headers: { "Content-Type": "application/octet-stream" },
      });

      let json: { ok: boolean; error?: string; path?: string } = { ok: false };
      try { json = await res.json(); } catch { /* ignore */ }

      if (!res.ok || !json.ok) {
        throw new Error(
          `source upload (chunk ${i + 1}/${total}): ${json.error ?? `HTTP ${res.status}`}`
        );
      }

      // The last chunk response carries the assembled file's storage path.
      if (i === total - 1) {
        return json.path as string;
      }
    }

    // Unreachable when total >= 1, but satisfies TypeScript.
    return `${userId}/${projectId}${ext}`;
  }

  // ── Production: Supabase Storage ─────────────────────────────────────
  const path = sourcePath(userId, projectId, ext);
  const { error } = await supabase.storage.from(SOURCE_BUCKET).upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`source upload: ${error.message}`);
  return path;
}

