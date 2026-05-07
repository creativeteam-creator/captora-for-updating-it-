"""
GPU Whisper transcription via faster-whisper (CTranslate2 backend).

Spawned by `web/src/lib/faster-whisper.ts`. Reads an audio file path,
runs Whisper-large-v3 on the user's NVIDIA GPU, and writes a JSON result
to stdout that matches Captora's WhisperResult shape.

Why faster-whisper:
  - 5-10× realtime on RTX-class GPUs vs ~0.3× realtime on CPU
  - Word-level timestamps via `word_timestamps=True`
  - VAD filter built in (skips silence, improves accuracy)
  - Prebuilt CUDA wheels — no CUDA toolkit install required, just GPU drivers

Install on the host machine (one-time):
    pip install faster-whisper

Then in `web/.env.local` set:
    FASTER_WHISPER_ENABLED=1
    FASTER_WHISPER_PYTHON=python    # or full path if not on PATH
    FASTER_WHISPER_MODEL=large-v3   # or medium/small for less VRAM

Args (positional + flags):
    audio_path           path to a media file readable by ffmpeg
    --language hi|en|... ISO 639-1 source language hint, omit for auto-detect
    --task transcribe|translate  (translate forces English output)
    --model large-v3|medium|small|base|tiny
    --device cuda|cpu
    --compute-type float16|int8_float16|int8

Exit codes:
    0  — JSON written to stdout
    2  — faster-whisper not installed
    3  — model load failed (driver / VRAM / model name)
    4  — transcription failed (audio decode, etc.)
"""

import os
import sys
import json
import argparse


