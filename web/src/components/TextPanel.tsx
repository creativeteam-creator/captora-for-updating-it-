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

import { useRef, useState } from "react";
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
  const [uploadStatus, setUploadStatus] = useState<{ kind: "idle" | "uploading" | "error"; message?: string }>({ kind: "idle" });

  const set = <K extends keyof CaptionStyleOverrides>(key: K, value: CaptionStyleOverrides[K]) => {
    onChange({ ...overrides, [key]: value });
  };

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;

    const defaultName = file.name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, "");
    const family = window.prompt("Font family name (this is what captions reference):", defaultName);
    if (!family || !family.trim()) return;

    setUploadStatus({ kind: "uploading" });
    try {
      const uploaded = await uploadFont(file, family.trim());
      await onUserFontsChanged();
      setUploadStatus({ kind: "idle" });
      // Auto-select the newly uploaded font.
      set("fontFamily", `'${uploaded.family}', ${matchFontStack(merged.fontFamily)}`);
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
        <ControlRow label="Fonts">
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
              {uploadStatus.kind === "uploading" ? "Uploading…" : "+ Upload Font (.ttf / .otf / .woff)"}
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

        <ControlRow label="Font Size">
          <SliderWithNumber
            value={merged.fontSize}
            min={32}
            max={160}
            step={2}
            onChange={(v) => set("fontSize", v)}
          />
        </ControlRow>

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

        <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
          <span className="text-xs text-[var(--text-muted)]">Drop Shadow</span>
          <ToggleSwitch
            value={merged.shadowOpacity > 0.05}
            onChange={(v) => set("shadowOpacity", v ? 0.7 : 0)}
          />
        </div>

        {merged.shadowOpacity > 0.05 && (
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
        )}

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

        {/* ── Caption Sync ─────────────────────────────────────────────────
            Whisper timestamps lag the perceptual word onset by 80–150 ms
            (especially Hindi / mixed language). Negative value = highlight
            appears EARLIER than the measured timestamp, which feels correct.
            Positive value = highlight appears LATER.
            Default is −100 ms (0.10 s anticipation). */}
        <ControlRow label="Caption Sync (ms)">
          <div className="space-y-1">
            <SliderWithNumber
              value={-Math.round((merged.wordAnticipationSec ?? 0.10) * 1000)}
              min={-300}
              max={300}
              step={10}
              unit="ms"
              onChange={(v) => set("wordAnticipationSec", -v / 1000)}
            />
            <div className="text-[10px] text-[var(--text-muted)]">
              Negative = caption highlights earlier (recommended for Hindi/mixed)
            </div>
          </div>
        </ControlRow>
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
