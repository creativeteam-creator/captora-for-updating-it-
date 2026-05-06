# Archived: UXP Premiere Pro plugin attempt

This folder contains the original UXP-based Premiere Pro plugin code. It is
**not** part of the active Kalakar product. It is preserved for reference and
in case Adobe ships an API surface that unblocks the original approach.

## Why it was archived

We hit a fundamental gap in the Premiere Pro UXP API (Premiere 2027 / latest):

- `editor.insertMogrtFromPath(...)` works and places clips correctly.
- `Component.getParam(i)` returns the MOGRT-exposed `Source Text` param.
- But `param.createSetValueAction(value)` rejects every value shape we tried
  (string, `{text}`, `{value}`, `[string]`, addKeyframe variants) with
  `Illegal Parameter type` / `Invalid parameter`.
- `getStartValue()` returns `null`, `keyframesSupported` is `false` for that
  param, and there is no public alternative to write into MOGRT-exposed text
  parameters from UXP.
- A 5th-arg parameter-overrides probe on `insertMogrtFromPath` was
  silently accepted but ignored — no error, no effect.
- Editing `manifest.json` defaults inside the MOGRT zip also did not change
  the rendered text — the actual text lives inside the binary AE project
  file embedded in the MOGRT.

In short, the UXP API does not currently expose a way to programmatically set
MOGRT text content from the panel side.

## What lives here

| File / folder       | Role                                                      |
|---------------------|-----------------------------------------------------------|
| `manifest.json`     | UXP Manifest v5                                           |
| `index.html`        | Static panel layout                                       |
| `panel.js`          | Vanilla JS panel wiring (file picker, style cards, mock)  |
| `main.js`           | `WhisperTimelineMapper` + signature-discovery diagnostics |
| `index.jsx`         | Earlier React version (never wired up)                    |
| `styles.css`        | Panel styling                                             |
| `backend-server.js` | First Whisper bridge sketch                               |
| `templates/`        | `bold-viral.mogrt` and the original how-to MD             |
| `icons/`            | Empty placeholder folder                                  |

## Reusable parts (carried into the web app)

These were the meaningful design decisions worth keeping:

- **Style preset structure** — `Bold Viral`, `Clean Medical`, `Tech Minimal`,
  with per-style highlight color and pop-in duration.
- **Whisper word-level JSON shape** — `{ words: [{ word, start, end }] }`.
- **Two-phase rendering model** — placement first, styling second.

These have moved into `web/` and `remotion/` in the parent folder.

## Last working version

Git/file system snapshot from `2026-04-28`. Build stamp on `main.js` was
`v13 — overrides reuse fix`.
