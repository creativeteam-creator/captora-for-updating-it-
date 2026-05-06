import argparse
import sys
import time

import torch
import librosa
import soundfile as sf
from huggingface_hub import hf_hub_download
from transformers import pipeline


MODEL_ID = "shunyalabs/zero-stt-hinglish"
DEFAULT_SAMPLE = "Vaani_random_sample_10.wav"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--audio",
        default=None,
        help="Local audio path. If omitted, downloads a small sample from the model repo.",
    )
    parser.add_argument("--sample", default=DEFAULT_SAMPLE)
    parser.add_argument("--model", default=MODEL_ID)
    args = parser.parse_args()

    if args.audio:
        audio_path = args.audio
    else:
        audio_path = hf_hub_download(repo_id=args.model, filename=args.sample)

    device = 0 if torch.cuda.is_available() else -1
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    print(f"model={args.model}")
    print(f"audio={audio_path}")
    print(f"device={'cuda' if device == 0 else 'cpu'} dtype={dtype}")

    t0 = time.time()
    transcriber = pipeline(
        "automatic-speech-recognition",
        model=args.model,
        device=device,
        torch_dtype=dtype,
    )
    print(f"loaded_in_sec={time.time() - t0:.1f}")

    t1 = time.time()
    audio, sample_rate = sf.read(audio_path)
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    if sample_rate != 16000:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
        sample_rate = 16000
    result = transcriber({"array": audio, "sampling_rate": sample_rate})
    print(f"transcribed_in_sec={time.time() - t1:.1f}")
    print("text:")
    print(result.get("text", result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
