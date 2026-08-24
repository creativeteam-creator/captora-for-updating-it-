---
name: add-caption-template
description: Add a new burned-in caption style (template) to Captora — from a reference video/screenshot to a working, categorized template in the Templates panel. Use whenever the user wants a new caption look added, whether inspired by a competitor clip (CapCut, Submagic, Kalakar, Hormozi-style, etc.) or a from-scratch design.
---

# Adding a caption template to Captora

A "template" is one entry in `CAPTION_STYLES` — a single source of truth
at `remotion/src/styles.ts`. It renders in three places from that one
entry: the Templates panel card preview, the live editor Player preview,
and the burned-in MP4/MOV export. There is nothing to duplicate; adding
a template here is enough to make it available everywhere.

That single-source setup is recent. Before it, the same data lived
twice — once in `remotion/src/styles.ts` and once, hand-copied, in
`web/src/lib/styles.ts` — and the two drifted (12 of 35 templates
disagreed) because nothing enforced the copy staying in sync. If you
ever find yourself editing style *data* in `web/src/lib/styles.ts`,
stop — that file only holds web-only UI concerns now (categories,
override types, hex-color helpers). Preset data belongs in
`remotion/src/styles.ts` only.

## Step 0 — decide: new field values, or a new layout component?

Most templates are **declarative** — a new combination of existing
`CaptionStyle` fields (colour, glow, box, chip, entrance variant). A
template only needs a **new React component** when its layout can't be
expressed by those fields — e.g. words scattering around a hero word
(`ClusterCaption`), a cumulative pile-up (`StackCaption`), or a
top-to-bottom sticker rail (`StickerStackCaption`). Check the existing
five components in `remotion/src/components/` first:
`PhraseCaption` (default), `ClusterCaption`, `StackCaption`,
`StickerStackCaption`, `NeonPillCaption`. If the reference footage's
layout is a variation on one of these, prefer new field values on the
existing component over a sixth component.

## Step 1 — gather the reference

Reference clips and extracted frames already live in `refference/` and
`kalakar-frames/` from prior template work. For a new source: extract a
few representative frames (a still frame at the moment a word is
highlighted shows the most — colour, stroke, box/chip, position, glow).
Note, per frame:
  - Base text colour vs. active/highlighted word colour (as hex or RGB)
  - Font weight/case (bold? uppercase? condensed?)
  - Background: none, solid box, translucent pill, per-word chips
  - Glow: none, on the active word only, or on every word
  - Position: roughly what fraction down the frame (0 = top, 1 = bottom)
  - Entrance: does the phrase pop in together, or do words land one by
    one? Fast or slow?

## Step 2 — add the `CaptionStyleId`

In `remotion/src/styles.ts`, add the new id to the `CaptionStyleId`
union (kebab-case, e.g. `"neon-arrow"`). This is what makes TypeScript
require an entry in `CAPTION_STYLES` below — the compiler is the
guardrail against a half-added template.

## Step 3 — write the `CaptionStyle` entry

Add the object to `CAPTION_STYLES`, keyed by the new id. Required
fields: `id`, `label`, `baseColor`, `highlightColor`, `popInDurationSec`,
`fontFamily`, `fontSize`, `strokeWidth`, `shadowOpacity`,
`verticalPosition`. Everything else is optional — reach for it only
when the reference actually needs it:

| Look | Field(s) |
|---|---|
| Glow on the active word | `glowMode: "active"`, `glowColor`, `glowBlur` |
| Glow on every word | `glowMode: "all"` |
| Solid/translucent pill behind the phrase | `boxBackground: { color, paddingX, paddingY, radius, opacity? }` |
| Frosted-glass pill | add `backdropBlur` inside `boxBackground` |
| Per-word colored chips | `perWordChip: { paddingX, paddingY, radius }` |
| Only the active word gets a chip | add `perWordChipActiveOnly: true` |
| Two-tone gradient on the active word | `highlightGradient: { from, to }` |
| Active word renders larger | `activeWordSizeMultiplier` (e.g. 1.8) |
| Only the active word is visible at all | `activeWordOnly: true` |
| Words land one at a time, not together | `wordEntrance` (single variant or array to cycle) |
| Different Y per phrase (bouncy feel) | `verticalPositionCycle: [0.3, 0.6, 0.4, ...]` |

