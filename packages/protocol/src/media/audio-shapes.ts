import type { Attachment } from "../attachment/shapes";
import type { MediaAudioFormat, MediaAudioMetadata, MediaInputReference, MediaPhase, MediaSource, MediaAudioUsage } from "./shapes";

export const MediaAudioKindValues = ["speakers", "voiceDesign", "clone", "transcription"] as const;

export interface MediaAudioAccountRequest {
  id: string;
  connection: string;
  revision: number;
}
export interface MediaSpeakersRequest extends MediaAudioAccountRequest {
  speakers: { id: string; voice: string }[];
  segments: { speaker: string; text: string }[];
  format: MediaAudioFormat;
}
export interface MediaVoiceDesignRequest extends MediaAudioAccountRequest {
  text: string;
  instruction: string;
  format: MediaAudioFormat;
}
export interface MediaCloneRequest extends MediaAudioAccountRequest {
  input: string;
  name?: string;
  consent: true;
}
export interface MediaTranscriptionRequest extends MediaAudioAccountRequest {
  input: string;
  allowUpload: true;
  diarize?: boolean;
  keyterms?: string[];
  streaming?: boolean;
}
export type MediaAudioRequest =
  | ({ kind: "speakers" } & MediaSpeakersRequest)
  | ({ kind: "voiceDesign" } & MediaVoiceDesignRequest)
  | ({ kind: "clone" } & MediaCloneRequest)
  | ({ kind: "transcription" } & MediaTranscriptionRequest);

export interface MediaAudioVoice {
  id: string;
  name: string;
  createdAtSeconds: number;
}
export interface MediaAudioSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}
export type MediaAudioResult = { kind: "clone"; voice: MediaAudioVoice } | { kind: "transcription"; text: string; segments: MediaAudioSegment[] };

interface MediaAudioJobBase {
  id: string;
  prompt: string;
  model: string;
  connection: string;
  revision: number;
  source: MediaSource;
  phase: MediaPhase;
  phaseText: string;
  problem: string;
  format: MediaAudioFormat | null;
  contentType: string | null;
  metadata?: MediaAudioMetadata;
  usage?: MediaAudioUsage;
  input: MediaInputReference | null;
  resultInput: MediaInputReference | null;
  attachment?: Attachment;
  previewInput: string | null;
  result: MediaAudioResult | null;
  canCancel: boolean;
  canResume: boolean;
  canCleanup: boolean;
  canRelease: boolean;
  canRetryDownload: boolean;
  createdAt: number;
  updatedAt: number;
}
export type MediaAudioJob =
  | (MediaAudioJobBase & { kind: "speakers"; request: MediaSpeakersRequest })
  | (MediaAudioJobBase & { kind: "voiceDesign"; request: MediaVoiceDesignRequest })
  | (MediaAudioJobBase & { kind: "clone"; request: MediaCloneRequest })
  | (MediaAudioJobBase & { kind: "transcription"; request: MediaTranscriptionRequest });
