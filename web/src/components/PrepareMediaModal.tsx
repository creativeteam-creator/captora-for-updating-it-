"use client";

/**
 * The "Prepare Your Media" pop-up that fires after a user drops a file. Lets
 * them pick:
 *   - Spoken language (categorised dropdown, Whisper-99)
 *   - Writing script (Native vs Roman) — only when the language supports
 *     transliteration (Indic scripts via Sanscript)
 *   - Translation toggle (overrides script → forces English output)
 *   - Audio Enhancement / Emojis toggles (visual-only stubs for now)
 *
 * The Generate button is gated until both language + script are chosen so
 * the user has to make an explicit choice — explicit-pick UX.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SPOKEN_LANGUAGE_GROUPS,
  WRITING_SCRIPTS,
  getSpokenLanguage,
  supportsRoman,
  type SpokenLanguage,
  type WritingScript,
} from "@/lib/languages";
import { detectMediaKind } from "@/lib/projects";
import type { AccuracyTier } from "@/lib/whisper";

export interface PrepareMediaSettings {
  spokenLanguage: string;
  spokenLanguageLabel: string;
  writingScript: WritingScript;
  writingScriptLabel: string;
  translateToEnglish: boolean;
  audioEnhancement: boolean;
  emojis: boolean;
  accuracy: AccuracyTier;
}

interface Props {
  file: File | null;
  onClose: () => void;
  onGenerate: (settings: PrepareMediaSettings) => void;
}

export function PrepareMediaModal({ file, onClose, onGenerate }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [spokenCode, setSpokenCode] = useState<string>("");
  const [writingScript, setWritingScript] = useState<WritingScript | "">("");
  const [translate, setTranslate] = useState(false);
  const [audioEnhance, setAudioEnhance] = useState(false);
  const [emojis, setEmojis] = useState(false);
  const [accuracy, setAccuracy] = useState<AccuracyTier>("balanced");

  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [scriptDropdownOpen, setScriptDropdownOpen] = useState(false);

  const mediaKind = file ? detectMediaKind("." + (file.name.split(".").pop() || "mp3")) : "video";

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Reset selection when the file changes (avoids stale state if user
  // reopens the modal with a different upload).
  useEffect(() => {
    setSpokenCode("");
    setWritingScript("");
    setTranslate(false);
  }, [file]);

  const selectedLang = spokenCode ? getSpokenLanguage(spokenCode) : null;
  const langSupportsRoman = selectedLang ? supportsRoman(selectedLang) : false;

  // For Latin-script languages (English, Spanish, etc.) the writing script
  // is always Roman — auto-select it so the user doesn't have to click.
  useEffect(() => {
    if (!selectedLang) return;
    if (selectedLang.code === "hi-roman") {
      // Hinglish is romanised by definition.
      setWritingScript("roman");
    } else if (!langSupportsRoman) {
      // Non-romanisable scripts: lock to native.
      setWritingScript("native");
    }
  }, [selectedLang, langSupportsRoman]);

  const canGenerate = !!spokenCode && !!writingScript && !translate
    ? true
    : !!spokenCode && translate; // Translation overrides script — only spoken needed.

  const handleGenerate = () => {
    if (!selectedLang) return;
    const finalScript: WritingScript = translate ? "native" : (writingScript || "native");
    onGenerate({
      spokenLanguage: selectedLang.code,
      spokenLanguageLabel: selectedLang.label,
      writingScript: finalScript,
      writingScriptLabel: WRITING_SCRIPTS[finalScript].label,
      translateToEnglish: translate,
      audioEnhancement: audioEnhance,
      emojis,
      accuracy,
    });
  };

  if (!file) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-sidebar)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4">
          <div>
            <h2 className="text-lg font-semibold">Prepare Your Media</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Select a language to transcribe your media.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Media preview */}
        <div className="px-6 pb-2">
          <div
            className="mx-auto flex w-44 items-center justify-center overflow-hidden rounded-lg bg-black"
            style={{ aspectRatio: "9 / 16" }}
          >
            {mediaKind === "video" && previewUrl ? (
              <video
                src={previewUrl}
                muted
                loop
                playsInline
                controls={false}
                className="h-full w-full object-cover"
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0.5; }}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-12 w-12 text-[var(--text-muted)]">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-center gap-1.5 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            <span className="text-[var(--text-muted)]">Ready for processing</span>
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-4 p-6 pt-4">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-[var(--accent)]">
              <path d="M5 12h14M9 6l-4 6 4 6M15 6l4 6-4 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <div className="text-sm font-semibold">Language Settings</div>
              <div className="text-[11px] text-[var(--text-muted)]">
                Configure the source language and writing system
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Spoken language */}
            <div className="relative">
              <label className="mb-1.5 flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                <span>🗣</span>
                What language is spoken?
              </label>
              <button
                type="button"
                onClick={() => { setLangDropdownOpen((v) => !v); setScriptDropdownOpen(false); }}
                className="flex h-10 w-full items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-left text-xs text-[var(--text)] hover:border-[var(--accent)]"
              >
                <span className={selectedLang ? "" : "text-[var(--text-muted)]"}>
                  {selectedLang?.label ?? "Choose spoken language"}
                </span>
                <Caret open={langDropdownOpen} />
              </button>
              {langDropdownOpen && (
                <LanguageDropdown
                  selected={spokenCode}
                  onSelect={(code) => {
                    setSpokenCode(code);
                    setLangDropdownOpen(false);
                  }}
                  onClose={() => setLangDropdownOpen(false)}
                />
              )}
            </div>

            {/* Writing script */}
            <div className="relative">
              <label className="mb-1.5 flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                <span>📜</span>
                Writing system used?
              </label>
              <button
                type="button"
                disabled={!selectedLang || translate}
                onClick={() => { setScriptDropdownOpen((v) => !v); setLangDropdownOpen(false); }}
                className="flex h-10 w-full items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-left text-xs text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className={writingScript ? "" : "text-[var(--text-muted)]"}>
                  {writingScript ? WRITING_SCRIPTS[writingScript].label : "Choose writing script"}
                </span>
                <Caret open={scriptDropdownOpen} />
              </button>
              {scriptDropdownOpen && selectedLang && (
                <ScriptDropdown
                  language={selectedLang}
                  selected={writingScript}
                  onSelect={(script) => {
                    setWritingScript(script);
                    setScriptDropdownOpen(false);
                  }}
                  onClose={() => setScriptDropdownOpen(false)}
                />
              )}
            </div>
          </div>

          {/* Accuracy tier — Whisper model size. Bigger = better Hinglish but
              slower CPU inference + larger first-time download. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
              <span>🎯</span> Accuracy
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: "fast" as const,     label: "Fast",      hint: "small · ~240MB" },
                  { id: "balanced" as const, label: "Balanced",  hint: "medium · ~770MB" },
                  { id: "best" as const,     label: "Best",      hint: "turbo · ~700MB" },
                ]
              ).map((opt) => {
                const sel = accuracy === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAccuracy(opt.id)}
                    className={`rounded-md border px-2 py-2 text-center transition ${
                      sel
                        ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:border-[var(--accent)]/60"
                    }`}
                  >
                    <div className="text-xs font-semibold">{opt.label}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">{opt.hint}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-[var(--text-muted)]">
              First run downloads the model. Bigger = better Hinglish + English mixing accuracy.
            </p>
          </div>

          {/* Toggles */}
          <ToggleRow
            icon="✦"
            iconBg="bg-emerald-500/15 text-emerald-400"
            label="Translation"
            hint="Automatically translate captions to English"
            value={translate}
            onChange={setTranslate}
          />
          <ToggleRow
            icon="🔊"
            iconBg="bg-blue-500/15 text-blue-400"
            label="Audio Enhancement"
            hint="Clean up audio quality for better transcription accuracy"
            value={audioEnhance}
            onChange={setAudioEnhance}
            comingSoon
          />
          <ToggleRow
            icon="😊"
            iconBg="bg-amber-500/15 text-amber-400"
            label="Emojis"
            hint="Add engaging emojis to your captions automatically"
            value={emojis}
            onChange={setEmojis}
            comingSoon
          />

          <button
            type="button"
            disabled={!canGenerate}
            onClick={handleGenerate}
            className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent)] text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--bg-hover)] disabled:text-[var(--text-muted)]"
          >
            Generate Transcription
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface LangDropdownProps {
  selected: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}

