"use client";

import { useRef, useState, DragEvent } from "react";

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
}

const ACCEPTED = "audio/*,video/*";

export function UploadZone({ onFile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pickedName, setPickedName] = useState<string | null>(null);

  const accept = (file: File | null | undefined) => {
    if (!file || disabled) return;
    setPickedName(file.name);
    onFile(file);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    accept(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={[
        "flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition",
        disabled
          ? "border-[var(--border)] opacity-50 cursor-not-allowed"
          : dragOver
            ? "border-indigo-500 bg-indigo-500/10 cursor-pointer"
            : "border-[var(--border)] hover:border-indigo-500/50 cursor-pointer",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={(e) => accept(e.target.files?.[0])}
      />
      <div className="text-sm font-medium">
        {pickedName ?? "Drop audio or video here, or click to browse"}
      </div>
      <div className="mt-2 text-xs text-[var(--text-muted)]">
        Accepts MP3, WAV, M4A, MP4, MOV — up to ~100 MB
      </div>
    </div>
  );
}
