# Captora — Premiere Pro Plugin (UXP)

Loads the Captora web app inside a Premiere Pro panel so editors can
transcribe, style, and render captions without leaving Premiere.

## Status

**Phase 2 MVP** — webview wrapper. Full timeline auto-import on render is
the next iteration (see `panel.js` → `captora:render-complete` stub).

## What you get today

- Captora UI (login, upload, transcribe, edit captions, render) inside
  a Premiere panel
- Persistent server URL — set once, opens to the same Captora server
  every time
- Reload button + URL switcher in the top bar
- Cookies + Supabase session persist across panel reloads

## What's coming next (Phase 2.1)

- `postMessage` bridge from the embedded Captora web → UXP host
- Auto-download rendered `.mov` to OS temp
- Auto-import to the active Premiere sequence at the current playhead

## Requirements

| | |
|---|---|
| **Premiere Pro** | 2024 (v24) or newer |
| **OS** | Windows 10+, macOS 12+ |
| **Captora server** | Running locally (`npm run dev:web`) OR hosted somewhere reachable from your machine |

## Install (developer side-load)

1. **Download the [Adobe UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/installation/)**
   from Creative Cloud Desktop → "Apps" → search "UXP Developer Tool"

2. Open **UXP Developer Tool** → **Add Plugin**

3. In the file picker, choose:
   ```
   C:\Users\QHT-DT-34\Desktop\new kalakar plugin\premiere-plugin\manifest.json
   ```

4. The plugin appears in the list. Click **•••** menu → **Load**

5. Open **Premiere Pro** → menu **Window** → **Extensions** → **Captora**

The panel opens. First load points at `http://localhost:3000` — change
via the **URL** button if your Captora dev server lives elsewhere
(e.g., your office LAN IP `http://192.168.1.7:3000`).

## Distribution to your team (later)

When the plugin is stable:

1. **UXP Developer Tool → Package** → produces a `.ccx` file
2. Send `.ccx` to a teammate
3. They double-click → installs to Creative Cloud → appears in
   Premiere's Window menu

For wider distribution (public Marketplace) you'll need:

- Adobe code signing (free for individuals)
- Marketplace listing (review takes 1–2 weeks)

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel blank / "Refused to connect" | Captora dev server not running. `npm run dev:web` in the workspace root |
| Panel shows login page but doesn't accept signin | Webview cookies blocked — make sure Premiere has internet permission for the panel. Reload via the ↻ button |
| Want to point at a different server | Click **URL** in the top bar → enter `http://192.168.x.x:3000` (or hosted URL) → Save |
| Plugin not appearing in Window menu | UXP Developer Tool → Plugin → ensure status is "Loaded". Restart Premiere if needed |

## Architecture

```
┌──────────────────────────────────────────────┐
│  Premiere Pro                                │
│  ┌────────────────────────────────────────┐  │
│  │  Captora UXP panel (this plugin)       │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │  <webview src="…/captora">       │  │  │
│  │  │   Full Captora React app loads   │  │  │
│  │  │   inside — same UI as the        │  │  │
│  │  │   browser version.               │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

The plugin itself is < 200 lines of code — Premiere's UXP webview takes
care of rendering the web app, and the Captora server handles transcription,
storage, and rendering exactly the same way the browser version does.
