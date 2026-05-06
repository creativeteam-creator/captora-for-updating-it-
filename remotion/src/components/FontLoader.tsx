"use client";

import { useEffect, useState } from "react";
import { delayRender, continueRender } from "remotion";
import { GOOGLE_FONTS_URL } from "../lib/fonts";

interface CustomFont {
  family: string;
  url: string;
  format: "ttf" | "otf" | "woff" | "woff2";
}

interface Props {
  /** User-uploaded fonts injected via @font-face. Loaded in parallel with
   *  the curated Google Fonts URL. */
  customFonts?: CustomFont[];
}

/**
 * Inject the Google Fonts stylesheet + any user-uploaded @font-face rules
 * into the Remotion bundle's document head and block frame rendering
 * until everything finishes loading. Without this, render Chromium would
 * substitute system fonts mid-render and the MP4 wouldn't match the
 * editor preview.
 *
 * Mount once at composition root. Multiple mounts share the same `<link>`
 * + `<style>` elements via `data-` attribute lookup, so re-mounts during
 * Player scrubbing don't refetch.
 */
export function FontLoader({ customFonts }: Props) {
  const [handle] = useState(() => delayRender("loading fonts"));

  useEffect(() => {
    let cancelled = false;
    const tasks: Promise<void>[] = [];

    // ── Google Fonts stylesheet (curated catalogue) ─────────────────────
    const existing = document.querySelector<HTMLLinkElement>(
      `link[data-captora-fonts]`
    );
    if (!existing) {
      tasks.push(
        new Promise<void>((resolve) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = GOOGLE_FONTS_URL;
          link.dataset.captoraFonts = "1";
          link.crossOrigin = "anonymous";
          link.onload = () => resolve();
          link.onerror = () => {
            console.warn("[FontLoader] Google Fonts failed — using fallbacks");
            resolve();
          };
          document.head.appendChild(link);
        })
      );
    }

    // ── User-uploaded fonts (per-render @font-face) ─────────────────────
    if (customFonts && customFonts.length > 0) {
      // Group all per-render @font-face rules into a single <style> tag
      // keyed by signature so re-mounts don't duplicate.
      const sig = customFonts.map((f) => `${f.family}|${f.url}`).join(";;");
      const tagId = "captora-custom-fonts";
      const old = document.getElementById(tagId) as HTMLStyleElement | null;
      if (!old || old.dataset.sig !== sig) {
        if (old) old.remove();
        const style = document.createElement("style");
        style.id = tagId;
        style.dataset.sig = sig;
        style.textContent = customFonts.map(faceCss).join("\n");
        document.head.appendChild(style);
      }
      // Wait for FontFace API to load each, so the renderer captures
      // glyphs instead of fallbacks.
      tasks.push(
        Promise.all(
          customFonts.map((f) =>
            // `document.fonts.load` resolves once the family is usable
            // at any size — we ask for a generic size as the probe.
            (document.fonts as FontFaceSet).load(`16px '${f.family}'`).catch(() => {})
          )
        ).then(() => undefined)
      );
    }

    Promise.all(tasks).finally(() => {
      if (!cancelled) continueRender(handle);
    });

    return () => {
      cancelled = true;
    };
  }, [handle, customFonts]);

  return null;
}

function faceCss(font: CustomFont): string {
  const cssFormat =
    font.format === "ttf"
      ? "truetype"
      : font.format === "otf"
      ? "opentype"
      : font.format === "woff"
      ? "woff"
      : "woff2";
  return `@font-face {
  font-family: '${font.family.replace(/'/g, "\\'")}';
  src: url('${font.url}') format('${cssFormat}');
  font-display: swap;
}`;
}
