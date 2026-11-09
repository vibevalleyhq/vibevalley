import { describe, expect, it } from "vite-plus/test";

import { audioTimestamp, dialogueComplete, supportsStreamingTranscription, transcriptContent } from "./audio.ts";

describe("audio presentation", () => {
  it("allows streaming only for supported diarization models", () => {
    expect(supportsStreamingTranscription("moss-transcribe-diarize-pro")).toBe(true);
    expect(supportsStreamingTranscription("moss-transcribe-diarize-pro-2026-07-03")).toBe(true);
    for (const model of [undefined, "moss-transcribe-1.0", "moss-transcribe-1.0-2026-07-22", "moss-transcribe-diarize-pro-unknown"]) {
      expect(supportsStreamingTranscription(model)).toBe(false);
    }
  });

  it("requires unique named voices and mapped nonempty dialogue turns", () => {
    const speakers = [
      { id: "host", voice: "voice-a" },
      { id: "guest", voice: "voice-b" },
    ];
    expect(dialogueComplete(speakers, [{ speaker: "guest", text: "Hello" }])).toBe(true);
    expect(dialogueComplete([...speakers, { id: "host", voice: "voice-c" }], [{ speaker: "host", text: "Hello" }])).toBe(false);
    expect(dialogueComplete(speakers, [{ speaker: "missing", text: "Hello" }])).toBe(false);
    expect(dialogueComplete(speakers, [{ speaker: "host", text: " " }])).toBe(false);
    expect(dialogueComplete([{ id: "host", voice: "" }], [{ speaker: "host", text: "Hello" }])).toBe(false);
    expect(dialogueComplete([], [])).toBe(false);
  });

  it("retains subsecond times, hour boundaries and speaker labels in saved transcripts", () => {
    expect(audioTimestamp(3661.125)).toBe("01:01:01.125");
    expect(audioTimestamp(59.9999)).toBe("00:01:00.000");
    expect(audioTimestamp(0)).toBe("00:00:00.000");
    expect(transcriptContent("Hello", [{ speaker: "speaker_0", text: "Hello", start: 1.25, end: 2.5 }])).toBe(
      "Hello\n\n[00:00:01.250 – 00:00:02.500] speaker_0\nHello",
    );
    expect(transcriptContent("No timestamps", [])).toBe("No timestamps");
  });
});
