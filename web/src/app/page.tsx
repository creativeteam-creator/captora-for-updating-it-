"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { UploadHero } from "@/components/UploadHero";
import { RecentVideos } from "@/components/RecentVideos";
import { PrepareMediaModal, type PrepareMediaSettings } from "@/components/PrepareMediaModal";
import { EditorView } from "@/components/EditorView";
import {
  deleteProject,
  detectMediaKind,
  generateThumbnail,
  getProject,
  listProjects,
  updateProject,
  type ProjectRecord,
} from "@/lib/projects";
import {
  CAPTION_STYLES,
  DEFAULT_STYLE,
  applyStyleOverrides,
  type CaptionStyleId,
  type CaptionStyleOverrides,
} from "@/lib/styles";
import { useUser, userInitials } from "@/lib/useUser";
import type { WhisperWord } from "@/lib/whisper";
import { listUserFonts, fontFaceCss, type UserFont } from "@/lib/userFonts";
import {
  pickCanvasDimensions,
  probeVideoDimensions,
  type MediaDimensions,
} from "@/lib/mediaDimensions";
import { createClient } from "@/lib/supabase/client";
import { uploadSourceFromBrowser } from "@/lib/supabase/storage";
import { isElectron, saveSourceFileLocally } from "@/lib/electron-bridge";

type Status =
  | { kind: "idle" }
  | { kind: "uploading"; sizeMb: number }
  | { kind: "transcribing" }
  | { kind: "opening"; project: ProjectRecord }
  | { kind: "transcribed"; project: ProjectRecord; file: File }
  | { kind: "rendering"; project: ProjectRecord; file: File }
  | { kind: "rendered"; project: ProjectRecord; file: File; downloadUrl: string }
  | { kind: "error"; message: string };

type EditorSnapshot = {
  styleId: CaptionStyleId;
  overrides: CaptionStyleOverrides;
  editedWords: WhisperWord[] | null;
  lineAnimations: Record<string, string>;
  lineStyles: Record<string, CaptionStyleId>;
  lineOverrides: Record<string, CaptionStyleOverrides>;
  transparent: boolean;
};

