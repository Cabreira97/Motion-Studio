import type { Transcript, TranscriptSegment } from "./types.js";
import type { TranscribeRequest, Transcriber } from "./ports.js";

/**
 * Fallback transcriber used when no local speech recognizer is configured.
 * It deliberately reports availability instead of throwing so the UI can show
 * a clear "transcript unavailable" state while still exporting everything else.
 */
export class UnavailableTranscriber implements Transcriber {
  constructor(readonly reason = "no speech recognizer configured") {}

  async available(): Promise<boolean> {
    return false;
  }

  async transcribe(request: TranscribeRequest): Promise<Transcript> {
    if (!request.hasAudio) {
      return { available: false, reason: "recording has no audio track", segments: [], text: "" };
    }
    return { available: false, reason: this.reason, segments: [], text: "" };
  }
}

/** In-memory transcriber for tests and demos. */
export class StaticTranscriber implements Transcriber {
  constructor(
    private readonly segments: TranscriptSegment[],
    private readonly language = "en",
  ) {}

  async available(): Promise<boolean> {
    return true;
  }

  async transcribe(_request?: TranscribeRequest): Promise<Transcript> {
    return {
      available: true,
      language: this.language,
      segments: this.segments,
      text: this.segments.map((s) => s.text.trim()).join(" ").trim(),
    };
  }
}

export function transcriptToPlainText(transcript: Transcript): string {
  if (!transcript.available) return "";
  return transcript.segments
    .map((s) => `[${formatStamp(s.startMs)}] ${s.text.trim()}`)
    .join("\n");
}

function formatStamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function emptyTranscript(reason: string): Transcript {
  return { available: false, reason, segments: [], text: "" };
}
