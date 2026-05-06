/**
 * Kalakar Auto Captions — Premiere Pro UXP timeline integration.
 *
 * Maps a Whisper word-level JSON response onto the active sequence by inserting
 * one Essential Graphics (MOGRT) clip per word, with a pop-in scale animation
 * and a yellow highlight on the active word (white otherwise).
 *
 * Whisper JSON shape (verbose_json + timestamp_granularities=["word"]):
 *   {
 *     "task": "transcribe",
 *     "language": "en",
 *     "duration": 12.34,
 *     "text": "...",
 *     "words": [
 *       { "word": "Hello", "start": 0.00, "end": 0.42 },
 *       { "word": "world", "start": 0.45, "end": 0.91 }
 *     ]
 *   }
 */

const ppro = require("premierepro");
const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;

// Premiere Pro internal time base: 254016000000 ticks per second.
const TICKS_PER_SECOND = 254016000000n;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function secondsToTickTime(seconds) {
  // ppro.TickTime expects a string of ticks (BigInt) for sub-frame accuracy.
  const ticks = BigInt(Math.round(seconds * Number(TICKS_PER_SECOND) / 1));
  return ppro.TickTime.createWithTicks(ticks.toString());
}

function ticksStringFromSeconds(seconds) {
  return BigInt(Math.round(seconds * 1e9) * 254016 / 1).toString();
}

// ---------------------------------------------------------------------------
// Style presets — map "Bold Viral" / "Clean Medical" to MOGRT parameter sets
// ---------------------------------------------------------------------------

// All presets share one MOGRT (`bold-viral.mogrt`); only the parameters the
// mapper drives at runtime differ — highlight Fill Color (exposed in the MOGRT)
// and the Motion → Scale pop-in duration (added by the mapper as keyframes).
// Anything baked into the MOGRT itself (font, stroke, shadow) stays constant
// across presets unless you expose it as an additional EGP parameter.
const SHARED_MOGRT = "templates/bold-viral.mogrt";

const STYLE_PRESETS = {
  "Bold Viral": {
    mogrtFile: SHARED_MOGRT,
    baseColor: { r: 1.0, g: 1.0, b: 1.0 },         // White
    highlightColor: { r: 1.0, g: 0.92, b: 0.0 },   // Yellow — punchy
    popInDurationSec: 0.10,                        // Snappy
  },
  "Clean Medical": {
    mogrtFile: SHARED_MOGRT,
    baseColor: { r: 1.0, g: 1.0, b: 1.0 },
    highlightColor: { r: 1.0, g: 0.78, b: 0.30 },  // Soft amber
    popInDurationSec: 0.20,                        // Gentle
  },
  "Tech Minimal": {
    mogrtFile: SHARED_MOGRT,
    baseColor: { r: 1.0, g: 1.0, b: 1.0 },
    highlightColor: { r: 0.20, g: 0.85, b: 1.0 },  // Electric cyan
    popInDurationSec: 0.14,
  },
};

// ---------------------------------------------------------------------------
// WhisperTimelineMapper
// ---------------------------------------------------------------------------

// Stage 1 implementation against the real Premiere UXP API discovered at
// runtime. Per-word workflow:
//   1. ppro.SequenceEditor.getEditor(sequence).insertMogrtFromPath(...)
//   2. Read the just-inserted track item from V2
//   3. Walk its VideoComponentChain → for each Component, look up its
//      Properties via ppro.Properties.getProperties(component) and override
//      "Source Text" to the word.
// Fill Color override and pop-in keyframes are deferred to Stage 2 — small
// surface area first, debug deltas easier.
class WhisperTimelineMapper {
  constructor({ project, sequence, mogrtRoot }) {
    this.project = project;
    this.sequence = sequence;
    this.mogrtRoot = mogrtRoot;
  }

