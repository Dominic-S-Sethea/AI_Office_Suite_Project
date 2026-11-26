import type {
  SpeechLanguageCode,
  SpeechProviderId,
  SpeechRecognitionAdapter,
  SpeechRecognitionRequest,
  SpeechRecognitionResult,
} from "@ai-office-suite/shared-contracts";
import { FasterWhisperLocalAdapter } from "./fasterWhisper.ts";
import { SpeechProviderError } from "./errors.ts";

export * from "./errors.ts";
export * from "./benchmark.ts";
export * from "./fasterWhisper.ts";
export * from "./criticalFields.ts";
export * from "./terminology.ts";
export * from "./voiceSession.ts";
export * from "./voiceGovernance.ts";

export interface SyntheticVoiceFixture {
  fixtureId: string;
  language: SpeechLanguageCode;
  mode: "dictation" | "command" | "contextual" | "workflow";
  transcript: string;
  description: string;
}

export const SYNTHETIC_VOICE_FIXTURES: readonly SyntheticVoiceFixture[] = [
  {
    fixtureId: "en-bold-selection",
    language: "en-US",
    mode: "contextual",
    transcript: "make bold",
    description: "Short English formatting instruction on selected paragraph",
  },
  {
    fixtureId: "en-heading-1",
    language: "en-US",
    mode: "command",
    transcript: "make heading 1",
    description: "English heading style command",
  },
  {
    fixtureId: "en-insert-table",
    language: "en-US",
    mode: "command",
    transcript: "insert 3x3 table",
    description: "English structured table insertion command",
  },
  {
    fixtureId: "en-translate-khmer",
    language: "en-US",
    mode: "contextual",
    transcript: "translate selection to khmer",
    description: "English voice command targeting Khmer output",
  },
  {
    fixtureId: "km-bold-selection",
    language: "km-KH",
    mode: "contextual",
    transcript: "ធ្វើឱ្យដិត",
    description: "Khmer formatting instruction ('make bold')",
  },
  {
    fixtureId: "km-align-center",
    language: "km-KH",
    mode: "contextual",
    transcript: "តម្រឹមកណ្តាល",
    description: "Khmer paragraph alignment instruction ('align center')",
  },
  {
    fixtureId: "km-insert-table",
    language: "km-KH",
    mode: "command",
    transcript: "បញ្ចូលតារាង ៣x៣",
    description: "Khmer command with Khmer numerals ('insert 3x3 table')",
  },
  {
    fixtureId: "km-translate-to-khmer",
    language: "km-KH",
    mode: "contextual",
    transcript: "បកប្រែកថាខណ្ឌនេះជាភាសាខ្មែរ",
    description: "Khmer command ('translate this paragraph into Khmer')",
  },
];

export class MockSpeechAdapter implements SpeechRecognitionAdapter {
  readonly providerId: SpeechProviderId = "mock";
  readonly isMock = true;

  async transcribe(request: SpeechRecognitionRequest): Promise<SpeechRecognitionResult> {
    const warnings: string[] = [
      "MOCK SPEECH ADAPTER: Live acoustic ASR is disabled in Phase D1 until founder authorization.",
    ];

    let transcript = request.simulatedTranscript?.trim() ?? "";
    if (!transcript && request.fixtureId) {
      const fixture = SYNTHETIC_VOICE_FIXTURES.find((f) => f.fixtureId === request.fixtureId);
      if (!fixture) {
        throw new SpeechProviderError(404, "FIXTURE_NOT_FOUND", `Unknown voice fixture '${request.fixtureId}'.`);
      }
      transcript = fixture.transcript;
    }

    if (!transcript) {
      const defaultFixture = SYNTHETIC_VOICE_FIXTURES.find((f) => f.language === request.language);
      transcript =
        defaultFixture?.transcript ??
        (request.language === "km-KH" ? "ធ្វើឱ្យដិត" : "make bold");
      warnings.push("No live audio stream supplied; returned default synthetic fixture transcript.");
    }

    return {
      transcript,
      language: request.language,
      confidence: 0.99,
      provider: "mock",
      isMock: true,
      disclaimer: "Mock transcript for Phase D1 pipeline verification — not evidence of live acoustic WER.",
      durationMs: request.durationMs ?? 1200,
      warnings,
    };
  }
}

class FailClosedLiveSpeechAdapter implements SpeechRecognitionAdapter {
  readonly providerId: SpeechProviderId;
  readonly isMock = false;
  private readonly envHint: string;

  constructor(providerId: SpeechProviderId, envHint: string) {
    this.providerId = providerId;
    this.envHint = envHint;
  }

  async transcribe(_request: SpeechRecognitionRequest): Promise<SpeechRecognitionResult> {
    if (process.env.ALLOW_LIVE_SPEECH_PROVIDERS !== "true") {
      throw new SpeechProviderError(
        423,
        "LIVE_SPEECH_PROVIDER_NOT_AUTHORIZED",
        `Live speech provider '${this.providerId}' is locked in Phase D1 (requires ALLOW_LIVE_SPEECH_PROVIDERS=true and ${this.envHint}).`,
      );
    }
    throw new SpeechProviderError(
      501,
      "LIVE_SPEECH_NOT_WIRED",
      `Provider '${this.providerId}' transport is deferred to Phase D5 after D1.02 benchmark approval.`,
    );
  }
}

export function getSpeechAdapter(providerId: SpeechProviderId = "mock"): SpeechRecognitionAdapter {
  switch (providerId) {
    case "mock":
      return new MockSpeechAdapter();
    case "google-cloud-stt-v2":
      return new FailClosedLiveSpeechAdapter("google-cloud-stt-v2", "GOOGLE_APPLICATION_CREDENTIALS");
    case "azure-speech":
      return new FailClosedLiveSpeechAdapter("azure-speech", "AZURE_SPEECH_KEY + AZURE_SPEECH_REGION");
    case "faster-whisper":
      return new FasterWhisperLocalAdapter();
  }
}
