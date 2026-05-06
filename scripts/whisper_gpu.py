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
            condition_on_previous_text=True,
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            repetition_penalty=1.1,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            initial_prompt=args.initial_prompt,
        )

        words = []
        text_parts = []
        for segment in segments_iter:
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

