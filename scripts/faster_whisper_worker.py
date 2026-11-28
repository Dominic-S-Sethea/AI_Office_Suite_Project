import argparse
import json
import sys
import time
import wave


MAX_SAMPLE_RATE = 96000
MIN_SAMPLE_RATE = 8000
MAX_CHANNELS = 2
MAX_DURATION_SECONDS = 300.0
MAX_PCM_BYTES = 64 * 1024 * 1024


def load_pcm_wav_16k(path: str):
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()

        if channels < 1 or channels > MAX_CHANNELS:
            raise ValueError(f"Unsupported WAV channel count: {channels} (allowed: 1..{MAX_CHANNELS})")
        if sample_rate < MIN_SAMPLE_RATE or sample_rate > MAX_SAMPLE_RATE:
            raise ValueError(
                f"Unsupported WAV sample rate: {sample_rate} Hz (allowed: {MIN_SAMPLE_RATE}..{MAX_SAMPLE_RATE})"
            )
        if sampwidth not in (1, 2, 4):
            raise ValueError(f"Unsupported WAV sample width: {sampwidth} bytes")
        if n_frames <= 0:
            raise ValueError("WAV file contains zero audio frames")
        duration_sec = float(n_frames) / float(sample_rate)
        if duration_sec > MAX_DURATION_SECONDS:
            raise ValueError(
                f"WAV duration {duration_sec:.1f}s exceeds maximum allowed {MAX_DURATION_SECONDS:.0f}s"
            )
        expected_bytes = n_frames * channels * sampwidth
        if expected_bytes > MAX_PCM_BYTES:
            raise ValueError(f"WAV PCM payload ({expected_bytes} bytes) exceeds maximum limit ({MAX_PCM_BYTES} bytes)")

        raw = wf.readframes(n_frames)

    if len(raw) == 0:
        raise ValueError("WAV file contains empty PCM frame payload")
    if len(raw) % (sampwidth * channels) != 0:
        raise ValueError(
            f"WAV PCM payload length ({len(raw)} bytes) is not aligned to frame size ({sampwidth * channels} bytes)"
        )
    if len(raw) > MAX_PCM_BYTES:
        raise ValueError(f"WAV PCM data exceeds maximum limit ({MAX_PCM_BYTES} bytes)")

    import numpy as np

    if sampwidth == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sampwidth == 1:
        audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported WAV sample width: {sampwidth} bytes")

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if sample_rate != 16000 and len(audio) > 0:
        target_len = int(round(len(audio) * 16000.0 / float(sample_rate)))
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=target_len, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)

    return audio


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Faster-Whisper speech worker for AI Office Suite")
    parser.add_argument("--audio", required=True, help="Path to local PCM WAV file")
    parser.add_argument("--language", default="en", help="ISO language code (en or km)")
    parser.add_argument(
        "--model",
        default="tiny",
        choices=["tiny", "base", "small", "medium"],
        help="Whisper model size (tiny, base, small, medium)",
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        sys.stderr.write(f"faster_whisper_import_error: {exc}\n")
        return 2

    t0 = time.perf_counter()
    audio_16k = load_pcm_wav_16k(args.audio)
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_16k, language=args.language, beam_size=1)
    text_parts = []
    avg_prob_sum = 0.0
    count = 0
    for seg in segments:
        text_parts.append(seg.text.strip())
        avg_prob_sum += float(getattr(seg, "avg_logprob", -0.5))
        count += 1
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)
    confidence = round(min(0.99, max(0.05, 1.0 + (avg_prob_sum / count if count else -0.5))), 3)

    payload = {
        "transcript": " ".join(p for p in text_parts if p),
        "language": getattr(info, "language", args.language),
        "duration_ms": elapsed_ms,
        "confidence": confidence,
        "model": args.model,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
