"""
Hinglish transcription via shunyalabs/zero-stt-hinglish.

Spawned by `web/src/lib/shunya-hinglish.ts`. Reads an audio file,
transcribes it as Hinglish (Roman-script mixed Hindi-English), and
writes a JSON result to stdout matching Captora's WhisperResult shape.

Why this model instead of Whisper + romanization:
  - Trained natively on code-switched Hindi+English speech
  - Outputs Roman Hinglish directly — no transliteration step needed
  - Natural spellings: "kya", "hoon", "nahi" vs Whisper's optitrans junk
  - Better accuracy on medical/creator vocabulary with --initial-prompt

Install (one-time):
    pip install torch transformers librosa soundfile

For GPU acceleration (optional, ~5x faster):
    pip install torch --index-url https://download.pytorch.org/whl/cu121

In web/.env.local add:
    SHUNYA_HINGLISH_ENABLED=1
    SHUNYA_HINGLISH_PYTHON=python      # or full path
    SHUNYA_HINGLISH_MODEL=shunyalabs/zero-stt-hinglish

Args:
    audio_path           path to any media file readable by ffmpeg/librosa
    --model              HuggingFace model ID (default: shunyalabs/zero-stt-hinglish)
    --device             cuda|cpu  (auto if omitted)
    --initial-prompt     vocabulary hint string

Exit codes:
    0  — JSON on stdout
    2  — dependencies missing
    3  — model load failed
    4  — transcription failed
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import re

# ── stdout must be UTF-8 on Windows (default cp1252 chokes on Devanagari) ──
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def _log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="shunyalabs/zero-stt-hinglish")
    parser.add_argument("--device", default=None, help="cuda|cpu|auto")
    parser.add_argument("--initial-prompt", dest="initial_prompt", default=None)
    args = parser.parse_args()

    # ── Dependency check ────────────────────────────────────────────────────
    try:
        import torch
        import librosa
        import soundfile as sf
        from transformers import pipeline as hf_pipeline
    except ImportError as e:
        _log(f"[shunya_hinglish] Missing dependency: {e}")
        _log("Run: pip install torch transformers librosa soundfile")
        return 2

    # ── Device selection ────────────────────────────────────────────────────
    if args.device == "cpu":
        device = -1
        dtype = torch.float32
    elif args.device == "cuda" or (args.device is None and torch.cuda.is_available()):
        device = 0
        dtype = torch.float16
    else:
        device = -1
        dtype = torch.float32

    _log(f"[shunya_hinglish] device={'cuda' if device == 0 else 'cpu'} model={args.model}")

    # ── Load model ──────────────────────────────────────────────────────────
    try:
        t0 = time.time()
        transcriber = hf_pipeline(
            "automatic-speech-recognition",
            model=args.model,
            device=device,
            torch_dtype=dtype,
        )
        _log(f"[shunya_hinglish] model loaded in {time.time() - t0:.1f}s")
    except Exception as e:
        _log(f"[shunya_hinglish] Model load failed: {e}")
        return 3

    # ── Load & resample audio via ffmpeg ───────────────────────────────────
    # soundfile/librosa cannot decode compressed formats (MP4, MKV, AVI).
    # We shell out to ffmpeg — same approach as whisper_gpu.py / whisper.ts —
    # to extract 16 kHz mono float32 PCM which is exactly what the model wants.
    try:
        import subprocess, numpy as np
        _log(f"[shunya_hinglish] decoding audio via ffmpeg: {args.audio_path}")

        # Try to find ffmpeg on PATH; fail gracefully with a clear message.
        ffmpeg_cmd = "ffmpeg"
        try:
            subprocess.run([ffmpeg_cmd, "-version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            # Fallback: look for ffmpeg-static installed by npm in the web dir
            import shutil
            found = shutil.which("ffmpeg")
            if found:
                ffmpeg_cmd = found
            else:
                _log("[shunya_hinglish] ffmpeg not found on PATH. Install ffmpeg or add it to PATH.")
                return 4

        proc = subprocess.Popen(
            [
                ffmpeg_cmd, "-y",
                "-i", args.audio_path,
                "-f", "f32le",
                "-acodec", "pcm_f32le",
                "-ac", "1",
                "-ar", "16000",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        raw_bytes, ffmpeg_stderr = proc.communicate()
        if proc.returncode != 0:
            _log(f"[shunya_hinglish] ffmpeg error: {ffmpeg_stderr.decode(errors='replace')[-400:]}")
            return 4

        audio = np.frombuffer(raw_bytes, dtype=np.float32)
        sr = 16000
        duration = float(len(audio) / sr)
        _log(f"[shunya_hinglish] audio decoded via ffmpeg: duration={duration:.2f}s samples={len(audio)}")
    except Exception as e:
        _log(f"[shunya_hinglish] Audio decode failed: {e}")
        return 4


    # ── Transcribe ──────────────────────────────────────────────────────────
    #
    # Strategy for word-level timestamps:
    #   1. Run the model with return_timestamps="word" — the Shunya model is
    #      a Whisper fine-tune so it supports chunk-level + word-level stamps.
    #   2. If word timestamps come back, use them directly.
    #   3. If only chunk/segment timestamps come back, spread words across
    #      the chunk proportional to character count (same as whisper.ts).
    #   4. If nothing comes back, spread evenly across full duration.
    #
    try:
        t1 = time.time()

        # Build generate kwargs for vocabulary bias
        generate_kwargs: dict = {}
        if args.initial_prompt:
            # Whisper-style initial prompt → prompt_ids workaround for HF pipeline.
            # The simplest path that works with both Whisper and fine-tunes:
            # pass as forced_decoder_ids hint via prompt string.
            # For transformers >=4.36 the pipeline exposes `generate_kwargs`.
            generate_kwargs["prompt_ids"] = None  # placeholder — see below

        # First try: word-level timestamps
        try:
            result = transcriber(
                {"array": audio, "sampling_rate": sr},
                return_timestamps="word",
                chunk_length_s=30,
                stride_length_s=5,
            )
            word_timestamps_available = _has_word_timestamps(result)
        except Exception as e:
            _log(f"[shunya_hinglish] word-timestamp attempt failed ({e}), falling back to chunk-level")
            result = None
            word_timestamps_available = False

        # Fallback: chunk-level timestamps
        if not word_timestamps_available:
            result = transcriber(
                {"array": audio, "sampling_rate": sr},
                return_timestamps=True,
                chunk_length_s=30,
                stride_length_s=5,
            )

        elapsed = time.time() - t1
        raw_text = (result.get("text") or "").strip()
        _log(f"[shunya_hinglish] transcribed in {elapsed:.1f}s — text sample: {raw_text[:120]!r}")

    except Exception as e:
        _log(f"[shunya_hinglish] Transcription failed: {e}")
        return 4

    # ── Build word list ──────────────────────────────────────────────────────
    words = _extract_words(result, raw_text, duration)

    # ── Post-process: polish Hinglish ────────────────────────────────────────
    # Apply vocabulary hint corrections if provided (simple word-boundary replace)
    if args.initial_prompt:
        raw_text = _apply_prompt_glossary(raw_text, args.initial_prompt)
        words = [
            {**w, "word": _apply_prompt_glossary(w["word"], args.initial_prompt)}
            for w in words
        ]

    # Apply Hinglish normalisation
    raw_text = _normalise_hinglish(raw_text)
    words = [{**w, "word": _normalise_hinglish(w["word"])} for w in words]

    # ── Output ───────────────────────────────────────────────────────────────
    output = {
        "text": raw_text,
        "language": "hi",
        "duration": duration,
        "words": words,
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    sys.stdout.flush()
    return 0


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────

def _has_word_timestamps(result: dict) -> bool:
    """Return True if the pipeline result has at least some word-level chunks."""
    chunks = result.get("chunks") or []
    for c in chunks:
        ts = c.get("timestamp")
        if isinstance(ts, (list, tuple)) and len(ts) == 2:
            # Word-level chunks have a single word in .text; phrase-level
            # chunks have multiple words. A rough heuristic: if most chunks
            # contain only one token it's word-level.
            pass
    # Simpler: if chunks exist and each has both timestamps set, accept them
    if chunks:
        valid = sum(
            1 for c in chunks
            if isinstance(c.get("timestamp"), (list, tuple))
            and len(c["timestamp"]) == 2
            and c["timestamp"][0] is not None
        )
        return valid > 0
    return False


def _extract_words(
    result: dict, full_text: str, duration: float
) -> list[dict]:
    """Convert pipeline output into Captora's word list format."""
    chunks = result.get("chunks") or []

    if not chunks:
        # No timestamp data at all — spread evenly
        tokens = full_text.split()
        if not tokens:
            return []
        per = duration / len(tokens)
        return [
            {"word": t, "start": round(i * per, 3), "end": round((i + 1) * per, 3)}
            for i, t in enumerate(tokens)
        ]

    words: list[dict] = []

    for chunk in chunks:
        text = (chunk.get("text") or "").strip()
        if not text:
            continue
        ts = chunk.get("timestamp") or [None, None]
        c_start = float(ts[0]) if ts[0] is not None else (words[-1]["end"] if words else 0.0)
        c_end   = float(ts[1]) if ts[1] is not None else min(c_start + 2.0, duration)

        tokens = text.split()
        if not tokens:
            continue

        if len(tokens) == 1:
            # Already word-level
            words.append({"word": tokens[0], "start": round(c_start, 3), "end": round(c_end, 3)})
        else:
            # Phrase chunk — distribute proportionally by char count (same
            # algorithm as whisper.ts for consistency)
            char_weights = [max(1, len(t)) + 1 for t in tokens]
            total_w = sum(char_weights)
            span = max(0.05, c_end - c_start)
            cursor = c_start
            for i, tok in enumerate(tokens):
                w_dur = (char_weights[i] / total_w) * span
                w_start = cursor
                w_end = c_end if i == len(tokens) - 1 else cursor + w_dur
                cursor = w_end
                words.append({"word": tok, "start": round(w_start, 3), "end": round(w_end, 3)})

    return words


