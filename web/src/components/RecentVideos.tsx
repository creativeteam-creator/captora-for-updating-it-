"use client";

/**
 * Grid of past projects pulled from localStorage. Each card layout:
 *   - 9:16 thumbnail (data URL for video, music-note placeholder for audio)
 *   - Title row + 3-dot menu
 *   - "Yesterday • Hindi (Roman)" style metadata line
 *
 * Clicking a card asks the parent to open it; the menu lets the user delete.
 * If localStorage is empty we hide the section entirely so the home page
 * doesn't show an empty placeholder area.
 */

import { useState } from "react";
import {
  type ProjectRecord,
  formatRelativeTime,
} from "@/lib/projects";

interface Props {
  projects: ProjectRecord[];
  query?: string;
  onOpen?: (project: ProjectRecord) => void;
  onDelete?: (id: string) => void;
}

function MusicNoteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-12 w-12 text-[var(--text-muted)]">
      <path d="M14 4v9.55a4 4 0 11-2-3.45V7h6V4h-4z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

export function RecentVideos({ projects, query, onOpen, onDelete }: Props) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const filtered = query
    ? projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()))
    : projects;

  if (filtered.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-4 text-base font-semibold tracking-tight">Recent Videos</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {filtered.map((project) => {
          const langLabel = describeLanguage(project);
          return (
            <div
              key={project.id}
              className="group relative flex flex-col gap-2"
            >
              <button
                type="button"
                onClick={() => onOpen?.(project)}
                className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] transition hover:border-[var(--accent)]"
                style={{ aspectRatio: "9 / 16" }}
              >
                {project.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={project.thumbnail}
                    alt={project.title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2">
                    <MusicNoteIcon />
                    <span className="text-xs text-[var(--text-muted)] truncate max-w-[80%]">
                      {project.title}
                    </span>
                  </div>
                )}
              </button>

              <div className="flex items-start justify-between gap-2 px-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--text)]">
                    {project.title}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                    {formatRelativeTime(project.createdAt)} • {langLabel}
                  </div>
                </div>
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenu(openMenu === project.id ? null : project.id);
                    }}
                    className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                  >
                    <MoreIcon />
                  </button>
                  {openMenu === project.id && (
                    <div
                      className="absolute right-0 top-7 z-10 w-32 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onDelete?.(project.id);
                          setOpenMenu(null);
                        }}
                        className="block w-full px-3 py-2 text-left text-xs text-rose-400 hover:bg-[var(--bg-hover)]"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function describeLanguage(p: ProjectRecord): string {
  if (p.translateToEnglish) return "English (translated)";
  if (p.spokenLanguage === "hi-roman") return "Hindi (Roman)";
  return p.writingScript === "roman"
    ? `${p.spokenLanguageLabel} (Roman)`
    : `${p.spokenLanguageLabel} (Native)`;
}
