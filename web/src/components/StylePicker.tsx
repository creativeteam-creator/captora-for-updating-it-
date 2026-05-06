"use client";

import { CAPTION_STYLES, CaptionStyleId } from "@/lib/styles";

interface Props {
  value: CaptionStyleId;
  onChange: (id: CaptionStyleId) => void;
  disabled?: boolean;
}

export function StylePicker({ value, onChange, disabled }: Props) {
  return (
    <div className="grid gap-3 grid-cols-1">
      {Object.values(CAPTION_STYLES).map((style) => {
        const selected = style.id === value;
        return (
          <button
            key={style.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(style.id)}
            className={[
              "rounded-lg border p-3 text-left transition",
              selected
                ? "border-[var(--accent)] bg-[var(--accent-bg)]"
                : "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--accent)]/60",
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
            ].join(" ")}
          >
            <div className="text-sm font-semibold">{style.label}</div>
            <div className="mt-0.5 text-xs text-[var(--text-muted)]">
              {style.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}
