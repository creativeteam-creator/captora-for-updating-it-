"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { UploadHero } from "@/components/UploadHero";
import { RecentVideos } from "@/components/RecentVideos";
import { PrepareMediaModal, type PrepareMediaSettings } from "@/components/PrepareMediaModal";
import { EditorView } from "@/components/EditorView";
import { SettingsModal } from "@/components/SettingsModal";
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
import { isElectron, readSourceFileLocally, saveSourceFileLocally } from "@/lib/electron-bridge";

type Status =
  | { kind: "idle" }
  | { kind: "uploading"; sizeMb: number; startedAt: number }
  | { kind: "transcribing"; startedAt: number; estimatedSec: number }
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
  const [retranscribing, setRetranscribing] = useState(false);
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
  /** Per-word fontSize multipliers keyed by `(word.start * 100) | 0`
   *  centiseconds. 1.0 = use line / global fontSize, 1.5 = 150%. Edited
   *  inline from CaptionsList, persisted with the project. */
  const [wordSizes, setWordSizes] = useState<Record<string, number>>({});
  /** User-forced line breaks. Each entry is an INDEX in `editedWords`
   *  after which a new caption line must start, overriding the auto
   *  grouper. Wired into groupWordsIntoLines via the userBreaks option.
   *  Edited inline from the captions list (hover ⏎ between two words).
   *  Set is intentionally simple — supports undo via the editor's
   *  snapshot system. */
  const [userBreaks, setUserBreaks] = useState<Set<number>>(new Set());
  /** Caption IN / OUT trim points in seconds — words outside this range
   *  are excluded from preview + render. `null` on either side means
   *  "no trim on that end". Session-only state for now (not persisted
   *  to the DB); a future migration can promote this to a column. */
  const [captionInSec, setCaptionInSec] = useState<number | null>(null);
  const [captionOutSec, setCaptionOutSec] = useState<number | null>(null);
  /** Currently-selected line in the timeline (centisecond key) — when
   *  set, picking a template applies to ONLY this line; when null,
   *  picking a template changes the project-wide `styleId`. */
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const { user } = useUser();
  const initials = userInitials(user);
  // Opens the Settings modal (per-user Gemini / Groq API key inputs).
  // Modal lives at the top of the JSX tree so it covers both Home and
  // Editor views without duplication.
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    //
    // wordSizes and userBreaks were missing from this reset: they were
    // only ever set by the captions list, never cleared, so per-word size
    // tweaks and forced line breaks carried over into the next project
    // the user started in the same session.
    clearEditorHistory();
    setLineAnimations({});
    setLineStyles({});
    setLineOverrides({});
    setWordSizes({});
    setUserBreaks(new Set());
    setSelectedLineKey(null);
    // Reflect the upload phase explicitly — for large files (clinic
    // network, slow upstream) this can take many minutes and the old
    // single "Transcribing…" message was misleading.
    setStatus({
      kind: "uploading",
      sizeMb: file.size / 1024 / 1024,
      startedAt: Date.now(),
    });

    try {
      // Generate thumbnail client-side so we don't pay for an extra
      // server-side video decode just to grab one frame.
      const ext = "." + (file.name.split(".").pop() ?? "mp3").toLowerCase();
      const mediaKind = detectMediaKind(ext);
      const thumbnail = await generateThumbnail(file, mediaKind);

      // Probe source dimensions so the editor canvas matches the dropped
      // media's aspect ratio (9:16 reel stays vertical, 16:9 YT stays
      // horizontal). Audio uploads return null → defaults to vertical reel.
      // The user can override aspect via the PrepareMedia modal's
      // canvasOrientation pick — passing "portrait"/"landscape"/"square"
      // here forces that aspect regardless of source.
      const probedDims = await probeVideoDimensions(file);
      setCanvasDims(pickCanvasDimensions(probedDims, settings.canvasOrientation));

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
      // Estimate transcription time from file size: GPU mode is ~5-10x
      // realtime, cloud mode ~1-2x. Conservative ~6x realtime ≈ file
      // size in MB / 6 minutes (audio: ~1MB per min, video: ~10MB per min).
      // We use a simple "size / 4" as a rough seconds estimate that's
      // visible early; if the real call takes longer the bar just slows.
      const estimatedSec = Math.max(15, Math.round(file.size / 1024 / 1024 / 4 * 60));
      setStatus({
        kind: "transcribing",
        startedAt: Date.now(),
        estimatedSec,
      });

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
      // Surface server-side warnings (quota exhausted etc.) to the user
      // via a simple browser alert. Native `alert()` keeps the
      // implementation small; could be replaced with a toast component
      // later if the UI grows more notifications.
      type Warn = { kind: string; provider: string; userOwned: boolean; message: string };
      const warnings: Warn[] = Array.isArray(json.warnings) ? json.warnings : [];
      if (warnings.length > 0) {
        const lines = warnings.map((w) => `• ${w.message}`).join("\n");
        // Defer one tick so the editor transition finishes first.
        setTimeout(() => window.alert(`⚠ Captions tayar ho gayi but:\n\n${lines}`), 100);
      }

      // Fetch the freshly-saved project (resolves signed URLs etc.).
      const saved = await getProject(json.projectId);
      if (!saved) throw new Error("Project saved but could not be re-read");

      setStyleId(saved.styleId);
      setOverrides(saved.styleOverrides);
      setLineAnimations(saved.lineAnimations);
      setEditedWords(saved.whisper.words);
      // Freshly transcribed project — these start empty by definition,
      // but read them off the record rather than hard-coding {} so this
      // stays correct if the insert ever seeds them.
      setLineStyles(saved.lineStyles);
      setWordSizes(saved.wordSizes);
      setUserBreaks(new Set(saved.userBreaks));
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

  // Persist the per-line / per-word editor state. Same 400ms debounce as
  // the two effects around it, so a burst of clicks in the captions list
  // collapses into one write.
  //
  // These three were previously in-memory only — they reached /api/render
  // at export time but were never written to the row, so closing the
  // project discarded them. They're batched into a single updateProject
  // call because they're almost always edited together (pick a template
  // for a line, nudge a word's size, split the line) and three separate
  // debounced writes would triple the round-trips for one user action.
  //
  // userBreaks is serialised as a sorted array: it's a Set in the editor,
  // Sets aren't JSON-serialisable, and sorting keeps the stored value
  // stable so an unchanged selection doesn't look like a change.
  useEffect(() => {
    if (status.kind !== "transcribed" && status.kind !== "rendering" && status.kind !== "rendered") {
      return;
    }
    const projectId = status.project.id;
    const t = setTimeout(() => {
      void updateProject(projectId, {
        lineStyles,
        wordSizes,
        userBreaks: Array.from(userBreaks).sort((a, b) => a - b),
      });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineStyles, wordSizes, userBreaks, status.kind]);

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

  const onRetranscribe = async () => {
    if (status.kind !== "transcribed" && status.kind !== "rendered") return;
    const { project, file } = status;
    setRenderError(null);
    setRetranscribing(true);
    try {
      // Desktop: rewrite the source file to sessionDir path so the
      // retranscribe route can read it even if the previous temp copy
      // got cleaned up by the 48h sweep or Windows Defender. Idempotent
      // — if the file is already there this is a same-path copy.
      let localFilePath = "";
      if (isElectron()) {
        localFilePath = await saveSourceFileLocally(file, project.ext, project.id);
      }
      const res = await fetch("/api/retranscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          localFilePath: localFilePath || undefined,
          // Keep the same language/script/accuracy the project was
          // originally transcribed with. If the user wants to change,
          // they can re-drop the file from Home to go through the
          // Prepare Media modal again.
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      // Replace project state with the fresh transcript. Keep all
      // other project fields (title, styleId, overrides, renderUrl…)
      // untouched — only the transcription-derived fields change.
      const updatedProject: ProjectRecord = {
        ...project,
        provider: json.provider ?? project.provider,
        whisper: {
          task: "transcribe",
          language: json.result?.language ?? project.whisper.language,
          duration: json.result?.duration ?? project.whisper.duration,
          text: json.result?.text ?? project.whisper.text,
          words: json.result?.words ?? project.whisper.words,
        },
      };
      setEditedWords(json.result?.words ?? project.whisper.words);
      setStatus({ kind: "transcribed", project: updatedProject, file });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[onRetranscribe] failed:", msg);
      setRenderError(`Re-transcribe failed: ${msg}`);
    } finally {
      setRetranscribing(false);
    }
  };

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
          // Per-line lines inherit the GLOBAL overrides first (font,
          // color, position etc.) and then layer any per-line overrides
          // on top. Without this merge, picking a different template
          // for one line dropped all the user's global tweaks — the
          // "template change keeps undoing my customizations" bug.
          computedLineStyles[k] = applyStyleOverrides(preset, {
            ...overrides,
            ...(lineOverrides[k] ?? {}),
          });
        }
      }
      // Render uses the latest edited words, not the originals from the
      // project record — typos / corrections fixed in the captions list
      // flow straight into the MP4.
      const rawWordsForRender = editedWords ?? project.whisper.words;
      // Apply IN/OUT trim: drop any word whose start is before the IN
      // point or after the OUT point. The video track still plays for
      // the full duration; only the captions overlay is masked to the
      // chosen slice. `null` on either side = no trim on that end.
      const wordsForRender = rawWordsForRender.filter((w) => {
        if (captionInSec != null && w.start < captionInSec) return false;
        if (captionOutSec != null && w.start > captionOutSec) return false;
        return true;
      });
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
          // Serialise the userBreaks Set as an array for transport —
          // /api/render reads it back into the composition inputProps
          // so the rendered MP4 honours the same line splits the
          // captions list displays in the editor.
          userBreaks: Array.from(userBreaks),
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
      const filename = `${project.title || "media"}${project.ext || ""}`;
      let file: File;

      // Desktop projects don't upload to Supabase — the file lives at
      // <userData>/sessions/<projectId>.<ext>. Read it back via IPC
      // instead of fetching a non-existent signed URL.
      if (isElectron()) {
        try {
          file = await readSourceFileLocally(
            project.id,
            project.ext || "",
            filename
          );
        } catch (err) {
          throw new Error(
            (err instanceof Error ? err.message : String(err)) +
              "\n\nTip: source files older than 12 hours are auto-cleaned. " +
              "Re-upload the same media to restore this project."
          );
        }
      } else {
        if (!project.sourceUrl) {
          throw new Error(
            "Source file is missing from storage. Re-upload the same media to render."
          );
        }
        const res = await fetch(project.sourceUrl);
        if (!res.ok) throw new Error(`Source download failed: HTTP ${res.status}`);
        const blob = await res.blob();
        file = new File([blob], filename, { type: blob.type });
      }

      // Re-probe dimensions when reopening — original aspect isn't
      // persisted on the project record (yet), so we derive from the
      // freshly downloaded source.
      const probedDims = await probeVideoDimensions(file);
      setCanvasDims(pickCanvasDimensions(probedDims));

      setStyleId(project.styleId);
      setOverrides(project.styleOverrides);
      setLineAnimations(project.lineAnimations);
      setEditedWords(project.whisper.words);
      // Restore the per-line / per-word edits. These used to be reset to
      // empty here, which is why reopening a project silently threw away
      // every template pick, size tweak and forced line break the user
      // had made. userBreaks round-trips as an array (a Set isn't
      // JSON-serialisable) and is rebuilt here.
      setLineStyles(project.lineStyles);
      setWordSizes(project.wordSizes);
      setUserBreaks(new Set(project.userBreaks));
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

  // Text-panel edits always update the GLOBAL overrides — line selection
  // no longer scopes slider/colour/font changes to one line. Per-line
  // styling is now expressed only through template selection (a line can
  // pick a different template via the Templates panel while selected,
  // and that line's render inherits the global overrides on top — see
  // computedLineStyles in onRender).
  const onOverridesChange = (next: CaptionStyleOverrides) => {
    recordEditorChange();
    setOverrides(next);
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
            title={`Settings · ${user?.email ?? ""}`}
            onClick={() => setSettingsOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-xs font-bold text-[var(--text)] hover:bg-[var(--bg-hover)]"
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
          // TextPanel ALWAYS edits the global overrides — even when a line
          // is selected. Previously, clicking a line silently swapped the
          // panel into per-line mode showing an empty `lineOverrides[key]`
          // snapshot, so users perceived their customizations as "reset"
          // every time they clicked a line. Per-line scoping is now limited
          // to template selection only (Templates panel + selectedLineKey).
          overrides={overrides}
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
          onRetranscribe={onRetranscribe}
          retranscribing={retranscribing}
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
          wordSizes={wordSizes}
          onWordSizesChange={setWordSizes}
          userBreaks={userBreaks}
          onUserBreaksChange={setUserBreaks}
          captionInSec={captionInSec}
          captionOutSec={captionOutSec}
          onCaptionRangeChange={(inSec, outSec) => {
            recordEditorChange();
            setCaptionInSec(inSec);
            setCaptionOutSec(outSec);
          }}
        />
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          userId={user?.id}
          userEmail={user?.email}
        />
      </div>
    );
  }

  // Home mode — sidebar + topbar + upload + recent.
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <TopBar onSearch={setSearchQuery} onOpenSettings={() => setSettingsOpen(true)} />

        <main className="flex-1 overflow-y-auto px-8 py-6">
          <UploadHero onFile={onFilePicked} disabled={uploading || transcribing || opening} />
          {uploading && status.kind === "uploading" && (
            <ProcessingBar
              label={`Uploading source (${status.sizeMb.toFixed(0)} MB)…`}
              hint="Large files take a few minutes on slow networks."
              startedAt={status.startedAt}
              estimatedSec={Math.max(5, Math.round(status.sizeMb / 5))}
            />
          )}
          {transcribing && status.kind === "transcribing" && (
            <ProcessingBar
              label="Transcribing audio…"
              hint="First run may download the Whisper model. GPU machines finish much faster."
              startedAt={status.startedAt}
              estimatedSec={status.estimatedSec}
            />
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
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        userId={user?.id}
        userEmail={user?.email}
      />
    </div>
  );
}

/**
 * Live progress bar for upload + transcribe phases.
 *
 * We can't read true progress from a single fetch POST (no streaming
 * endpoint), so we drive the bar from elapsed time vs the caller's
 * `estimatedSec` budget. The asymptote at 95% prevents the bar from
 * "completing" before the API responds — the parent flips state on
 * fetch resolve and the bar disappears.
 */
function ProcessingBar({
  label,
  hint,
  startedAt,
  estimatedSec,
}: {
  label: string;
  hint?: string;
  startedAt: number;
  estimatedSec: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = (now - startedAt) / 1000;
  // Asymptotic curve to 95%: starts fast, slows as it approaches the
  // estimate, never completes (parent component swaps the bar out on
  // success). pct = 95 * (1 - exp(-elapsed / estimate)).
  const ratio = Math.max(0.0001, estimatedSec);
  const pct = Math.min(95, 95 * (1 - Math.exp(-elapsedSec / ratio)));
  const eta = Math.max(0, estimatedSec - elapsedSec);

  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <div className="flex items-center justify-between text-sm text-[var(--text)]">
        <span>{label}</span>
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {Math.round(pct)}% &nbsp;·&nbsp; {formatSecs(elapsedSec)} elapsed
          {eta > 0 ? <> · ~{formatSecs(eta)} left</> : null}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">{hint}</div>}
    </div>
  );
}

function formatSecs(s: number): string {
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m${sec.toString().padStart(2, "0")}s` : `${sec}s`;
}
