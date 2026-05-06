/**
 * Captora UXP panel — minimal logic. The heavy lifting (transcribe,
 * render, edit) lives in the embedded Captora web app. This panel just:
 *
 *   1. Loads the Captora server URL into a <webview>
 *   2. Lets the user reload / change URL via the top bar
 *   3. Persists the chosen URL in UXP's local secure storage so the
 *      next panel session opens to the same server
 *
 * The web → panel bridge for "render finished, drop on timeline" lives in
 * a follow-up phase. For now the user downloads the .mov via the embedded
 * Captora UI and drag-drops to the Premiere timeline themselves.
 */

const STORAGE_KEY = "captora.panel.url";
const DEFAULT_URL = "http://localhost:3000";

const wv = document.getElementById("captora");
const btnReload = document.getElementById("btn-reload");
const btnUrl = document.getElementById("btn-url");
const urlPrompt = document.getElementById("url-prompt");
const urlInput = document.getElementById("url-input");
const urlSave = document.getElementById("url-save");
const urlCancel = document.getElementById("url-cancel");

// ── Restore last server URL ─────────────────────────────────────────────
const savedUrl = (function readSavedUrl() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
})();
wv.setAttribute("src", savedUrl);

// ── Top bar actions ─────────────────────────────────────────────────────
btnReload.addEventListener("click", () => {
  if (typeof wv.reload === "function") {
    wv.reload();
  } else {
    // Fallback: reset src to bust whatever cached state.
    const current = wv.getAttribute("src");
    wv.setAttribute("src", current);
  }
});

btnUrl.addEventListener("click", () => {
  urlInput.value = wv.getAttribute("src") || DEFAULT_URL;
  urlPrompt.hidden = false;
  urlInput.focus();
  urlInput.select();
});

urlCancel.addEventListener("click", () => {
  urlPrompt.hidden = true;
});

urlSave.addEventListener("click", () => {
  const next = (urlInput.value || "").trim();
  if (!next) return;
  try {
    // Accept anything that looks like a URL or http://host:port form.
    new URL(next);
  } catch {
    return;
  }
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  wv.setAttribute("src", next);
  urlPrompt.hidden = true;
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") urlSave.click();
  else if (e.key === "Escape") urlCancel.click();
});

// ── Web → Panel bridge (Phase 2-next) ───────────────────────────────────
// Captora can postMessage `{ type: "captora:render-complete", … }` once a
// render is done; we'll wire timeline-import logic here. Stubbed so the
// channel is documented and ready.
window.addEventListener("message", (event) => {
  const data = event?.data;
  if (!data || typeof data !== "object") return;
  switch (data.type) {
    case "captora:render-complete":
      console.log("[captora-panel] render finished:", data);
      // TODO: download the file via fetch, write to UXP localFileSystem,
      // import to active sequence at playhead via `premierepro` SDK.
      break;
    case "captora:auth-changed":
      console.log("[captora-panel] auth state changed:", data);
      break;
    default:
      break;
  }
});
