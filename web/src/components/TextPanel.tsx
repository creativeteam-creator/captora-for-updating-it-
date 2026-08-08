"use client";

/**
 * Right-panel "Text" tab — granular controls on top of the chosen template.
 * Edits flow upward as `CaptionStyleOverrides`. The parent merges them with
 * the active preset before passing the result to the preview + render.
 *
 * Phase 3a controls:
 *   - Font family (free-text)
 *   - Font Size (slider + numeric)
 *   - Vertical Position (slider, 0–100% of frame height)
 *   - Highlight color
 *   - Letter spacing (stroke width as proxy, since we don't have a real
 *     letterSpacing prop on the composition yet — Phase 3b)
 *   - Drop Shadow toggle (binds shadowOpacity)
 */

import { useEffect, useRef, useState } from "react";
import {
  applyStyleOverrides,
  hexToRgb,
  rgbToHex,
  type CaptionStyle,
  type CaptionStyleOverrides,
} from "@/lib/styles";
import {
  FONTS,
  FONT_CATEGORY_LABELS,
  fontStack,
  type FontCategory,
} from "@captora/remotion";
import { deleteUserFont, uploadFont, type UserFont } from "@/lib/userFonts";
import { deleteTextPreset, listTextPresets, saveTextPreset, type TextPreset } from "@/lib/textPresets";

/**
 * Group the curated font catalogue by category so the dropdown shows
 * `<optgroup>`s (Display / Sans / Handwritten / etc.) instead of one flat
 * list of 25 names.
 */
const FONT_GROUPS: { category: FontCategory; fonts: typeof FONTS }[] = (() => {
  const map = new Map<FontCategory, typeof FONTS>();
  for (const font of FONTS) {
    if (!map.has(font.category)) map.set(font.category, []);
    map.get(font.category)!.push(font);
  }
  // Stable order — display first (most-used), Devanagari last.
  const order: FontCategory[] = ["display", "sans", "elegant", "handwritten", "mono", "devanagari"];
  return order
    .filter((c) => map.has(c))
    .map((c) => ({ category: c, fonts: map.get(c)! }));
})();

/**
 * Pick the closest catalogue font for an arbitrary `font-family` string —
 * used to resolve the saved style override (which may be a stack like
 * `"Anton, Montserrat, Inter, sans-serif"`) back to one of our options.
 */
function matchFontStack(value: string): string {
  const lower = value.toLowerCase();
  const hit = FONTS.find((f) => lower.includes(f.family.toLowerCase()));
  return hit ? fontStack(hit.family) : value;
}

interface Props {
  base: CaptionStyle;
  overrides: CaptionStyleOverrides;
  onChange: (next: CaptionStyleOverrides) => void;
  onReset: () => void;
  userFonts: UserFont[];
  onUserFontsChanged: () => void | Promise<void>;
}

