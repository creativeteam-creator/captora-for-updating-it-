"use client";

/**
 * Big drag-and-drop / click-to-upload zone shown at the top of the home page.
 * Selecting or dropping a file fires `onFile` — the parent then opens the
 * Prepare Media modal. Accepted formats mirror what `/api/transcribe` can
 * decode via ffmpeg-static (basically anything, but we only advertise the
 * common ones).
 */

import { useRef, useState } from "react";

const ACCEPT = "video/*,audio/*";
const ADVERTISED_FORMATS = "MP4, MOV, MP3, WAV, M4A";

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function UploadHero({ onFile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handle = (file: File | null | undefined) => {
    if (!file || disabled) return;
    onFile(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      className={`relative flex h-72 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed transition ${
        dragging
          ? "border-[var(--accent)] bg-[var(--accent-bg)]"
          : "border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handle(e.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => handle(e.target.files?.[0])}
      />

      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--bg)] text-[var(--text-muted)]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-7 w-7">
            <rect x="3" y="3" width="18" height="14" rx="2" />
            <path d="M3 12l4-3 4 4 3-2 7 5" strokeLinejoin="round" />
            <circle cx="9" cy="8" r="1.2" fill="currentColor" />
            <path d="M20 5v6M17 8h6" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-base font-medium text-[var(--text)]">
          Drop your video or audio here or click to upload
        </div>
        <div className="text-xs text-[var(--text-muted)]">Max: 30:00 minutes, 1GB</div>
        <div className="text-xs text-[var(--text-muted)]">Supports: {ADVERTISED_FORMATS}</div>
      </div>
    </div>
  );
}
