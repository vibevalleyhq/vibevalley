import type { MediaAudioSegment, MediaSpeakersRequest } from "@vibevalley/protocol";

export function supportsStreamingTranscription(model: string | undefined) {
  return model === "moss-transcribe-diarize-pro" || model === "moss-transcribe-diarize-pro-2026-07-03";
}

export function dialogueComplete(speakers: MediaSpeakersRequest["speakers"], segments: MediaSpeakersRequest["segments"]) {
  const names = new Set(speakers.map((speaker) => speaker.id.trim()));
  return (
    speakers.length > 0 &&
    names.size === speakers.length &&
    speakers.every((speaker) => speaker.id.trim() !== "" && speaker.voice !== "") &&
    segments.length > 0 &&
    segments.every((segment) => names.has(segment.speaker) && segment.text.trim() !== "")
  );
}

export function audioTimestamp(seconds: number) {
  const milliseconds = Math.round(Math.max(0, seconds) * 1000);
  const whole = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

export function transcriptContent(text: string, segments: readonly MediaAudioSegment[]) {
  return segments.length === 0
    ? text
    : `${text}\n\n${segments.map((segment) => `[${audioTimestamp(segment.start)} – ${audioTimestamp(segment.end)}] ${segment.speaker}\n${segment.text}`).join("\n\n")}`;
}