export function TextPanel({ base, overrides, onChange, onReset, userFonts, onUserFontsChanged }: Props) {
  const merged = applyStyleOverrides(base, overrides);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<{ kind: "idle" | "uploading" | "error"; message?: string }>({ kind: "idle" });

  // ── My Presets — locally-saved snapshots of CaptionStyleOverrides ───────
  const [presets, setPresets] = useState<TextPreset[]>([]);
  // `savingPreset` toggles an inline name input. We don't use window.prompt()
  // here because Electron's BrowserWindow doesn't implement it — the call
  // returns null silently, so the previous prompt-driven save flow was a
  // dead-end in the packaged app.
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  useEffect(() => {
    setPresets(listTextPresets());
  }, []);

  // ── System fonts — enumerate the user's installed fonts via the
  // Local Font Access API (Chromium 103+, which is what Electron ships).
  // Result populates a new "System Fonts" optgroup in the font picker
  // so users can use any font already on their machine without having
  // to upload it as a .ttf/.otf first.
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => {
    // Type the API loosely — TS lib.dom doesn't ship the Local Font
    // Access API yet. Feature-detect via `in window` first.
    const w = window as unknown as {
      queryLocalFonts?: () => Promise<Array<{ family: string }>>;
    };
    if (typeof w.queryLocalFonts !== "function") return;
    w.queryLocalFonts()
      .then((data) => {
        // De-dup by family name (the API yields one entry per face).
        const families = new Set<string>();
        for (const f of data) {
          if (f?.family) families.add(f.family);
        }
        const sorted = Array.from(families).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "base" })
        );
        setSystemFonts(sorted);
      })
      .catch((err) => {
        // Permission denied / API blocked — silently skip; the
        // bundled + uploaded font sections still work as before.
        console.warn("[TextPanel] queryLocalFonts failed:", err);
      });
  }, []);

  const handleSavePreset = () => {
    // Toggle the inline name input. The old prompt-based flow was silently
    // broken in Electron (window.prompt is unimplemented and returns null),
    // so users tapped "Save" and nothing happened. Now we reveal an inline
    // text input + Save button beneath the row.
    setPresetName("");
    setSavingPreset(true);
  };

  const commitSavePreset = () => {
    const trimmed = presetName.trim();
    if (!trimmed) {
      setSavingPreset(false);
      return;
    }
    saveTextPreset(trimmed, overrides);
    setPresets(listTextPresets());
    setSavingPreset(false);
    setPresetName("");
  };

  const cancelSavePreset = () => {
    setSavingPreset(false);
    setPresetName("");
  };

  const handleApplyPreset = (preset: TextPreset) => {
    onChange(preset.overrides);
  };

  const handleDeletePreset = (preset: TextPreset) => {
    if (!window.confirm(`Delete preset "${preset.name}"?`)) return;
    deleteTextPreset(preset.id);
    setPresets(listTextPresets());
  };

  const set = <K extends keyof CaptionStyleOverrides>(key: K, value: CaptionStyleOverrides[K]) => {
    onChange({ ...overrides, [key]: value });
  };

  const handleUploadClick = () => fileInputRef.current?.click();

  /**
   * Strip variant suffixes from a filename to derive the family name when
   * uploading a folder. e.g. "Inter-BoldItalic.ttf" → "Inter".
   */
  const familyFromFilename = (name: string): string => {
    const stem = name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, "");
    // Strip trailing weight/style tokens. Order matters: longer first.
    const VARIANT_TOKENS = [
      "Thin", "ExtraLight", "UltraLight", "Light", "Regular", "Book", "Medium",
      "SemiBold", "DemiBold", "Bold", "ExtraBold", "UltraBold", "Black", "Heavy",
      "Italic", "Oblique",
    ];
    let result = stem;
    // Repeatedly strip trailing tokens (handles "Inter-BoldItalic" → "Inter")
    for (let i = 0; i < 3; i++) {
      let stripped = false;
      for (const token of VARIANT_TOKENS) {
        const re = new RegExp(`[-_\\s]?${token}$`, "i");
        if (re.test(result)) {
          result = result.replace(re, "");
          stripped = true;
          break;
        }
      }
      if (!stripped) break;
    }
    return result.trim() || stem;
  };

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file/folder later
    if (files.length === 0) return;

    // Single-file picker: prompt the user for a friendly family name (legacy flow).
    if (files.length === 1) {
      const file = files[0];
      const defaultName = familyFromFilename(file.name);
      const family = window.prompt(
        "Font family name (this is what captions reference):",
        defaultName
      );
      if (!family || !family.trim()) return;

      setUploadStatus({ kind: "uploading" });
      try {
        const uploaded = await uploadFont(file, family.trim());
        await onUserFontsChanged();
        setUploadStatus({ kind: "idle" });
        set("fontFamily", `'${uploaded.family}', ${matchFontStack(merged.fontFamily)}`);
      } catch (err) {
        // Log the full error so users can copy it from DevTools when
        // reporting "fonts don't import" — the visible UI message is
        // often truncated. Likely culprits surface here: missing
        // `user_fonts` table, RLS policy blocking insert, bucket
        // not created, or auth session expired.
        console.error("[TextPanel] font upload failed", err);
        const message = err instanceof Error ? err.message : "Upload failed";
        setUploadStatus({ kind: "error", message });
      }
      return;
    }

    // Folder / multi-file pick: derive the family from the first file's
    // stem and upload every variant under the same family. The browser
    // picks the right weight/style automatically via @font-face.
    const fontFiles = files.filter((f) =>
      /\.(ttf|otf|woff2?)$/i.test(f.name)
    );
    if (fontFiles.length === 0) {
      setUploadStatus({
        kind: "error",
        message: "No .ttf / .otf / .woff files found in selection",
      });
      return;
    }

    const inferredFamily = familyFromFilename(fontFiles[0].name);
    const family = window.prompt(
      `Family name for ${fontFiles.length} font files:`,
      inferredFamily
    );
    if (!family || !family.trim()) return;

    setUploadStatus({ kind: "uploading" });
    try {
      let firstUploaded: Awaited<ReturnType<typeof uploadFont>> | null = null;
      let errors = 0;
      for (const file of fontFiles) {
        try {
          const u = await uploadFont(file, family.trim());
          if (!firstUploaded) firstUploaded = u;
        } catch (err) {
          errors++;
          console.error(`[TextPanel] upload failed for ${file.name}:`, err);
        }
      }
      await onUserFontsChanged();
      setUploadStatus(
        errors > 0
          ? {
              kind: "error",
              message: `Uploaded ${fontFiles.length - errors}/${fontFiles.length} files (${errors} failed — check console)`,
            }
          : { kind: "idle" }
      );
      if (firstUploaded) {
        set("fontFamily", `'${firstUploaded.family}', ${matchFontStack(merged.fontFamily)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setUploadStatus({ kind: "error", message });
    }
  };

  const handleDeleteFont = async (font: UserFont) => {
    if (!window.confirm(`Delete font "${font.family}"?`)) return;
    try {
      await deleteUserFont(font.id, font.storagePath);
      await onUserFontsChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed";
      setUploadStatus({ kind: "error", message });
    }
  };

  const userFontValue = (font: UserFont) => `'${font.family}', sans-serif`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-semibold">Text</div>
        <button
          type="button"
          onClick={onReset}
          className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Reset
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* ── My Presets — save/load CaptionStyleOverrides snapshots ─── */}
        <ControlRow label="My Presets">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value=""
                onChange={(e) => {
                  const preset = presets.find((p) => p.id === e.target.value);
                  if (preset) handleApplyPreset(preset);
                  e.target.value = "";
                }}
                disabled={presets.length === 0}
                className="h-8 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
              >
                <option value="">
                  {presets.length === 0 ? "No saved presets" : "Apply preset…"}
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleSavePreset}
                className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                title="Save current settings as a new preset"
              >
                + Save
              </button>
            </div>
            {savingPreset && (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitSavePreset();
                    else if (e.key === "Escape") cancelSavePreset();
                  }}
                  placeholder="Preset name (overwrites if it exists)"
                  className="h-8 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={commitSavePreset}
                  className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-2.5 py-1 text-[11px] uppercase tracking-wide text-black hover:opacity-90"
                  title="Save preset"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={cancelSavePreset}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)] hover:border-[var(--border)] hover:text-[var(--text)]"
                  title="Cancel"
                >
                  Cancel
                </button>
              </div>
            )}
            {presets.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {presets.map((p) => (
                  // Pill = APPLY on click; the small × on the right
                  // deletes. Earlier the whole pill called delete which
                  // silently nuked the user's saved preset every time
                  // they tried to "apply" it.
                  <span
                    key={p.id}
                    className="inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)]"
                  >
                    <button
                      type="button"
                      onClick={() => handleApplyPreset(p)}
                      className="rounded-l-full px-2 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                      title={`Apply "${p.name}"`}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeletePreset(p)}
                      className="rounded-r-full border-l border-[var(--border-subtle)] px-1.5 py-0.5 opacity-60 hover:bg-red-500/10 hover:text-red-400 hover:opacity-100"
                      title={`Delete "${p.name}"`}
                      aria-label={`Delete ${p.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </ControlRow>

        {/* ── Sync — hoisted to the top so users can fix audio↔caption
            drift without hunting through nested sections. Previously
            lived inside the collapsed "Animation" section, which is
            why the "captions don't match audio" complaints kept
            coming even though the fix has always been one slider. */}
        <Section title="Caption Sync" defaultOpen>
        <ControlRow label="Lead / Lag (ms)">
          <div className="space-y-1">
            <SliderWithNumber
              value={-Math.round((merged.wordAnticipationSec ?? 0.10) * 1000)}
              min={-1000}
              max={1000}
              step={10}
              unit="ms"
              onChange={(v) => set("wordAnticipationSec", -v / 1000)}
            />
            <div className="text-[10px] text-[var(--text-muted)]">
              Negative = captions arrive earlier than the audio (recommended for Hindi / Hinglish, default −100 ms).
              Positive = captions arrive later. Adjust in 10 ms steps until the highlight lands on the spoken word.
            </div>
          </div>
        </ControlRow>
        </Section>

        <Section title="Font" defaultOpen>
        <ControlRow label="Family">
          <select
            value={matchFontStack(merged.fontFamily)}
            onChange={(e) => set("fontFamily", e.target.value)}
            // Render the option text in the option's own font so the user
            // sees a live preview while picking.
            style={{ fontFamily: matchFontStack(merged.fontFamily) }}
            className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          >
            {userFonts.length > 0 && (
              <optgroup label="My Fonts">
                {userFonts.map((font) => (
                  <option
                    key={font.id}
                    value={userFontValue(font)}
                    style={{ fontFamily: `'${font.family}', sans-serif` }}
                  >
                    {font.family}
                  </option>
                ))}
              </optgroup>
            )}
            {systemFonts.length > 0 && (
              // System fonts pulled at mount time via the Local Font
              // Access API. Falls before the bundled catalogue so users
              // see their installed fonts first — that's typically what
              // they reach for once "My Fonts" is empty.
              <optgroup label="System Fonts">
                {systemFonts.map((family) => (
                  <option
                    key={`sys-${family}`}
                    value={`'${family.replace(/'/g, "\\'")}', sans-serif`}
                    style={{ fontFamily: `'${family}', sans-serif` }}
                  >
                    {family}
                  </option>
                ))}
              </optgroup>
            )}
            {FONT_GROUPS.map((group) => (
              <optgroup key={group.category} label={FONT_CATEGORY_LABELS[group.category]}>
                {group.fonts.map((font) => (
                  <option
                    key={font.family}
                    value={fontStack(font.family)}
                    style={{ fontFamily: fontStack(font.family) }}
                  >
                    {font.family}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <input
            ref={fileInputRef}
            type="file"
            accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
            multiple
            onChange={handleFilePicked}
            className="hidden"
          />
          {/* Folder picker — `webkitdirectory` lets the user pick a whole
              font-family folder; the handler uploads every .ttf/.otf inside
              under one family name (so "Inter-Bold.ttf" + "Inter-Italic.ttf"
              etc. become a single Inter family with multiple variants). */}
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error — webkitdirectory not in the standard React
            // typings yet, but every Chromium-based browser (Electron) honours it.
            webkitdirectory=""
            directory=""
            multiple
            onChange={handleFilePicked}
            className="hidden"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploadStatus.kind === "uploading"}
              className="flex-1 rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
            >
              {uploadStatus.kind === "uploading" ? "Uploading…" : "+ File"}
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={uploadStatus.kind === "uploading"}
              className="flex-1 rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
              title="Pick a folder containing a font family — every .ttf/.otf inside is uploaded under one family name"
            >
              + Family Folder
            </button>
          </div>
          {uploadStatus.kind === "error" && (
            <div className="mt-1 text-[11px] text-red-400">{uploadStatus.message}</div>
          )}

          {userFonts.length > 0 && (
            <ul className="mt-2 space-y-1">
              {userFonts.map((font) => (
                <li
                  key={font.id}
                  className="flex items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px]"
                >
                  <span
                    className="truncate text-[var(--text)]"
                    style={{ fontFamily: `'${font.family}', sans-serif` }}
                  >
                    {font.family}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDeleteFont(font)}
                    className="text-[var(--text-muted)] hover:text-red-400"
                    aria-label={`Delete ${font.family}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ControlRow>

        <ControlRow label="Size">
          <SliderWithNumber
            value={merged.fontSize}
            min={32}
            max={160}
            step={2}
            onChange={(v) => set("fontSize", v)}
          />
        </ControlRow>
        </Section>

        <Section title="Position" defaultOpen>
        <ControlRow label="Position Y">
          <SliderWithNumber
            value={Math.round(merged.verticalPosition * 100)}
            min={10}
            max={95}
            step={1}
            unit="%"
            onChange={(v) => set("verticalPosition", v / 100)}
          />
        </ControlRow>

        <ControlRow label="Position X">
          <SliderWithNumber
            value={Math.round((merged.horizontalPosition ?? 0.5) * 100)}
            min={5}
            max={95}
            step={1}
            unit="%"
            onChange={(v) => set("horizontalPosition", v / 100)}
          />
        </ControlRow>
        </Section>

        <Section title="Style" defaultOpen>
        {/* ── Text Style — bold / italic / underline / case ──────────── */}
        <ControlRow label="Style">
          <div className="flex items-center gap-1">
            <StyleToggle
              label="B"
              title="Bold"
              bold
              active={merged.bold !== false}
              onChange={(v) => set("bold", v)}
            />
            <StyleToggle
              label="I"
              title="Italic"
              italic
              active={!!merged.italic}
              onChange={(v) => set("italic", v)}
            />
            <StyleToggle
              label="U"
              title="Underline"
              underline
              active={!!merged.underline}
              onChange={(v) => set("underline", v)}
            />
            <div className="ml-1 inline-flex rounded-md border border-[var(--border-subtle)] overflow-hidden">
              {(["upper", "sentence", "lower"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`px-2 py-1 text-[10px] uppercase tracking-wide ${
                    (merged.textCase ?? "upper") === c
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  }`}
                  title={c === "upper" ? "ALL CAPS" : c === "lower" ? "lowercase" : "Sentence case"}
                  onClick={() => set("textCase", c)}
                >
                  {c === "upper" ? "AA" : c === "lower" ? "aa" : "Aa"}
                </button>
              ))}
            </div>
          </div>
        </ControlRow>

        {/* ── Alignment (left/center/right) ──────────────────────────── */}
        <ControlRow label="Align">
          <div className="inline-flex rounded-md border border-[var(--border-subtle)] overflow-hidden">
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={`px-3 py-1 text-[11px] ${
                  (merged.textAlign ?? "center") === a
                    ? "bg-[var(--accent)] text-black"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
                title={`Align ${a}`}
                onClick={() => set("textAlign", a)}
              >
                {a === "left" ? "⟸" : a === "right" ? "⟹" : "≡"}
              </button>
            ))}
          </div>
        </ControlRow>
        </Section>

        <Section title="Spacing" defaultOpen={false}>
        {/* ── Letter spacing ─────────────────────────────────────────── */}
        <ControlRow label="Letter Spacing">
          <SliderWithNumber
            value={merged.letterSpacing ?? 0}
            min={-2}
            max={20}
            step={0.5}
            unit="px"
            onChange={(v) => set("letterSpacing", v)}
          />
        </ControlRow>

        {/* ── Line spacing (line-height multiplier) ─────────────────── */}
        <ControlRow label="Line Spacing">
          <SliderWithNumber
            value={Math.round((merged.lineHeight ?? 1.05) * 100)}
            min={80}
            max={200}
            step={5}
            unit="%"
            onChange={(v) => set("lineHeight", v / 100)}
          />
        </ControlRow>
        </Section>

        <Section title="Color" defaultOpen>
        <ControlRow label="Highlight Color">
          <ColorInput
            value={rgbToHex(merged.highlightColor)}
            onChange={(hex) => {
              const rgb = hexToRgb(hex);
              if (rgb) set("highlightColor", rgb);
            }}
          />
        </ControlRow>

        <ControlRow label="Base Color">
          <ColorInput
            value={rgbToHex(merged.baseColor)}
            onChange={(hex) => {
              const rgb = hexToRgb(hex);
              if (rgb) set("baseColor", rgb);
            }}
          />
        </ControlRow>

        <ControlRow label="Stroke">
          <SliderWithNumber
            value={merged.strokeWidth}
            min={0}
            max={16}
            step={1}
            onChange={(v) => set("strokeWidth", v)}
          />
        </ControlRow>
        </Section>

        <Section title="Emphasis" defaultOpen>
        {/* Emphasize / Spotlight — matches Kalakar's EMPHASIS section
            toggle. "Emphasize" (default) makes the active word brighter
            and optionally bigger. "Spotlight" leaves the active word
            untouched and DIMS every other word in the phrase so the
            spoken one reads as the focal point without changing its
            colour/size. */}
        <ControlRow label="Mode">
          <div className="inline-flex w-full rounded-md border border-[var(--border-subtle)] overflow-hidden">
            {(["emphasize", "spotlight"] as const).map((m) => {
              const current = merged.emphasisMode ?? "emphasize";
              const sel = current === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => set("emphasisMode", m)}
                  className={`flex-1 px-3 py-1.5 text-[11px] capitalize ${
                    sel
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </ControlRow>

        {/* Active-word size multiplier — applies to BOTH emphasis modes
            but most visible in Emphasize. 1.0 = active word same size
            as the rest; 2.0 = double size (the Splash template look). */}
        <ControlRow label="Active Word Size">
          <SliderWithNumber
            value={Math.round((merged.activeWordSizeMultiplier ?? 1) * 100)}
            min={50}
            max={300}
            step={5}
            unit="%"
            onChange={(v) => set("activeWordSizeMultiplier", v / 100)}
          />
        </ControlRow>

        {/* Only meaningful when Spotlight is active — controls how dim
            inactive words go. Hidden under Emphasize since it'd be a
            no-op. */}
        {(merged.emphasisMode ?? "emphasize") === "spotlight" && (
          <ControlRow label="Spotlight Dim">
            <SliderWithNumber
              value={Math.round((merged.spotlightInactiveOpacity ?? 0.35) * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => set("spotlightInactiveOpacity", v / 100)}
            />
          </ControlRow>
        )}
        </Section>

        <Section title="Effects" defaultOpen>
        <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
          <span className="text-xs text-[var(--text-muted)]">Drop Shadow</span>
          <ToggleSwitch
            value={merged.shadowOpacity > 0.05}
            onChange={(v) => set("shadowOpacity", v ? 0.7 : 0)}
          />
        </div>

        {merged.shadowOpacity > 0.05 && (
          <>
          {/* ── Glow mode (none / active-only / all) ─────────────── */}
          <ControlRow label="Glow">
            <div className="inline-flex rounded-md border border-[var(--border-subtle)] overflow-hidden">
              {(["none", "active", "all"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`px-2 py-1 text-[10px] uppercase tracking-wide ${
                    (merged.glowMode ?? (merged.glowOnActive ? "active" : "none")) === m
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  }`}
                  onClick={() => set("glowMode", m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </ControlRow>

          {(merged.glowMode ?? (merged.glowOnActive ? "active" : "none")) !== "none" && (
            <>
              <ControlRow label="Glow Color">
                <ColorInput
                  value={rgbToHex(merged.glowColor ?? merged.highlightColor)}
                  onChange={(hex) => {
                    const rgb = hexToRgb(hex);
                    if (rgb) set("glowColor", rgb);
                  }}
                />
              </ControlRow>
              <ControlRow label="Glow Blur">
                <SliderWithNumber
                  value={merged.glowBlur ?? 24}
                  min={4}
                  max={80}
                  step={1}
                  unit="px"
                  onChange={(v) => set("glowBlur", v)}
                />
              </ControlRow>
            </>
          )}

          {/* ── Drop shadow tuning (offsets + blur + color) ─────── */}
          <ControlRow label="Shadow Offset X">
            <SliderWithNumber
              value={merged.dropShadowOffsetX ?? 0}
              min={-20}
              max={20}
              step={1}
              unit="px"
              onChange={(v) => set("dropShadowOffsetX", v)}
            />
          </ControlRow>
          <ControlRow label="Shadow Offset Y">
            <SliderWithNumber
              value={merged.dropShadowOffsetY ?? 4}
              min={-20}
              max={20}
              step={1}
              unit="px"
              onChange={(v) => set("dropShadowOffsetY", v)}
            />
          </ControlRow>
          <ControlRow label="Shadow Blur">
            <SliderWithNumber
              value={merged.dropShadowBlur ?? 12}
              min={0}
              max={60}
              step={1}
              unit="px"
              onChange={(v) => set("dropShadowBlur", v)}
            />
          </ControlRow>
          <ControlRow label="Shadow Color">
            <ColorInput
              value={rgbToHex(merged.dropShadowColor ?? [0, 0, 0])}
              onChange={(hex) => {
                const rgb = hexToRgb(hex);
                if (rgb) set("dropShadowColor", rgb);
              }}
            />
          </ControlRow>

          <ControlRow label="Shadow Opacity">
            <SliderWithNumber
              value={Math.round(merged.shadowOpacity * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => set("shadowOpacity", v / 100)}
            />
          </ControlRow>
          </>
        )}
        </Section>

        <Section title="Animation" defaultOpen={false}>
        <ControlRow label="Pop-in Speed">
          <SliderWithNumber
            value={Math.round(merged.popInDurationSec * 1000)}
            min={0}
            max={500}
            step={10}
            unit="ms"
            onChange={(v) => set("popInDurationSec", v / 1000)}
          />
        </ControlRow>

        {/* Caption Sync moved to its own top-level Section above. */}
        </Section>
      </div>
    </div>
  );
}

function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      {children}
    </div>
  );
}

/**
 * Collapsible section wrapper — gives the Text panel the visual
 * grouping Kalakar's editor uses (POSITION / FONT / COLOR / EMPHASIS
 * / SPACING / EFFECTS / ANIMATION). Each section header is uppercase
 * tracked text with a ▶/▼ chevron; click to toggle. `defaultOpen`
 * controls the initial state — most sections start expanded so power
 * users see everything; rare sections (Animation) start collapsed.
 */
function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <span>{title}</span>
        <span className="text-[8px]">{open ? "▼" : "▶"}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}

function SliderWithNumber({ value, min, max, step = 1, unit, onChange }: SliderProps) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--accent)]"
      />
      <div className="flex w-16 items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-transparent text-right text-[var(--text)] focus:outline-none"
        />
        {unit && <span className="text-[var(--text-muted)]">{unit}</span>}
      </div>
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-1">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded border-none bg-transparent"
      />
      <span className="text-[var(--text-muted)] text-xs">#</span>
      <input
        type="text"
        value={value.replace(/^#/, "")}
        onChange={(e) => onChange("#" + e.target.value)}
        maxLength={6}
        className="flex-1 bg-transparent text-xs uppercase tracking-wide text-[var(--text)] focus:outline-none"
      />
    </div>
  );
}

/**
 * Square toggle button for B / I / U formatting. Shows the letter rendered
 * in the corresponding style so the button itself previews the effect.
 */
function StyleToggle({
  label,
  title,
  active,
  onChange,
  bold,
  italic,
  underline,
}: {
  label: string;
  title: string;
  active: boolean;
  onChange: (v: boolean) => void;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!active)}
      className={`flex h-7 w-7 items-center justify-center rounded-md border text-[12px] transition ${
        active
          ? "border-[var(--accent)] bg-[var(--accent)] text-black"
          : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--border)]"
      }`}
      style={{
        fontWeight: bold ? 800 : 500,
        fontStyle: italic ? "italic" : "normal",
        textDecoration: underline ? "underline" : "none",
      }}
    >
      {label}
    </button>
  );
}

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative flex h-5 w-9 shrink-0 items-center rounded-full transition ${
        value ? "bg-[var(--accent)]" : "bg-[var(--bg-hover)]"
      }`}
    >
      <span
        className={`block h-4 w-4 transform rounded-full bg-white transition ${
          value ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