  static async create() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("No active Premiere Pro project.");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("No active sequence — open one first.");
    const pluginFolder = await fs.getPluginFolder();
    const mogrtRoot = await pluginFolder.getEntry("templates");
    return new WhisperTimelineMapper({ project, sequence, mogrtRoot });
  }

  async mapWhisperToTimeline(whisperData, options = {}) {
    console.log("@@@ KALAKAR BUILD v13 — overrides reuse fix @@@");
    const styleName = options.styleTemplate || "Bold Viral";
    const preset = STYLE_PRESETS[styleName];
    if (!preset) throw new Error(`Unknown style: ${styleName}`);

    const words = (whisperData && whisperData.words) || [];
    if (!words.length) {
      return { success: false, clipsCreated: 0, errors: ["No words in Whisper JSON"] };
    }

    const captionTrackIndex = 1; // V2
    const trackCount = await this.sequence.getVideoTrackCount();
    if (trackCount <= captionTrackIndex) {
      return {
        success: false,
        clipsCreated: 0,
        errors: [`Sequence has only ${trackCount} video tracks — need at least ${captionTrackIndex + 1}.`],
      };
    }

    const mogrtPath = await this.resolveMogrtPath(preset.mogrtFile);
    console.log(`[Kalakar] mogrtPath = ${mogrtPath}`);

    const editor = await ppro.SequenceEditor.getEditor(this.sequence);
    console.log(`[Kalakar] editor = ${editor && editor.constructor && editor.constructor.name}`);

    const errors = [];
    let clipsCreated = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      try {
        await this.insertWordClip({
          editor,
          mogrtPath,
          word: String(word.word).trim(),
          startSec: Number(word.start),
          captionTrackIndex,
        });
        clipsCreated++;
      } catch (err) {
        console.error(`[Kalakar] word #${i} "${word.word}":`, err);
        errors.push({ wordIndex: i, word: word.word, message: err.message });
      }
    }

    return {
      success: errors.length === 0,
      clipsCreated,
      errors,
      metadata: {
        style: styleName,
        language: whisperData.language,
        duration: whisperData.duration,
        wordCount: words.length,
      },
    };
  }

  async insertWordClip({ editor, mogrtPath, word, startSec, captionTrackIndex }) {
    const startTime = ppro.TickTime.createWithSeconds(startSec);
    console.log(`[Kalakar] inserting "${word}" @ ${startSec}s on V${captionTrackIndex + 1}`);
    console.log(`[Kalakar] mogrtPath = ${mogrtPath}`);

    // First word: try a battery of signature variants and use whichever one
    // returns a truthy track item. Subsequent words skip straight to the
    // winning variant via this._winningInsert.
    if (!this._winningInsert) {
      const altPath = mogrtPath.replace(/\\/g, "/"); // forward-slash variant
      // 5th-arg overrides: undocumented but worth probing — Adobe APIs sometimes
      // accept a parameter-defaults object on insert.
      const overrides = { "Source Text": word };
      const overridesAlt = [{ name: "Source Text", value: word }];
      const candidates = [
        ["O1 path,time,V,A=0,{params}",  () => editor.insertMogrtFromPath(mogrtPath, startTime, captionTrackIndex, 0, overrides)],
        ["O2 path,time,V,A=0,[params]",  () => editor.insertMogrtFromPath(mogrtPath, startTime, captionTrackIndex, 0, overridesAlt)],
        ["O3 path,time,V,A=0,word",      () => editor.insertMogrtFromPath(mogrtPath, startTime, captionTrackIndex, 0, word)],
        ["A path,time,V,A=0",            () => editor.insertMogrtFromPath(mogrtPath, startTime, captionTrackIndex, 0)],
        ["B path,time,V (no audio arg)", () => editor.insertMogrtFromPath(mogrtPath, startTime, captionTrackIndex)],
        ["C path,time,V,A=-1",           () => editor.insertMogrtFromPath(mogrtPath, startTime, captionTrackIndex, -1)],
        ["D path/,time,V,A=0",           () => editor.insertMogrtFromPath(altPath, startTime, captionTrackIndex, 0)],
        ["E path,V,A,time",              () => editor.insertMogrtFromPath(mogrtPath, captionTrackIndex, 0, startTime)],
        ["F path,seconds,V,A=0",         () => editor.insertMogrtFromPath(mogrtPath, startTime.seconds, captionTrackIndex, 0)],
        ["G path,V,time",                () => editor.insertMogrtFromPath(mogrtPath, captionTrackIndex, startTime)],
      ];
      for (const [label, fn] of candidates) {
        try {
          const r = await fn();
          console.log(`[Kalakar] sig ${label} → ok, returned:`, r,
            `type=${r && r.constructor && r.constructor.name}`);
          if (r) {
            this._winningInsert = { label, fn: (w, t, vi) => {
              const localStart = ppro.TickTime.createWithSeconds(t);
              const localPath = label.includes("path/") ? altPath : mogrtPath;
              const ovr = { "Source Text": w };
              const ovrAlt = [{ name: "Source Text", value: w }];
              if (label.startsWith("O1")) return editor.insertMogrtFromPath(localPath, localStart, vi, 0, ovr);
              if (label.startsWith("O2")) return editor.insertMogrtFromPath(localPath, localStart, vi, 0, ovrAlt);
              if (label.startsWith("O3")) return editor.insertMogrtFromPath(localPath, localStart, vi, 0, w);
              if (label.startsWith("A "))  return editor.insertMogrtFromPath(localPath, localStart, vi, 0);
              if (label.startsWith("B "))  return editor.insertMogrtFromPath(localPath, localStart, vi);
              if (label.startsWith("C "))  return editor.insertMogrtFromPath(localPath, localStart, vi, -1);
              if (label.startsWith("D "))  return editor.insertMogrtFromPath(altPath, localStart, vi, 0);
              if (label.startsWith("E "))  return editor.insertMogrtFromPath(localPath, vi, 0, localStart);
              if (label.startsWith("F "))  return editor.insertMogrtFromPath(localPath, t, vi, 0);
              if (label.startsWith("G "))  return editor.insertMogrtFromPath(localPath, vi, localStart);
            }};
            // already inserted once for this word, reuse `r`
            const inserted = r;
            return await this._applySourceText(inserted, word, captionTrackIndex, startSec);
          }
        } catch (err) {
          console.log(`[Kalakar] sig ${label} → ${err.message}`);
        }
      }
      throw new Error("All insertMogrtFromPath signatures failed — see console");
    }

    const inserted = await this._winningInsert.fn(word, startSec, captionTrackIndex);
    console.log(`[Kalakar] reused signature ${this._winningInsert.label}, returned:`, inserted);
    if (!inserted) {
      throw new Error("insertMogrtFromPath returned null on subsequent call");
    }
    return await this._applySourceText(inserted, word, captionTrackIndex, startSec);
  }

  async _applySourceText(inserted, word, captionTrackIndex, startSec) {
    // The reference returned by insertMogrtFromPath can be a stale snapshot
    // taken before MOGRT components ("Graphic Parameters") fully attach. Wait
    // a tick and re-fetch the freshest matching item from the track.
    await this._sleep(150);

    const item = await this._findFreshItem(captionTrackIndex, startSec);
    if (!item) {
      console.log(`[Kalakar] "${word}" — fresh item lookup failed, fallback to inserted ref`);
    }
    const target = item || (Array.isArray(inserted) ? inserted[0] : inserted);
    const itemType = (target && target.constructor && target.constructor.name) || typeof target;

    if (!target || typeof target.getComponentChain !== "function") {
      console.log(`[Kalakar]   no usable item for "${word}" (type=${itemType})`);
      return;
    }

    const chain = await target.getComponentChain();
    const count = await chain.getComponentCount();
    console.log(`[Kalakar]   ${itemType} componentChain.count = ${count}`);

    // Build all SetValueActions OUTSIDE the transaction (async-safe), then
    // commit them in a sync callback so addAction calls aren't dropped.
    const actions = [];
    const doParamEnum = !this._loggedParams;

    for (let ci = 0; ci < count; ci++) {
      const comp = await chain.getComponentAtIndex(ci);
      const dn = comp.getDisplayName ? await comp.getDisplayName() : "?";
      const mn = comp.getMatchName ? await comp.getMatchName() : "?";
      console.log(`[Kalakar]     component[${ci}] displayName="${dn}" matchName="${mn}"`);

      // "AE.ADBE Capsule" is the synthetic component holding all the params
      // a MOGRT explicitly exposes via the Essential Graphics panel. Premiere
      // labels these params after the source layer name (e.g. "QHT") rather
      // than the underlying property name ("Source Text"), so match the
      // component instead and treat its first param as the text source.
      const isMogrtCapsule = mn === "AE.ADBE Capsule" || dn === "Graphic Parameters";

      const pc = await comp.getParamCount();
      if (doParamEnum) console.log(`[Kalakar]       paramCount = ${pc}`);

      for (let pi = 0; pi < (pc || 0); pi++) {
        const p = await comp.getParam(pi);
        if (!p) continue;

        const pdnRaw = p.displayName;
        const pdn = typeof pdnRaw === "function" ? await pdnRaw.call(p) : pdnRaw;
        if (doParamEnum) console.log(`[Kalakar]       param[${pi}] dn="${pdn}"`);

        const lc = typeof pdn === "string" ? pdn.trim().toLowerCase() : "";

        // Heuristics for "this param is the source text":
        //   1. Explicit name like "Source Text" / "Text".
        //   2. First exposed param of the MOGRT capsule (single-text-layer
        //      MOGRTs label this with the layer name, not "Source Text").
        const explicitTextName =
          lc === "source text" ||
          lc === "text" ||
          lc === "source text 1" ||
          lc.startsWith("source text");
        const isFirstCapsuleParam = isMogrtCapsule && pi === 0;

        if (!(explicitTextName || isFirstCapsuleParam)) continue;

        // Deep probe so we can see what shape the API actually wants.
        try {
          const sv = typeof p.getStartValue === "function" ? await p.getStartValue() : "(no)";
          const tv = typeof p.isTimeVarying === "function" ? await p.isTimeVarying() : "(?)";
          const kf = typeof p.areKeyframesSupported === "function"
            ? await p.areKeyframesSupported() : "(?)";
          let vat = "(skip)";
          if (typeof p.getValueAtTime === "function") {
            try {
              const t0 = ppro.TickTime.TIME_ZERO || ppro.TickTime.createWithSeconds(0);
              vat = await p.getValueAtTime(t0);
            } catch (e) { vat = `err:${e.message}`; }
          }
          console.log(`[Kalakar]     param[${pi}] startValue:`, sv,
            ` valueAt0:`, vat, ` isTimeVarying=${tv} keyframesSupported=${kf}`);
        } catch (err) {
          console.log(`[Kalakar]     param[${pi}] probe err: ${err.message}`);
        }

        // Try a battery of approaches and use the first one whose Action is
        // non-null and whose creation didn't throw.
        const t0 = ppro.TickTime.createWithSeconds(0);
        const tryShapes = [
          ["setValue(string)",          () => p.createSetValueAction(word)],
          ["setValue({text})",          () => p.createSetValueAction({ text: word })],
          ["addKeyframe(t0, string)",   () => p.createAddKeyframeAction(t0, word)],
          ["addKeyframe(t0, {text})",   () => p.createAddKeyframeAction(t0, { text: word })],
          ["setValue(string, persist)", () => p.createSetValueAction(word, true)],
          ["setValue({value})",         () => p.createSetValueAction({ value: word })],
        ];
        let chosen = null;
        for (const [label, fn] of tryShapes) {
          try {
            const act = fn();
            const okStr = act ? "Action ok" : "null";
            console.log(`[Kalakar]     ${label} → ${okStr}`);
            if (act && !chosen) chosen = { label, act };
          } catch (err) {
            console.log(`[Kalakar]     ${label} threw: ${err.message}`);
          }
        }

        if (chosen) {
          console.log(`[Kalakar]     -> using "${chosen.label}" for param[${pi}]("${pdn}") := "${word}"`);
          // For keyframe shapes we also need to flip the param into time-varying
          // mode first; harmless on params that ignore it.
          if (chosen.label.startsWith("addKeyframe") && typeof p.createSetTimeVaryingAction === "function") {
            try {
              const tvAct = p.createSetTimeVaryingAction(true);
              if (tvAct) actions.push(tvAct);
            } catch (e) {
              console.log(`[Kalakar]     timeVarying(true) threw: ${e.message}`);
            }
          }
          actions.push(chosen.act);
        } else {
          console.log(`[Kalakar]     no working setter found for param[${pi}]`);
        }
      }
    }
    this._loggedParams = true;

    if (actions.length === 0) {
      console.log(`[Kalakar]   no Source Text param matched on ${itemType}`);
      return;
    }

    await this.project.executeTransaction(
      (ca) => { for (const a of actions) ca.addAction(a); },
      `Kalakar — Set text "${word}"`
    );
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Find the track item on the caption track whose start time is closest to
   * `startSec`. We use this instead of the reference returned by
   * insertMogrtFromPath because that reference is sometimes a stale snapshot.
   */
  async _findFreshItem(captionTrackIndex, startSec) {
    try {
      const track = await this.sequence.getVideoTrack(captionTrackIndex);
      const items = await this.getTrackItemsSafe(track);
      if (!items.length) return null;

      // Match by closest startTime to our requested startSec.
      let best = null, bestDelta = Infinity;
      for (const it of items) {
        try {
          const st = await it.getStartTime();
          const sec = typeof st.seconds === "function" ? await st.seconds() : st.seconds;
          const delta = Math.abs(Number(sec) - Number(startSec));
          if (delta < bestDelta) { bestDelta = delta; best = it; }
        } catch (_) {}
      }
      return best;
    } catch (err) {
      console.log(`[Kalakar] _findFreshItem error: ${err.message}`);
      return null;
    }
  }

  // ---- helpers ----------------------------------------------------------

  async resolveMogrtPath(relativePath) {
    const entry = await this.mogrtRoot.getEntry(relativePath.replace(/^templates\//, ""));
    return entry.nativePath;
  }

  /**
   * Premiere's getTrackItems requires a TrackItemType filter — unfiltered call
   * throws "Illegal Parameter type". Probe each known TrackItemType value and
   * concatenate. Returns [] on total failure.
   */
  async getTrackItemsSafe(track) {
    const TT = ppro.Constants.TrackItemType || {};
    const candidateTypes = Object.values(TT).filter((v) => typeof v === "number");
    const seen = new Set();
    const items = [];
    for (const t of candidateTypes.length ? candidateTypes : [1, 2, 3, 4]) {
      try {
        const got = await track.getTrackItems(t, false);
        for (const it of got || []) {
          const key = (it.id || it.getName?.() || JSON.stringify(it));
          if (!seen.has(key)) { seen.add(key); items.push(it); }
        }
      } catch (_) { /* this type filter not supported, continue */ }
    }
    return items;
  }

  async collectTrackItemIds(track) {
    const items = await this.getTrackItemsSafe(track);
    return new Set(items.map((it) => it.id || it.getName?.()));
  }
}

// ---------------------------------------------------------------------------
// Public entry point — the React panel calls this from index.jsx.
// ---------------------------------------------------------------------------

async function processWhisperCaptions(whisperData, styleOptions = {}) {
  const mapper = await WhisperTimelineMapper.create();
  return mapper.mapWhisperToTimeline(whisperData, styleOptions);
}

/**
 * Future-proofing: forward project metadata to an n8n webhook once captions
 * are placed. Called by the panel after a successful run.
 */
async function notifyN8n(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "kalakar-auto-captions", ...payload }),
  });
  return { ok: res.ok, status: res.status };
}

