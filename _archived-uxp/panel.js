/**
 * Kalakar Auto Captions — vanilla UXP panel script.
 *
 * Wires the static markup in index.html to the timeline mapper in main.js.
 * No React, no bundler. UXP loads this directly from <script src="panel.js">.
 */

const { processWhisperCaptions, notifyN8n, discoverPremiereApi } = require("./main.js");
const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  audioFile: null,        // uxp File entry
  selectedStyle: "Bold Viral",
  transcriptionData: null,
  isBusy: false,
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  pickAudio: $("btn-pick-audio"),
  transcribe: $("btn-transcribe"),
  mock: $("btn-mock"),
  discover: $("btn-discover"),
  n8n: $("btn-n8n"),
  status: $("status"),
  fileName: $("file-name"),
  preview: $("preview"),
  previewBody: $("preview-body"),
  styleGrid: $("style-grid"),
  apiDumpWrap: $("api-dump-wrap"),
  apiDump: $("api-dump"),
};

// ---------------------------------------------------------------------------
// Mock Whisper JSON — used by "Test with Mock Captions" so we can verify
// timeline insertion without depending on the backend bridge.
// ---------------------------------------------------------------------------

const MOCK_WHISPER = {
  task: "transcribe",
  language: "en",
  duration: 2.85,
  text: "Welcome to Kalakar auto captions",
  words: [
    { word: "Welcome",  start: 0.10, end: 0.55 },
    { word: "to",       start: 0.60, end: 0.78 },
    { word: "Kalakar",  start: 0.80, end: 1.35 },
    { word: "auto",     start: 1.40, end: 1.75 },
    { word: "captions", start: 1.80, end: 2.60 },
  ],
};

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(message, tone = "info") {
  els.status.textContent = message;
  els.status.style.borderLeftColor =
    tone === "error"   ? "#ef4444" :
    tone === "success" ? "#10b981" :
    tone === "warn"    ? "#f59e0b" :
                         "#d1d5db";
}

function setBusy(busy) {
  state.isBusy = busy;
  els.transcribe.disabled = busy || !state.audioFile;
  els.mock.disabled = busy;
  els.pickAudio.disabled = busy;
}

function showPreview(result) {
  if (!result) {
    els.preview.hidden = true;
    return;
  }
  els.preview.hidden = false;

  let errorList = "";
  if (result.errors && result.errors.length) {
    const escape = (s) =>
      String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const rows = result.errors
      .slice(0, 5)
      .map(
        (e) =>
          `<li><strong>"${escape(e.word)}"</strong> (#${e.wordIndex}): ${escape(e.message)}</li>`
      )
      .join("");
    errorList =
      `<p><strong>Errors (${result.errors.length}):</strong></p>` +
      `<ul style="margin:4px 0 0 16px; padding:0; font-size:11px; color:#fca5a5;">${rows}</ul>`;
  }

  els.previewBody.innerHTML = `
    <p><strong>Style:</strong> ${result.metadata?.style ?? state.selectedStyle}</p>
    <p><strong>Clips placed:</strong> ${result.clipsCreated}</p>
    <p><strong>Words:</strong> ${result.metadata?.wordCount ?? "—"}</p>
    <p><strong>Duration:</strong> ${
      result.metadata?.duration ? result.metadata.duration.toFixed(2) + "s" : "—"
    }</p>
    ${errorList}
  `;
  if (result.errors?.length) console.warn("Caption errors:", result.errors);
}

// ---------------------------------------------------------------------------
// Style selection
// ---------------------------------------------------------------------------

els.styleGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".style-card");
  if (!card) return;
  state.selectedStyle = card.dataset.style;
  els.styleGrid
    .querySelectorAll(".style-card")
    .forEach((c) => c.classList.toggle("selected", c === card));
});

// ---------------------------------------------------------------------------
// Audio file picker (UXP storage API — not the browser <input type=file>)
// ---------------------------------------------------------------------------

els.pickAudio.addEventListener("click", async () => {
  try {
    const file = await fs.getFileForOpening({
      types: ["mp3", "wav", "m4a", "aac", "flac"],
    });
    if (!file) return; // user cancelled
    state.audioFile = file;
    els.fileName.hidden = false;
    els.fileName.textContent = file.name;
    els.transcribe.disabled = false;
    setStatus(`Selected: ${file.name}`, "success");
  } catch (err) {
    setStatus(`File pick failed: ${err.message}`, "error");
  }
});