Colours are `RGB` tuples of **0–1 floats**, not 0–255 — `[1, 0.92, 0]`
is a warm yellow, not `[255, 235, 0]`. `fontFamily` should list a
fallback chain (`"Anton, Montserrat, Inter, sans-serif"`) since the
curated Google Fonts list may not have the exact reference font.

Set `isNew: true` if you want the "NEW" badge on the Templates panel
card. This is the flag that actually drove the drift bug — it's read
live by `web/src/components/TemplatesPanel.tsx`, so get it right the
first time rather than remembering to add it later.

If the layout genuinely needs a new component (Step 0 said yes): add
`remotion/src/components/<Name>Caption.tsx` following the shape of the
existing five (same props: `words`, `phraseStartSec`, `style`,
`phraseIndex?`, `wordSizes?`). Add a matching optional config object to
the `CaptionStyle` interface (mirror `cluster?` / `stack?` /
`stickerStack?` / `neonPill?`), then wire the new branch into
`remotion/src/components/CaptionsTimeline.tsx`'s if/else-if chain
(`lineStyle.<yourField> ? <YourComponent ... /> : ...`). Nothing in
`BoldViral.tsx` / `CleanMedical.tsx` / `TechMinimal.tsx` needs to
change — they all delegate to `CaptionsTimeline`.

## Step 4 — assign a category

In `web/src/lib/styles.ts`, add the new id to `TEMPLATE_CATEGORY`
(`kinetic` | `bold` | `neon` | `clean` | `boxed` | `effect`). This map
is typed `Record<CaptionStyleId, TemplateCategory>` — TypeScript will
refuse to compile if you skip this step, which is what stops a new
template from silently missing from every category filter in the
Templates panel.

## Step 5 — preview before touching the render pipeline

`npm run dev:remotion` opens Remotion Studio directly against
`remotion/src/index.ts`, using the mock words in `Root.tsx` — no
transcript, no upload, no web app needed. Pick the composition, and any
`lineStyles` override or a temporary edit to `CAPTION_STYLES[yourId]`
shows immediately. This is the fastest loop for tuning colour/spacing/
timing before it needs to look right inside the full editor.

Once it looks right in Studio: `npm run dev:web`, open the editor on
any existing project, and pick the new template from the Templates
panel — this exercises the actual `CaptionPreview` Player path the user
will see, including custom fonts and the merged-override pipeline
(`applyStyleOverrides`).

## Step 6 — verify preview and export agree

Export a short render from the live editor (`Export` button) and
confirm the MP4 matches the Player preview. Both paths render through
the exact same `CaptionsTimeline` / `PhraseCaption`-family components
now, so a mismatch here means a bug in the template's field values, not
a drifted copy — there's only one copy left to be wrong in.

(`npm --workspace remotion run render` also works for a CLI-only check,
but it always renders the `BoldViral` composition with `Root.tsx`'s
mock words and default style — pass `--props='{"style": <your object>}'`
to point it at the new template, since it won't pick your id up by
name.)

## Checklist

- [ ] New id added to `CaptionStyleId` in `remotion/src/styles.ts`
- [ ] Entry added to `CAPTION_STYLES` in the same file (not web)
- [ ] `isNew: true` set if it should show the NEW badge
- [ ] New layout component (if any) wired into `CaptionsTimeline.tsx`
- [ ] Category assigned in `TEMPLATE_CATEGORY` (`web/src/lib/styles.ts`)
- [ ] `npx tsc --noEmit` clean in both `remotion/` and `web/`
- [ ] Previewed in Remotion Studio (`npm run dev:remotion`)
- [ ] Previewed in the live editor (`npm run dev:web` → Templates panel)
- [ ] Test-rendered and confirmed the MP4 matches the preview
