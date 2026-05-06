# Captora

Viral-style auto-captions for video and audio uploads. Upload media,
get back a finished video with per-phrase animated captions.

## Architecture

```
                         ┌─────────────────────┐
                         │  web (Next.js 15)   │
   user ─── upload ─────▶│  - upload UI         │
                         │  - style picker      │
                         │  - preview & download│
                         │  - API routes        │
                         └──────────┬──────────┘
                                    │ word-level JSON
                                    ▼
                         ┌─────────────────────┐
                         │  remotion (v4)      │
                         │  - BoldViral comp   │
                         │  - CleanMedical comp│
                         │  - TechMinimal comp │
                         │  - per-word pop-in  │
                         │  - active highlight │
                         └──────────┬──────────┘
                                    │ rendered MP4 / WebM-alpha
                                    ▼
                              user download
```

## Workspaces

| Path                  | Role                                            |
|-----------------------|-------------------------------------------------|
| `web/`                | Next.js 15 frontend + API routes (Whisper, render) |
| `remotion/`           | Remotion 4 caption renderer (3 styles as React)    |
| `_archived-uxp/`      | Original Premiere UXP plugin attempt (parked)      |

## Quick start

```bash
npm install
npm run dev:web                            # → http://localhost:3000
```

Whisper runs locally via @huggingface/transformers — no OpenAI / API key
required. The first transcription downloads the model (~700 MB for the
default `whisper-medium`) into `node_modules`.

## Style presets

| Name           | Highlight           | Pop-in   | Aesthetic                       |
|----------------|---------------------|----------|----------------------------------|
| Bold Viral     | Yellow `#FFEB00`    | 0.10s    | Loud, eye-catching, social reels |
| Clean Medical  | Soft amber `#FFC74C`| 0.20s    | Professional, clinical voiceover |
| Tech Minimal   | Electric cyan `#33D9FF` | 0.14s | Modern, sleek tech content      |

## Notes on the archived UXP attempt

See [_archived-uxp/README.md](_archived-uxp/README.md) for the engineering
log on why the Premiere Pro plugin path was parked. TL;DR: `param.create
SetValueAction` rejects every value shape for MOGRT-exposed text params in
the current UXP API, and editing the manifest inside the MOGRT zip does
not influence the rendered text. We pivoted to the same architecture used
by Submagic / OpusClip / CapCut — a web app that renders captioned video.