// ---------------------------------------------------------------------------
// Diagnostic — probe the Premiere UXP API surface and log everything we can
// reach. No timeline mutations. Use this on a new Premiere version to learn
// which method names are actually available before writing real insertion
// logic against them.
// ---------------------------------------------------------------------------

async function discoverPremiereApi() {
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };

  function dumpInstance(label, obj) {
    if (!obj) { log(`[${label}] <null/undefined>`); return; }
    const typeName = (obj.constructor && obj.constructor.name) || typeof obj;
    const own = Object.getOwnPropertyNames(obj);
    const proto = obj.constructor && obj.constructor.prototype
      ? Object.getOwnPropertyNames(obj.constructor.prototype)
      : [];
    log(`[${label}] type=${typeName}`);
    log(`  own:   ${own.join(", ") || "(none)"}`);
    log(`  proto: ${proto.join(", ") || "(none)"}`);
  }

  function dumpClass(name, klass) {
    if (!klass) { log(`[${name} class] <missing>`); return; }
    const statics = Object.getOwnPropertyNames(klass)
      .filter((k) => !["length", "name", "prototype"].includes(k));
    const proto = klass.prototype
      ? Object.getOwnPropertyNames(klass.prototype).filter((k) => k !== "constructor")
      : [];
    log(`[${name} class]`);
    log(`  static: ${statics.join(", ") || "(none)"}`);
    log(`  proto:  ${proto.join(", ") || "(none)"}`);
  }

  const result = { success: false, errors: [], dump: "" };

  try {
    log(`@@ DISCOVERY v3 @@ loaded at ${new Date().toISOString()}`);
    log("");

    log("=== ppro top-level keys ===");
    const pproKeys = Object.keys(ppro).sort();
    for (const k of pproKeys) {
      log(`  ppro.${k} → ${typeof ppro[k]}`);
    }

    log("\n=== Likely classes for clip insertion / MOGRT ===");
    const classCandidates = [
      // already-known core
      "Project", "Sequence", "VideoTrack", "AudioTrack", "CaptionTrack",
      "VideoClipTrackItem", "AudioClipTrackItem",
      "ProjectItem", "ClipProjectItem", "FolderItem",
      "TickTime", "Markers", "Marker",
      "Component", "VideoComponentChain", "AudioComponentChain",
      "Action", "CompoundAction",
      "Color", "PointF", "RectF",
      // newly suspected — these are the prime suspects for insertion / props
      "SequenceEditor", "SequenceUtils", "ProjectUtils", "Utils",
      "Properties", "Application",
      "TransitionFactory", "AudioFilterFactory", "VideoFilterFactory",
      "TrackItemSelection", "ProjectItemSelection",
      "TextSegments", "Transcript", "Metadata",
      "EncoderManager", "Exporter", "SourceMonitor",
      "ProjectConverter", "AddTransitionOptions",
    ];
    for (const name of classCandidates) {
      if (ppro[name]) dumpClass(name, ppro[name]);
    }

    log("\n=== Live Project / Sequence ===");
    const project = await ppro.Project.getActiveProject();
    dumpInstance("project", project);
    if (!project) throw new Error("No active project");

    const seq = await project.getActiveSequence();
    dumpInstance("sequence", seq);
    if (!seq) throw new Error("No active sequence");

    if (typeof seq.getVideoTrackCount === "function") {
      const count = await seq.getVideoTrackCount();
      log(`\nvideoTrackCount = ${count}`);
      if (count > 0 && typeof seq.getVideoTrack === "function") {
        const t0 = await seq.getVideoTrack(0);
        dumpInstance("track0", t0);

        // If the track already has clips, dump one — its componentChain shape
        // teaches us how to read MOGRT params at runtime.
        if (typeof t0.getTrackItems === "function") {
          const items = await t0.getTrackItems();
          log(`\ntrack0 trackItems count = ${items && items.length}`);
          if (items && items.length > 0) {
            dumpInstance("trackItem0", items[0]);
            if (typeof items[0].getComponentChain === "function") {
              const chain = await items[0].getComponentChain();
              dumpInstance("componentChain", chain);
              if (chain && typeof chain.getComponentCount === "function") {
                const cc = await chain.getComponentCount();
                log(`componentChain.componentCount = ${cc}`);
                if (cc > 0) {
                  const comp = await chain.getComponentAtIndex(0);
                  dumpInstance("component0", comp);
                  if (typeof comp.getParamCount === "function") {
                    const pc = await comp.getParamCount();
                    log(`component0.paramCount = ${pc}`);
                    if (pc > 0 && typeof comp.getParam === "function") {
                      const p0 = await comp.getParam(0);
                      dumpInstance("param0", p0);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    log("\n=== Project method probes ===");
    const projProbes = [
      "importFiles", "createImportFileAction", "getRootItem",
      "executeTransaction", "lockedAccess", "createTransaction",
      "openSequence", "createNewSequence",
    ];
    for (const name of projProbes) {
      log(`  project.${name} → ${typeof project[name]}`);
    }

    log("\n=== ppro.Constants own keys ===");
    if (ppro.Constants) {
      for (const k of Object.keys(ppro.Constants).sort()) {
        log(`  Constants.${k}`);
      }
    }

    result.success = true;
  } catch (err) {
    result.errors.push(err.message);
    log(`\n!! Discovery error: ${err.message}`);
    console.error(err);
  }

  result.dump = lines.join("\n");
  return result;
}

module.exports = {
  WhisperTimelineMapper,
  processWhisperCaptions,
  notifyN8n,
  discoverPremiereApi,
  STYLE_PRESETS,
};