export default function Home() {
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [styleId, setStyleId] = useState<CaptionStyleId>(DEFAULT_STYLE);
  const [overrides, setOverrides] = useState<CaptionStyleOverrides>({});
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [transparent, setTransparent] = useState(false);
  /**
   * Live-editable copy of the current project's words. Initialised from
   * `project.whisper.words` whenever a project enters the editor (fresh
   * transcribe OR Recent Videos reopen). Edits in the captions list
   * mutate this array; debounced saves push back to Supabase.
   */
  const [editedWords, setEditedWords] = useState<WhisperWord[] | null>(null);
  /** User-uploaded fonts, fetched once per session. The TextPanel calls
   *  `refreshUserFonts` after each successful upload. */
  const [userFonts, setUserFonts] = useState<UserFont[]>([]);
  /** Canvas dimensions the editor + render should target. Derived from
   *  the dropped media's aspect ratio (snapped to 9:16, 16:9, 1:1, 4:5,
   *  or kept native). Defaults to vertical reel for audio-only uploads. */
  const [canvasDims, setCanvasDims] = useState<MediaDimensions>({ width: 1080, height: 1920 });
  /** Per-line entrance-animation overrides. Centisecond key → variant
   *  name. Edits flow up from CaptionsList; persisted via the same
   *  debounced project-save effect that handles styleOverrides. */
  const [lineAnimations, setLineAnimations] = useState<Record<string, string>>({});
  /** Per-line template overrides — same centisecond keys, value is a
   *  CaptionStyleId. When a line has an entry, it uses that template
   *  instead of the global `styleId`. Lets users mix templates per
   *  line (opening line bold, body line minimal, etc.). */
  const [lineStyles, setLineStyles] = useState<Record<string, CaptionStyleId>>({});
  /** Per-line Text-panel overrides (font size, colours, position, …)
   *  isolated per line. Without this, a Text-panel slider would
   *  silently apply to every line that shares the global template.
   *  With it, "individually treat each template" works as expected:
   *  changes while line 3 is selected only touch line 3, even if
   *  line 5 happens to use the same preset. */
  const [lineOverrides, setLineOverrides] = useState<Record<string, CaptionStyleOverrides>>({});
  /** Currently-selected line in the timeline (centisecond key) — when
   *  set, picking a template applies to ONLY this line; when null,
   *  picking a template changes the project-wide `styleId`. */
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const { user } = useUser();
  const initials = userInitials(user);

  const makeEditorSnapshot = useCallback(
    (): EditorSnapshot => ({
      styleId,
      overrides,
      editedWords,
      lineAnimations,
      lineStyles,
      lineOverrides,
      transparent,
    }),
    [styleId, overrides, editedWords, lineAnimations, lineStyles, lineOverrides, transparent]
  );

  const applyEditorSnapshot = useCallback((snapshot: EditorSnapshot) => {
    setStyleId(snapshot.styleId);
    setOverrides(snapshot.overrides);
    setEditedWords(snapshot.editedWords);
    setLineAnimations(snapshot.lineAnimations);
    setLineStyles(snapshot.lineStyles);
    setLineOverrides(snapshot.lineOverrides);
    setTransparent(snapshot.transparent);
  }, []);

  const clearEditorHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, []);

  const recordEditorChange = useCallback(() => {
    undoStackRef.current.push(makeEditorSnapshot());
    if (undoStackRef.current.length > 100) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
  }, [makeEditorSnapshot]);

  const undoEditorChange = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(makeEditorSnapshot());
    applyEditorSnapshot(previous);
  }, [applyEditorSnapshot, makeEditorSnapshot]);

  const redoEditorChange = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(makeEditorSnapshot());
    applyEditorSnapshot(next);
  }, [applyEditorSnapshot, makeEditorSnapshot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTextInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;
      if (isTextInput || (!event.ctrlKey && !event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoEditorChange();
        else undoEditorChange();
      } else if (key === "y") {
        event.preventDefault();
        redoEditorChange();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redoEditorChange, undoEditorChange]);

  async function refreshUserFonts() {
    const fonts = await listUserFonts();
    setUserFonts(fonts);
  }

  // Hydrate the recent-projects list + user-uploaded fonts whenever the
  // user changes (e.g. signin/signout). Both refresh after their
  // respective mutations (transcribe / delete / font upload).
  useEffect(() => {
    if (!user) {
      setProjects([]);
      setUserFonts([]);
      return;
    }
    void refreshProjects();
    void refreshUserFonts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Inject @font-face for every user-uploaded font into the document
  // head so they render correctly in the editor preview, the captions
  // list, and any UI that uses `font-family: '<custom>'`. The Remotion
  // bundle has its own FontLoader for renders — this is just for the
  // browser preview side. Cleanup removes the <style> tag on unmount /
  // when the font list changes so we never accumulate stale rules.
  useEffect(() => {
    if (userFonts.length === 0) return;
    const css = userFonts.map(fontFaceCss).filter(Boolean).join("\n");
    if (!css) return;
    const style = document.createElement("style");
    style.dataset.captoraUserFonts = "1";
    style.textContent = css;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [userFonts]);

  async function refreshProjects() {
    const list = await listProjects();
    setProjects(list);
  }

  const onFilePicked = (file: File) => {
    setPickedFile(file);
  };

  const onGenerate = async (settings: PrepareMediaSettings) => {
    if (!pickedFile) return;
    const file = pickedFile;
    setPickedFile(null);
    // New project — start with no per-line overrides so old values
    // from a previous project don't bleed in.
    clearEditorHistory();
    setLineAnimations({});
    setLineStyles({});
    setLineOverrides({});
    setSelectedLineKey(null);
    // Reflect the upload phase explicitly — for large files (clinic
    // network, slow upstream) this can take many minutes and the old
    // single "Transcribing…" message was misleading.
    setStatus({ kind: "uploading", sizeMb: file.size / 1024 / 1024 });

    try {
      // Generate thumbnail client-side so we don't pay for an extra
      // server-side video decode just to grab one frame.
      const ext = "." + (file.name.split(".").pop() ?? "mp3").toLowerCase();
      const mediaKind = detectMediaKind(ext);
      const thumbnail = await generateThumbnail(file, mediaKind);

      // Probe source dimensions so the editor canvas matches the dropped
      // media's aspect ratio (9:16 reel stays vertical, 16:9 YT stays
      // horizontal). Audio uploads return null → defaults to vertical reel.
      const probedDims = await probeVideoDimensions(file);
      setCanvasDims(pickCanvasDimensions(probedDims));

      // Upload directly to Supabase Storage from the browser. This
      // bypasses /api/transcribe's request body entirely — Next.js's
      // dev server (undici) chokes on multipart bodies above ~1GB
      // with "expected CRLF" / "expected boundary after body" parser
      // errors, even with `middlewareClientMaxBodySize` raised. After
      // the upload succeeds we POST a tiny JSON envelope to
      // /api/transcribe pointing at the storage path.
      const supabase = createClient();
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes?.user?.id;
      if (!userId) throw new Error("Not signed in");
      const projectId = crypto.randomUUID();

      // ──── Mode-aware "upload" ──────────────────────────────────
      // Desktop (Electron): write the file to the local sessions
      // folder via IPC. No Supabase Storage hit at all — videos
      // never leave the user's PC. Returns the absolute on-disk
      // path, which we send to /api/transcribe as `localPath` so
      // the route knows to skip the Supabase download branch.
      // Web: classic Supabase Storage upload, returns the storage
      // path. /api/transcribe then downloads it server-side.
      let storagePath: string;
      // `localFilePath` is non-empty only in desktop mode. We capture
      // the EXACT absolute path the IPC handler reports it wrote to,
      // and pass it through to /api/transcribe — no recomputation
      // server-side. Eliminates the path-drift bug where main and
      // the Next.js child each recompute `app.getPath("userData")`
      // independently and somehow disagree.
      let localFilePath = "";
      if (isElectron()) {
        localFilePath = await saveSourceFileLocally(file, ext, projectId);
        // /api/transcribe still requires storagePath to satisfy its
        // RLS path-prefix check. The file isn't actually in Supabase,
        // but the path passes validation; the route then uses
        // `localFilePath` as the actual on-disk source.
        storagePath = `${userId}/${projectId}${ext}`;
      } else {
        storagePath = await uploadSourceFromBrowser(
          supabase,
          userId,
          projectId,
          ext,
          file
        );
      }

      // Upload finished — flip to the transcribing state so the
      // status panel updates from "Uploading…" to "Transcribing…".
      setStatus({ kind: "transcribing" });

      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          storagePath,
          // Authoritative on-disk path of the source — only set in
          // desktop mode. The route uses this directly instead of
          // recomputing `sessionDir + projectId + ext`.
          localFilePath: localFilePath || undefined,
          ext,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          title: file.name.replace(/\.[^.]+$/, ""),
          spokenLanguage: settings.spokenLanguage,
          writingScript: settings.writingScript,
          translateToEnglish: settings.translateToEnglish,
          accuracy: settings.accuracy,
          thumbnail: thumbnail ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        // Best-effort cleanup — if transcribe failed, the orphaned
        // source object would otherwise stick around in storage.
        supabase.storage.from("captora-source").remove([storagePath]).catch(() => {});
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      // Fetch the freshly-saved project (resolves signed URLs etc.).
      const saved = await getProject(json.projectId);
      if (!saved) throw new Error("Project saved but could not be re-read");

      setStyleId(saved.styleId);
      setOverrides(saved.styleOverrides);
      setLineAnimations(saved.lineAnimations);
      setEditedWords(saved.whisper.words);
      setLineStyles({});
      setLineOverrides({});
      clearEditorHistory();
      void refreshProjects();
      setStatus({ kind: "transcribed", project: saved, file });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Persist per-line animation overrides to Supabase. Debounced 400ms
  // so popover clicks don't fire a write per click; same cadence as
  // styleOverrides so saves naturally batch.
  useEffect(() => {
    if (status.kind !== "transcribed" && status.kind !== "rendering" && status.kind !== "rendered") {
      return;
    }
    const projectId = status.project.id;
    const t = setTimeout(() => {
      void updateProject(projectId, { lineAnimations });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineAnimations, status.kind]);

  // Persist style edits to Supabase whenever the editor changes them.
  // Debounced lightly so rapid slider drags don't fire dozens of writes.
  useEffect(() => {
    if (status.kind !== "transcribed" && status.kind !== "rendering" && status.kind !== "rendered") {
      return;
    }
    const projectId = status.project.id;
    const t = setTimeout(() => {
      void updateProject(projectId, { styleId, styleOverrides: overrides });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleId, overrides, status.kind]);

  // Persist word edits — typing in the captions list mutates `editedWords`
  // synchronously but we only push to Supabase 700 ms after the user
  // pauses, to avoid a write per keystroke.
  useEffect(() => {
    if (!editedWords) return;
    if (status.kind !== "transcribed" && status.kind !== "rendering" && status.kind !== "rendered") {
      return;
    }
    const projectId = status.project.id;
    const t = setTimeout(() => {
      const transcriptText = editedWords.map((w) => w.word).join(" ");
      void updateProject(projectId, {
        whisperWords: editedWords,
        transcriptText,
      });
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedWords, status.kind]);

  const onRender = async () => {
    if (status.kind !== "transcribed" && status.kind !== "rendered") return;
    const { project, file } = status;
    setRenderError(null);
    setStatus({ kind: "rendering", project, file });
    try {
      const computedStyle = applyStyleOverrides(CAPTION_STYLES[styleId], overrides);
      // Per-line full styles — a line is "independent" if it has a
      // per-line template OR per-line text overrides (or both). We
      // compute its full style from its own template + its own
      // overrides only — NOT from the global `overrides`. That way
      // a Text-panel slider tweak on line 3 doesn't bleed into line
      // 5, even if both lines use the same template.
      const computedLineStyles: Record<string, ReturnType<typeof applyStyleOverrides>> = {};
      const independentKeys = new Set<string>([
        ...Object.keys(lineStyles),
        ...Object.keys(lineOverrides),
      ]);
      for (const k of independentKeys) {
        const sid = (lineStyles[k] ?? styleId) as CaptionStyleId;
        const preset = CAPTION_STYLES[sid];
        if (preset) {
          computedLineStyles[k] = applyStyleOverrides(preset, lineOverrides[k] ?? {});
        }
      }
      // Render uses the latest edited words, not the originals from the
      // project record — typos / corrections fixed in the captions list
      // flow straight into the MP4.
      const wordsForRender = editedWords ?? project.whisper.words;
      // Send only the fonts whose URLs resolved — render Chromium needs
      // a downloadable URL to inject @font-face. Fonts without URLs are
      // recently-uploaded ones whose signed URL hasn't loaded yet.
      const customFonts = userFonts
        .filter((f) => !!f.url)
        .map((f) => ({ family: f.family, url: f.url!, format: f.format }));
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          ext: project.ext,
          style: styleId,
          words: wordsForRender,
          durationSec: project.whisper.duration,
          computedStyle,
          transparent,
          customFonts,
          width: canvasDims.width,
          height: canvasDims.height,
          lineAnimations,
          lineStyles: computedLineStyles,
        }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) message = j.error;
        } catch { /* binary body */ }
        throw new Error(message);
      }
      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      setStatus({ kind: "rendered", project, file, downloadUrl });
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
      setStatus({ kind: "transcribed", project, file });
    }
  };

  const onResetAndUpload = () => {
    setStatus({ kind: "idle" });
    setRenderError(null);
  };

  const onDeleteProject = async (id: string) => {
    try {
      await deleteProject(id);
      void refreshProjects();
    } catch (err) {
      console.error("[deleteProject] failed:", err);
    }
  };

  /**
   * Re-open a previously saved project. We fetch the source file from
   * Supabase Storage (via signed URL on the project record), wrap it in
   * a `File`, and drop the user back into the editor with all their
   * cached transcript + style edits pre-loaded.
   *
   * If the source URL is missing (project orphaned) or the fetch fails,
   * surface the error and leave the user on Home.
   */
  const onOpenProject = async (project: ProjectRecord) => {
    setRenderError(null);
    setStatus({ kind: "opening", project });
    try {
      if (!project.sourceUrl) {
        throw new Error(
          "Source file is missing from storage. Re-upload the same media to render."
        );
      }
      const res = await fetch(project.sourceUrl);
      if (!res.ok) throw new Error(`Source download failed: HTTP ${res.status}`);
      const blob = await res.blob();
      const filename = `${project.title || "media"}${project.ext || ""}`;
      const file = new File([blob], filename, { type: blob.type });

      // Re-probe dimensions when reopening — original aspect isn't
      // persisted on the project record (yet), so we derive from the
      // freshly downloaded source.
      const probedDims = await probeVideoDimensions(file);
      setCanvasDims(pickCanvasDimensions(probedDims));

      setStyleId(project.styleId);
      setOverrides(project.styleOverrides);
      setLineAnimations(project.lineAnimations);
      setEditedWords(project.whisper.words);
      setLineStyles({});
      setLineOverrides({});
      clearEditorHistory();
      setStatus({ kind: "transcribed", project, file });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Selection-aware template picker. When a line is selected (via
  // clicking its chip in the timeline), picking a template only
  // overrides THAT line. Otherwise it changes the project-wide
  // template and clears any per-line overrides for consistency —
  // otherwise users would silently end up with stale overrides
  // that contradict the new global pick.
  const onPickTemplate = (id: CaptionStyleId) => {
    recordEditorChange();
    if (selectedLineKey) {
      setLineStyles((prev) => ({ ...prev, [selectedLineKey]: id }));
    } else {
      setStyleId(id);
      // Switching the global template wipes overrides — they were
      // tied to the old base. Per-line entries stay so users don't
      // lose their per-line picks.
      setOverrides({});
    }
  };
  // Lets the user clear their per-line override for the currently-
  // selected line, snapping it back to the global template. Wipes
  // BOTH the per-line template AND its per-line text overrides so
  // the line truly returns to "follows global" state.
  const onClearLineStyle = () => {
    if (!selectedLineKey) return;
    recordEditorChange();
    setLineStyles((prev) => {
      const next = { ...prev };
      delete next[selectedLineKey];
      return next;
    });
    setLineOverrides((prev) => {
      const next = { ...prev };
      delete next[selectedLineKey];
      return next;
    });
  };

  // Selection-aware overrides setter. When a line is selected, every
  // Text-panel edit goes into that line's `lineOverrides[key]` slot
  // — keeping per-line independence. Otherwise edits land in the
  // project-wide `overrides` as before.
  const onOverridesChange = (next: CaptionStyleOverrides) => {
    recordEditorChange();
    if (selectedLineKey) {
      setLineOverrides((prev) => ({ ...prev, [selectedLineKey]: next }));
    } else {
      setOverrides(next);
    }
  };

  const onWordsChange = (next: WhisperWord[]) => {
    recordEditorChange();
    setEditedWords(next);
  };

  const onLineAnimationsChange = (next: Record<string, string>) => {
    recordEditorChange();
    setLineAnimations(next);
  };

  const onTransparentChange = (next: boolean) => {
    recordEditorChange();
    setTransparent(next);
  };

  const transcribing = status.kind === "transcribing";
  const uploading = status.kind === "uploading";
  const opening = status.kind === "opening";
  const inEditor =
    status.kind === "transcribed" ||
    status.kind === "rendering" ||
    status.kind === "rendered";
  const rendering = status.kind === "rendering";

  // Editor mode takes the whole viewport — full-screen editor.
  if (inEditor) {
    return (
      <div className="flex min-h-screen flex-col bg-[var(--bg)]">
        <div className="flex h-16 items-center justify-between border-b border-[var(--border)] px-6">
          <span className="text-xl font-bold tracking-tight">
            C<span className="text-[var(--accent)]">a</span>pt<span className="text-[var(--accent)]">o</span>ra
          </span>
          <button
            type="button"
            title={user?.email ?? ""}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-xs font-bold text-[var(--text)]"
          >
            {initials}
          </button>
        </div>
        <EditorView
          project={status.project}
          file={status.file}
          styleId={styleId}
          // When a line is selected we hand TextPanel that line's
          // own overrides + that line's own template ID so the
          // sliders reflect what the user is actually editing.
          // Otherwise we hand it the project-wide ones.
          overrides={
            selectedLineKey ? lineOverrides[selectedLineKey] ?? {} : overrides
          }
          editingStyleId={
            (selectedLineKey
              ? lineStyles[selectedLineKey]
              : undefined) ?? styleId
          }
          onOverridesChange={onOverridesChange}
          words={editedWords ?? status.project.whisper.words}
          onWordsChange={onWordsChange}
          onBack={onResetAndUpload}
          onExport={onRender}
          exporting={rendering}
          exportDownloadUrl={status.kind === "rendered" ? status.downloadUrl : undefined}
          exportError={renderError}
          transparent={transparent}
          onTransparentChange={onTransparentChange}
          userFonts={userFonts}
          onUserFontsChanged={refreshUserFonts}
          canvasWidth={canvasDims.width}
          canvasHeight={canvasDims.height}
          lineAnimations={lineAnimations}
          onLineAnimationsChange={onLineAnimationsChange}
          lineStyles={lineStyles}
          lineOverrides={lineOverrides}
          selectedLineKey={selectedLineKey}
          onSelectLine={setSelectedLineKey}
          onPickTemplate={onPickTemplate}
          onClearLineStyle={onClearLineStyle}
        />
      </div>
    );
  }

  // Home mode — sidebar + topbar + upload + recent.
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <TopBar onSearch={setSearchQuery} />

        <main className="flex-1 overflow-y-auto px-8 py-6">
          <UploadHero onFile={onFilePicked} disabled={uploading || transcribing || opening} />
          {uploading && (
            <div className="mt-4 flex items-center justify-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-sm text-[var(--text-muted)]">
              <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
              Uploading source ({status.kind === "uploading" ? status.sizeMb.toFixed(0) : 0}&nbsp;MB) to storage… large files take a few minutes on slow networks.
            </div>
          )}
          {transcribing && (
            <div className="mt-4 flex items-center justify-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-sm text-[var(--text-muted)]">
              <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
              Transcribing… first call may download the model.
            </div>
          )}
          {opening && (
            <div className="mt-4 flex items-center justify-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-sm text-[var(--text-muted)]">
              <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
              Loading project…
            </div>
          )}
          {status.kind === "error" && (
            <div className="mt-4 rounded-lg border border-rose-700 bg-rose-950/40 p-4 text-sm text-rose-300">
              {status.message}
            </div>
          )}
          <RecentVideos
            projects={projects}
            query={searchQuery}
            onOpen={onOpenProject}
            onDelete={onDeleteProject}
          />
        </main>
      </div>

      <PrepareMediaModal
        file={pickedFile}
        onClose={() => setPickedFile(null)}
        onGenerate={onGenerate}
      />
    </div>
  );
}