// ---------------------------------------------------------------------------
// Real transcribe flow (depends on the Node bridge from Step 2)
// ---------------------------------------------------------------------------

els.transcribe.addEventListener("click", async () => {
  if (!state.audioFile) return;
  setBusy(true);
  setStatus("Uploading audio to local bridge…");

  try {
    const bytes = await state.audioFile.read({
      format: uxp.storage.formats.binary,
    });

    const form = new FormData();
    form.append("audio", new Blob([bytes]), state.audioFile.name);
    form.append("model", "whisper-1");
    form.append("language", "en");
    form.append("timestamp_granularities[]", "word");

    const res = await fetch("http://localhost:3000/api/transcribe", {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`Bridge ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Transcription failed");

    state.transcriptionData = json.whisper_response;
    setStatus(`Transcribed ${json.whisper_response.words.length} words. Applying…`);

    const result = await processWhisperCaptions(json.whisper_response, {
      styleTemplate: state.selectedStyle,
    });

    showPreview(result);
    setStatus(
      result.success
        ? `Done — ${result.clipsCreated} caption clips placed.`
        : `Captions placed with ${result.errors.length} errors.`,
      result.success ? "success" : "warn"
    );
    els.n8n.hidden = false;
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
    console.error(err);
  } finally {
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// Mock-test flow — bypasses the backend so we can validate timeline insertion
// in isolation. Click button → main.js inserts 5 caption clips at fixed times.
// ---------------------------------------------------------------------------

els.mock.addEventListener("click", async () => {
  setBusy(true);
  setStatus(`Inserting mock captions in style: ${state.selectedStyle}…`);
  try {
    const result = await processWhisperCaptions(MOCK_WHISPER, {
      styleTemplate: state.selectedStyle,
    });
    state.transcriptionData = MOCK_WHISPER;
    showPreview(result);
    setStatus(
      result.success
        ? `Mock test passed — ${result.clipsCreated} clips placed on timeline.`
        : `Placed ${result.clipsCreated} clips, ${result.errors.length} errors. See console.`,
      result.success ? "success" : "warn"
    );
    els.n8n.hidden = false;
  } catch (err) {
    setStatus(`Mock test failed: ${err.message}`, "error");
    console.error(err);
  } finally {
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// Discover Premiere API — dumps method names to the DevTools console without
// mutating anything. Right-click the panel → Debug → check Console tab.
// ---------------------------------------------------------------------------

els.discover.addEventListener("click", async () => {
  setStatus("Probing Premiere API…");
  try {
    const result = await discoverPremiereApi();
    els.apiDumpWrap.hidden = false;
    els.apiDump.value = result.dump || "(empty dump)";
    els.apiDump.focus();
    els.apiDump.select();   // pre-select so Ctrl+C just works
    setStatus(
      result.success
        ? "API dump ready below. Already selected — press Ctrl+C, then paste it back to me."
        : `Discovery hit an error: ${result.errors.join(" / ")}. Dump still captured below.`,
      result.success ? "success" : "warn"
    );
  } catch (err) {
    setStatus(`Discovery failed: ${err.message}`, "error");
    console.error(err);
  }
});

// ---------------------------------------------------------------------------
// n8n webhook
// ---------------------------------------------------------------------------

els.n8n.addEventListener("click", async () => {
  if (!state.transcriptionData) return;
  setStatus("Sending metadata to n8n…");
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      style: state.selectedStyle,
      transcription: {
        language: state.transcriptionData.language,
        duration: state.transcriptionData.duration,
        wordCount: state.transcriptionData.words.length,
        text: state.transcriptionData.text,
      },
      audioFileName: state.audioFile?.name ?? "(mock)",
    };
    const result = await notifyN8n(
      "https://webhook.site/your-webhook-id", // TODO: replace with real n8n URL
      payload
    );
    setStatus(
      result.ok ? "n8n payload delivered." : `n8n returned ${result.status}`,
      result.ok ? "success" : "warn"
    );
  } catch (err) {
    setStatus(`n8n error: ${err.message}`, "error");
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setStatus("Ready. Click \"Test with Mock Captions\" to verify the timeline pipeline.");