function LanguageDropdown({ selected, onSelect, onClose }: LangDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const filteredGroups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return SPOKEN_LANGUAGE_GROUPS;
    return SPOKEN_LANGUAGE_GROUPS
      .map((g) => ({
        ...g,
        languages: g.languages.filter((l) => l.label.toLowerCase().includes(f)),
      }))
      .filter((g) => g.languages.length > 0);
  }, [filter]);

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl"
    >
      <div className="sticky top-0 border-b border-[var(--border)] bg-[var(--bg-elevated)] p-2">
        <input
          autoFocus
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search language..."
          className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
        />
      </div>
      {filteredGroups.map((group) => (
        <div key={group.label}>
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {group.label}
          </div>
          {group.languages.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => onSelect(lang.code)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition ${
                selected === lang.code
                  ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                  : "text-[var(--text)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              <span>{lang.label}</span>
              {selected === lang.code && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5">
                  <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      ))}
      {filteredGroups.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">No matches</div>
      )}
    </div>
  );
}

interface ScriptDropdownProps {
  language: SpokenLanguage;
  selected: WritingScript | "";
  onSelect: (script: WritingScript) => void;
  onClose: () => void;
}

function ScriptDropdown({ language, selected, onSelect, onClose }: ScriptDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canRoman = supportsRoman(language);
  // Native is always offered. For Latin-script languages (English, French)
  // it IS Roman so they're effectively the same — we just label clearly.
  const isLatin = language.nativeScript === "Latin";

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const options: Array<{ id: WritingScript; label: string; hint: string; disabled?: boolean }> = [
    {
      id: "native",
      label: isLatin ? "Latin (default)" : `${language.nativeScript} script`,
      hint: WRITING_SCRIPTS.native.hint,
    },
    {
      id: "roman",
      label: language.code === "hi-roman" ? "Roman (Hinglish)" : "Roman script",
      hint: WRITING_SCRIPTS.roman.hint,
      disabled: !canRoman || isLatin,
    },
  ];

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl"
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          disabled={opt.disabled}
          onClick={() => onSelect(opt.id)}
          className={`flex w-full flex-col px-3 py-2.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
            selected === opt.id
              ? "bg-[var(--accent-bg)] text-[var(--accent)]"
              : "text-[var(--text)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          <span className="font-medium">{opt.label}</span>
          <span className="mt-0.5 text-[10px] text-[var(--text-muted)]">{opt.hint}</span>
        </button>
      ))}
    </div>
  );
}

interface ToggleRowProps {
  icon: string;
  iconBg: string;
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  comingSoon?: boolean;
}

function ToggleRow({ icon, iconBg, label, hint, value, onChange, comingSoon }: ToggleRowProps) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-3 ${comingSoon ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg text-base ${iconBg}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold flex items-center gap-1.5">
            {label}
            {comingSoon && (
              <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
                soon
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{hint}</div>
        </div>
      </div>
      <button
        type="button"
        disabled={comingSoon}
        onClick={() => onChange(!value)}
        className={`relative flex h-5 w-9 shrink-0 items-center rounded-full transition ${
          value ? "bg-[var(--accent)]" : "bg-[var(--bg-hover)]"
        } disabled:cursor-not-allowed`}
      >
        <span
          className={`block h-4 w-4 transform rounded-full bg-white transition ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