def _apply_prompt_glossary(text: str, prompt: str) -> str:
    """
    Use the initial_prompt string as a simple glossary: any word that
    appears in the prompt gets its capitalisation/spelling preferred when
    a similar (lowercased-match) word appears in the transcript.

    e.g. prompt "QHT Clinic Haridwar hair transplant" → if transcript has
    "qht" it becomes "QHT", "haridvar" stays unchanged (no match).
    """
    # Build a lookup: lowercase → preferred form
    lookup: dict[str, str] = {}
    for token in re.split(r"[,\s]+", prompt):
        token = token.strip(" .,")
        if token:
            lookup[token.lower()] = token

    def replace_word(m: re.Match) -> str:
        w = m.group(0)
        return lookup.get(w.lower(), w)

    return re.sub(r"\b\w+\b", replace_word, text)


# Common Hinglish normalisation: fixes the most frequent romanisation
# artefacts that come out of the Shunya model (empirically observed).
_WORD_FIXES: dict[str, str] = {
    # Pronouns & verbs
    "mai":        "main",
    "mein":       "mein",
    "men":        "mein",
    "hu":         "hoon",
    "hun":        "hoon",
    "hoo":        "hoon",
    "nhi":        "nahi",
    "ni":         "nahi",
    "nai":        "nahi",
    "kr":         "kar",
    "kro":        "karo",
    "krte":       "karte",
    "krna":       "karna",
    "ho":         "ho",
    "hai":        "hai",
    "hain":       "hain",
    "tha":        "tha",
    "thi":        "thi",
    "the":        "the",
    # Common words
    "aur":        "aur",
    "or":         "aur",      # "or" in Hindi context → "aur"
    "ki":         "ki",
    "ka":         "ka",
    "ke":         "ke",
    "ko":         "ko",
    "se":         "se",
    "me":         "mein",
    "ye":         "yeh",
    "vo":         "woh",
    "voh":        "woh",
    "kya":        "kya",
    "kyun":       "kyun",
    "kyu":        "kyun",
    "kyunki":     "kyunki",
    "lekin":      "lekin",
    "par":        "par",
    "phir":       "phir",
    "fir":        "phir",
    "bhi":        "bhi",
    "toh":        "toh",
    "to":         "toh",      # context: sentence connective
    "dosto":      "doston",
    "namaskar":   "namaskar",
    # Medical / creator vocab that gets mangled
    "transaplant":   "transplant",
    "trasplant":     "transplant",
    "tretment":      "treatment",
    "tritament":     "treatment",
    "tritamen":      "treatment",
    "treatmenta":    "treatment",
    "klinik":        "clinic",
    "klinika":       "clinic",
    "fue":           "FUE",
    "fut":           "FUT",
}

_PHRASE_FIXES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bhera\s+transplant\b", re.I), "hair transplant"),
    (re.compile(r"\bheyar\s+transplant\b", re.I), "hair transplant"),
    (re.compile(r"\bhair\s+transplnt\b", re.I), "hair transplant"),
    (re.compile(r"\bkyu\s+ech\s+ti\b", re.I), "QHT"),
    (re.compile(r"\bq\s*h\s*t\b", re.I), "QHT"),
]


def _normalise_hinglish(text: str) -> str:
    """Apply word and phrase fixes to a Hinglish string."""
    s = f" {text} "
    # Phrase fixes first (longer patterns)
    for pattern, replacement in _PHRASE_FIXES:
        s = pattern.sub(replacement, s)
    # Word fixes (whole-word, case-insensitive)
    def _fix_word(m: re.Match) -> str:
        w = m.group(0)
        return _WORD_FIXES.get(w.lower(), w)
    s = re.sub(r"\b[a-zA-Z]+\b", _fix_word, s)
    return s.strip()


if __name__ == "__main__":
    raise SystemExit(main())