def _add_nvidia_dll_paths() -> None:
    """
    On Windows, faster-whisper / CTranslate2 loads CUDA libraries via
    LoadLibrary. The pip packages (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`,
    `nvidia-cuda-nvrtc-cu12`) install their DLLs under
    `<site-packages>/nvidia/<lib>/bin/`. Python 3.8+ requires those
    directories to be registered via `os.add_dll_directory`; otherwise
    you get the classic `cublas64_12.dll is not found` error even though
    the file is on disk.

    The nvidia-*-cu12 wheels are PEP-420 namespace packages — many of
    them have NO `__init__.py`, so `spec.origin` is `None` and the
    naive lookup misses them. We use `spec.submodule_search_locations`
    as a fallback (set on both regular and namespace package specs).

    Logs what it found / didn't find to stderr so a misconfigured
    install ("pip install nvidia-cublas-cu12" never run, or run in a
    different interpreter) shows up in the parent Node process logs.

    No-op on non-Windows platforms (Linux uses LD_LIBRARY_PATH-style
    discovery automatically when the wheels are installed).
    """
    if not sys.platform.startswith("win"):
        return
    try:
        import importlib.util
        import ctypes
        added: list[str] = []
        missing: list[str] = []
        for pkg in (
            "nvidia.cublas",
            "nvidia.cudnn",
            "nvidia.cuda_runtime",
            "nvidia.cuda_nvrtc",
            "nvidia.cufft",
            "nvidia.curand",
        ):
            spec = importlib.util.find_spec(pkg)
            if spec is None:
                missing.append(pkg)
                continue
            # Resolve the package directory two ways:
            #   1. spec.origin → __init__.py path (regular packages)
            #   2. spec.submodule_search_locations → set on every package
            #      spec including namespace packages (no __init__.py).
            candidate_dirs: list[str] = []
            if spec.origin:
                candidate_dirs.append(os.path.dirname(spec.origin))
            if spec.submodule_search_locations:
                candidate_dirs.extend(list(spec.submodule_search_locations))
            found_bin = False
            for pkg_dir in candidate_dirs:
                bin_dir = os.path.join(pkg_dir, "bin")
                if os.path.isdir(bin_dir):
                    os.add_dll_directory(bin_dir)
                    added.append(bin_dir)
                    found_bin = True
                    break
            if not found_bin:
                missing.append(f"{pkg} (located but no bin/ dir)")
        if added:
            print(f"[whisper_gpu] DLL paths: {added}", file=sys.stderr)
        if missing:
            print(
                f"[whisper_gpu] missing nvidia packages: {missing}. "
                f"In this Python ({sys.executable}) run: "
                f"pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12",
                file=sys.stderr,
            )

        # Pin the right DLLs into the process before CTranslate2 loads.
        # os.add_dll_directory only affects DLL *search paths* — if a
        # conflicting cublas64_12.dll exists earlier in PATH (older system
        # CUDA install, etc.), CTranslate2's LoadLibrary may still pick
        # the wrong one. Pre-loading via ctypes.CDLL forces the correct
        # version to occupy the cublas64_12.dll slot in the process
        # address space; later LoadLibrary calls return our handle.
        # Order matters: load foundation libs first, then dependants.
        preloaded: list[str] = []
        for bin_dir in added:
            try:
                for fname in sorted(os.listdir(bin_dir)):
                    if not fname.lower().endswith(".dll"):
                        continue
                    full = os.path.join(bin_dir, fname)
                    try:
                        ctypes.CDLL(full)
                        preloaded.append(fname)
                    except OSError:
                        # Some bin/ dirs ship optional/diagnostic DLLs that
                        # have unmet deps in headless setups; skip silently.
                        pass
            except OSError:
                pass
        if preloaded:
            print(f"[whisper_gpu] preloaded {len(preloaded)} DLLs: {preloaded[:6]}{'...' if len(preloaded) > 6 else ''}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — soft-fail; faster-whisper will surface a clearer error
        print(f"warning: could not register nvidia DLL paths: {e}", file=sys.stderr)


# IMPORTANT: must run BEFORE the faster-whisper import below — once
# CTranslate2's native bits load, adding paths is too late.
_add_nvidia_dll_paths()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--language", default=None)
    parser.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", dest="compute_type", default="float16")
    # Vocabulary hint passed to model.transcribe(initial_prompt=...). This
    # is the single biggest lever for proper-noun accuracy: feeding
    # Whisper a short string of expected vocab ("QHT clinic, Haridwar,
    # hair transplant, …") biases the decoder toward those exact tokens
    # so it stops mishearing brand names as random homophones.
    parser.add_argument("--initial-prompt", dest="initial_prompt", default=None)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper is not installed. Run: pip install faster-whisper",
            file=sys.stderr,
        )
        return 2

    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    except Exception as e:
        err_msg = str(e)
        # CuBLAS / CUDA DLL not found — fall back to CPU automatically.
        # This happens when nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels are
        # missing or the CUDA toolkit version doesn't match.
        if args.device == "cuda" and ("cublas" in err_msg.lower() or "cudnn" in err_msg.lower() or "cuda" in err_msg.lower()):
            print(
                f"[whisper_gpu] CUDA load failed ({err_msg[:120]}). "
                "Retrying on CPU (int8) — install nvidia-cublas-cu12 nvidia-cudnn-cu12 for GPU speed.",
                file=sys.stderr,
            )
            try:
                model = WhisperModel(args.model, device="cpu", compute_type="int8")
            except Exception as e2:
                print(f"Model load failed on CPU too: {e2}", file=sys.stderr)
                return 3
        else:
            print(f"Model load failed: {e}", file=sys.stderr)
            return 3


    try:
        # `transcribe` returns (segments_iterator, info). Iterating segments
        # actually runs inference; info has language + duration up-front.
        #
        # Key accuracy settings:
        #   beam_size=10       — wider search beam; catches correct token
        #                        sequences that beam_size=5 misses (especially
        #                        code-switched Hinglish where the right path is
        #                        non-obvious to the decoder). Adds ~10% latency.
        #   temperature=0      — fully greedy within the beam; removes random
        #                        token sampling that causes hallucinated words.
        #   best_of=5          — sample 5 candidates at temperature=0; effectively
        #                        acts as an extra accuracy pass.
        #   condition_on_previous_text=True — feed previous segment as prefix so
        #                        Whisper keeps consistent names/vocabulary across
        #                        the whole audio (avoids mid-video word drift).
        #   no_speech_threshold=0.6  — default 0.6 is fine; raise to 0.8 only if
        #                        silence segments keep hallucinating text.
        #   compression_ratio_threshold=2.4  — flags runaway repetition loops
        #                        ("lagara lagara lagara…") and falls back to a
        #                        lower-temperature decode instead of keeping junk.
        segments_iter, info = model.transcribe(
            args.audio_path,
            language=args.language,
            task=args.task,
            word_timestamps=True,
            beam_size=10,
            temperature=0.0,
            # condition_on_previous_text=False — prevents Whisper from
            # carrying decoder state across chunks, which on long videos
            # tends to drift mid-way (the model latches onto a stale
            # context and starts dropping or paraphrasing words). For
            # 30-min+ recordings the consistency win is not worth the
            # word loss.
            condition_on_previous_text=False,
            # All decoder filters dialled to maximum permissiveness — when
            # Whisper drops mid-audio words, the timeline shows captions
            # stuck on the surrounding word for several seconds. Letting
            # more low-confidence chunks through is preferable; minor
            # hallucinations in genuine silence are rare on real speech
            # audio.
            no_speech_threshold=0.2,    # was 0.3 — even more chunks decoded
            compression_ratio_threshold=3.0,   # was 2.4 — keep "noisy" chunks
            log_prob_threshold=-2.0,    # was -1.0 — accept lower-confidence words
            repetition_penalty=1.0,
            # VAD off entirely — even lenient VAD parameters were dropping
            # words in stretches where the speaker pauses to breathe or
            # speaks softly. Whisper's own internal silence handling is
            # good enough on its own; relying on it processes the full
            # audio with no pre-filter cuts.
            vad_filter=False,
            initial_prompt=args.initial_prompt,
        )

        words = []
        text_parts = []
        fragmented_segments = 0
        for segment in segments_iter:
            seg_text = segment.text.strip()
            text_parts.append(seg_text)

            # Whisper's word_timestamps for Hindi / mixed Hindi+English audio
            # often produces akshara-level (single character) splits instead
            # of real word boundaries. Detect this by computing the average
            # token length: if it's less than 2 chars, the timestamps are
            # fragmented and would render as single-letter caption chips
            # ("una", "a", "ji", "C", "1"...). Fall back to whitespace-split
            # of the segment text with character-weighted timestamp
            # distribution — same approach as the JS local Whisper path.
            seg_words = segment.words or []
            avg_len = (
                sum(len((w.word or "").strip()) for w in seg_words) / len(seg_words)
                if seg_words else 0.0
            )
            use_word_timestamps = seg_words and avg_len >= 2.0

            # NOTE: previously a 1.2s per-word cap was applied here to
            # prevent stuck captions when Whisper merged several spoken
            # words into one token. The side effect was that any word
            # whose Whisper-reported end exceeded start+1.2 left a
            # caption-less GAP between its (capped) end and the next
            # word's start — visible on the timeline as audio playing
            # with no caption. The cap is removed; words now use their
            # full reported duration. Stuck-caption cases (rare) are
            # accepted as the lesser evil vs constant gaps.

            if use_word_timestamps:
                for w in seg_words:
                    token = (w.word or "").strip()
                    if not token:
                        continue
                    start = float(w.start)
                    end = float(w.end)
                    words.append({"word": token, "start": start, "end": end})
            else:
                fragmented_segments += 1
                # Distribute segment time across whitespace-split tokens,
                # weighted by character count so longer words get more time.
                seg_start = float(segment.start)
                seg_end = float(segment.end)
                seg_dur = max(0.05, seg_end - seg_start)
                tokens = seg_text.split()
                if not tokens:
                    continue
                char_weights = [max(1, len(t)) + 1 for t in tokens]
                total_weight = sum(char_weights)
                cursor = seg_start
                for i, token in enumerate(tokens):
                    w_dur = (char_weights[i] / total_weight) * seg_dur
                    start = cursor
                    # Last token snaps to seg_end so accumulated rounding
                    # doesn't leave a gap before the next segment.
                    end = seg_end if i == len(tokens) - 1 else start + w_dur
                    cursor = end
                    words.append({
                        "word": token,
                        "start": float(start),
                        "end": float(end),
                    })

        # Bridge gaps between consecutive words. Whisper's per-word `end`
        # timestamps sometimes fall short of the actual word duration —
        # leaving a small caption-less window before the next word starts.
        # If the gap to the next word is < 2 seconds, extend this word's
        # end to meet it. (Larger gaps preserve genuine speech pauses.)
        for i in range(len(words) - 1):
            gap = words[i + 1]["start"] - words[i]["end"]
            if 0 < gap < 2.0:
                words[i]["end"] = words[i + 1]["start"]

        if fragmented_segments > 0:
            print(
                f"[whisper_gpu] note: re-split {fragmented_segments} segment(s) "
                f"with fragmented word_timestamps (akshara-level output) "
                f"using segment-text whitespace split.",
                file=sys.stderr,
            )

    except (RuntimeError, Exception) as e:
        err_msg = str(e)
        is_cuda_err = any(k in err_msg.lower() for k in ("cublas", "cudnn", "cuda", "library"))
        if args.device == "cuda" and is_cuda_err:
            print(
                f"[whisper_gpu] CUDA error: {err_msg[:120]}. Retrying on CPU (int8).",
                file=sys.stderr,
            )
            try:
                model = WhisperModel(args.model, device="cpu", compute_type="int8")
                seg_iter2, info = model.transcribe(
                    args.audio_path,
                    language=args.language,
                    task=args.task,
                    word_timestamps=True,
                    beam_size=5,
                    temperature=0.0,
                    condition_on_previous_text=True,
                    repetition_penalty=1.1,
                    vad_filter=True,
                    initial_prompt=args.initial_prompt,
                )
                words = []
                text_parts = []
                for segment in seg_iter2:
                    text_parts.append(segment.text.strip())
                    if segment.words:
                        for w in segment.words:
                            token = (w.word or "").strip()
                            if not token:
                                continue
                            words.append({
                                "word": token,
                                "start": float(w.start),
                                "end": float(w.end),
                            })
            except Exception as e2:
                print(f"Transcription failed on CPU fallback: {e2}", file=sys.stderr)
                return 4
        else:
            print(f"Transcription failed: {e}", file=sys.stderr)
            return 4

    output = {
        "text": " ".join(text_parts).strip(),
        "language": info.language,
        "duration": float(info.duration),
        "words": words,
    }
    sys.stdout.write(json.dumps(output))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

