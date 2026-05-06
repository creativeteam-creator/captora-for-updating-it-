# How to author the two MOGRT templates

The Kalakar mapper (`main.js`) inserts one MOGRT clip per Whisper word and
overrides two exposed parameters by **exact name**:

```js
mogrtComponent.getProperty("Source Text");   // → set per word
mogrtComponent.getProperty("Fill Color");    // → yellow on the active word
```

Both files must live in this folder:

- `templates/bold-viral.mogrt`
- `templates/clean-medical.mogrt`

If either file is missing, or either parameter is not exposed with the exact
label `Source Text` / `Fill Color`, the mapper will silently skip that override.

---

## Workflow (Premiere Pro only — no After Effects needed)

1. **New authoring project** — separate from your real edits. Anything here.
2. **New Sequence** sized to your delivery format. For vertical Reels/Shorts:
   `1080 × 1920, 30 fps`. For 16:9: `1920 × 1080, 30 fps`.
3. **Type Tool (T)** → click on the Program Monitor → type a placeholder word
   like `SAMPLE`. This becomes the editable text the mapper rewrites at runtime.
4. **Window → Essential Graphics → Edit tab.** Select the text layer in the
   layer list at the top.
5. Style it per the spec below (Bold Viral or Clean Medical).
6. **Expose the two parameters.** In the Edit tab, scroll to the text layer's
   properties:
   - Find **Source Text** → click the small **toggle / "Add to template"
     icon** to the left of the field. It turns blue → exposed.
   - Find **Fill Color** (under Appearance → Fill) → expose the same way.
   - Confirm both now appear under the **"Solo Selected Properties"** area at
     the top of the EGP panel with labels exactly `Source Text` and
     `Fill Color`. If Premiere renamed them, double-click the label and rename.
7. **Name the template** at the very top of the EGP panel
   (e.g. `Bold Viral`).
8. **Export Motion Graphics Template** —
   `Graphics → Export Motion Graphics Template…` (or right-click the layer →
   Export As Motion Graphics Template).
   - **Destination:** `Local Templates Folder` is fine for testing, but for
     this plugin save to disk: navigate to
     `Desktop\new kalakar plugin\templates\` and save as
     `bold-viral.mogrt` / `clean-medical.mogrt`.
   - Tick **Include Source Text** and **Compatibility: latest**.

Repeat for the second style.

---

## Style spec — Bold Viral

For loud, attention-grabbing medical/tech reels.

| Property      | Value                                          |
|---------------|------------------------------------------------|
| Font          | Anton, Montserrat Black, or Inter Black        |
| Font size     | 96                                             |
| Tracking      | 0                                              |
| Fill          | White (`#FFFFFF`) — exposed                    |
| Stroke        | Black, 8 px, outside                           |
| Shadow        | Black, opacity 75%, distance 6, blur 12        |
| Alignment     | Center, anchor centered                        |
| Position      | Center of frame, slightly below middle (60% Y) |
| Animation     | None — pop-in is added by the mapper           |

> The mapper adds the scale 0→100 pop-in via Motion → Scale keyframes at
> runtime, so do **not** bake any scale animation into the MOGRT itself or
> they will fight each other.

---

## Style spec — Clean Medical

For professional/clinical voiceover content.

| Property      | Value                                          |
|---------------|------------------------------------------------|
| Font          | Inter Medium, SF Pro Text, or Helvetica Neue   |
| Font size     | 64                                             |
| Tracking      | 20                                             |
| Fill          | White (`#FFFFFF`) — exposed                    |
| Stroke        | None, or 1–2 px subtle dark grey               |
| Shadow        | None, or very soft (opacity 30%, distance 2)   |
| Alignment     | Center, anchor centered                        |
| Position      | Lower third (~80% Y)                           |
| Background    | Optional rounded pill, 70% black, 16 px pad    |
| Animation     | None — pop-in is added by the mapper           |

---

## Verify before shipping

After export, drag each `.mogrt` into a test sequence and confirm:

1. Essential Graphics panel shows `Source Text` and `Fill Color` as editable
   controls (with **those exact labels**).
2. Changing `Source Text` updates the rendered word.
3. Changing `Fill Color` to yellow paints the word yellow.

If any of those three checks fail, the mapper will not be able to drive the
template at runtime.
