import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  SpeechProviderId,
  SpeechRecognitionAdapter,
  SpeechRecognitionRequest,
  SpeechRecognitionResult,
} from "@ai-office-suite/shared-contracts";
import { SpeechProviderError } from "./errors.ts";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export function resolveLocalSpeechPython(): string | null {
  const configured = process.env.FASTER_WHISPER_PYTHON?.trim();
  if (configured && existsSync(configured)) return configured;

  const venvCandidates =
    process.platform === "win32"
      ? [
          path.join(repoRoot, ".venv-speech", "Scripts", "python.exe"),
          path.join(repoRoot, ".venv-speech", "bin", "python3"),
          path.join(repoRoot, ".venv-speech", "bin", "python"),
        ]
      : [
          path.join(repoRoot, ".venv-speech", "bin", "python3"),
          path.join(repoRoot, ".venv-speech", "bin", "python"),
          path.join(repoRoot, ".venv-speech", "Scripts", "python.exe"),
        ];
  for (const candidate of venvCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const winLocalPy = path.join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Python",
      "Python312",
      "python.exe",
    );
    if (existsSync(winLocalPy)) return winLocalPy;
  }

  return null;
}

export class FasterWhisperLocalAdapter implements SpeechRecognitionAdapter {
  readonly providerId: SpeechProviderId = "faster-whisper";
  readonly isMock = false;

  async transcribe(request: SpeechRecognitionRequest): Promise<SpeechRecognitionResult> {
    if (process.env.ALLOW_LOCAL_FASTER_WHISPER !== "true" && process.env.ALLOW_LIVE_SPEECH_PROVIDERS !== "true") {
      throw new SpeechProviderError(
        423,
        "LIVE_SPEECH_PROVIDER_NOT_AUTHORIZED",
        "Local Faster-Whisper requires ALLOW_LOCAL_FASTER_WHISPER=true (local Python .venv-speech runtime).",
      );
    }

    if (!request.audioBase64) {
      throw new SpeechProviderError(
        400,
        "MISSING_AUDIO_PAYLOAD",
        "Faster-Whisper requires base64-encoded WAV/PCM audio input.",
      );
    }

    const pythonPath = resolveLocalSpeechPython();
    if (!pythonPath) {
      throw new SpeechProviderError(
        503,
        "FASTER_WHISPER_RUNTIME_UNAVAILABLE",
        "Local Python (.venv-speech) runtime for Faster-Whisper was not found on this workstation.",
      );
    }

    const workerScript = path.join(repoRoot, "scripts", "faster_whisper_worker.py");
    if (!existsSync(workerScript)) {
      throw new SpeechProviderError(500, "MISSING_SPEECH_WORKER", "scripts/faster_whisper_worker.py not found.");
    }

    const scratchDir = path.join(tmpdir(), `aios-speech-${randomUUID()}`);
    mkdirSync(scratchDir, { recursive: true });
    const wavPath = path.join(scratchDir, "input.wav");
    writeFileSync(wavPath, Buffer.from(request.audioBase64, "base64"));

    try {
      const modelSize = process.env.FASTER_WHISPER_MODEL?.trim() || "tiny";
      const langCode = request.language === "km-KH" ? "km" : "en";
      const safeEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: scratchDir,
        TMPDIR: scratchDir,
        LANG: process.env.LANG ?? "C.UTF-8",
        ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
        ...(process.env.XDG_CACHE_HOME ? { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME } : {}),
      };
      const { stdout } = await execFileAsync(
        pythonPath,
        [workerScript, "--audio", wavPath, "--language", langCode, "--model", modelSize],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: safeEnv },
      );

      const parsed = JSON.parse(stdout.trim()) as {
        transcript: string;
        language: string;
        duration_ms: number;
        confidence: number;
        model: string;
      };

      return {
        transcript: parsed.transcript.trim(),
        language: request.language,
        confidence: parsed.confidence,
        provider: "faster-whisper",
        isMock: false,
        durationMs: parsed.duration_ms,
        warnings: [
          `Local Faster-Whisper (${parsed.model}) CPU execution — zero audio sent to external cloud APIs.`,
        ],
      };
    } catch {
      throw new SpeechProviderError(
        503,
        "FASTER_WHISPER_EXECUTION_FAILED",
        "Local Faster-Whisper transcription failed. Check server speech worker logs for details.",
      );
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}
