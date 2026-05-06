import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signedUrl } from "./storage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = SupabaseClient<any, any, any>;

/**
 * Download a private Supabase Storage object straight to disk.
 *
 * Large source files can be up to 2 GB, so avoid `download().arrayBuffer()`
 * here; that would hold the entire media file in Node memory. A signed URL
 * lets native fetch stream bytes directly into a write stream.
 */
export async function downloadToFile(
  supabase: Sb,
  bucket: string,
  path: string,
  destination: string
): Promise<void> {
  const url = await signedUrl(supabase, bucket, path, 60 * 30);
  if (!url) {
    throw new Error(`Could not create signed URL for ${bucket}/${path}`);
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`storage download (${bucket}/${path}): HTTP ${res.status}`);
  }

  await pipeline(
    Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream),
    createWriteStream(destination)
  );
}
