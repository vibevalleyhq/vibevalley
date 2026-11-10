import type { Attachment } from "../attachment/shapes";
import type { MediaAudioJob } from "./audio-shapes";

export const mediaInputContentPath = (id: string) => `/api/v1/media/input/${encodeURIComponent(id)}/content`;

export interface MediaInputRequest {
  kind: "image" | "video" | "audio";
  name: string;
  mime: string;
  size: number;
}

export const MediaInputPhaseValues = ["reserved", "uploading", "ready", "failed", "deleting"] as const;
export type MediaInputPhase = (typeof MediaInputPhaseValues)[number];

export interface MediaInput extends MediaInputRequest {
  id: string;
  phase: MediaInputPhase;
  hash: string | null;
  createdAt: number;
  expiresAt: number;
  canDelete: boolean;
}

export interface MediaImageRequest {
  id: string;
  prompt: string;
  format: "text" | "layout";
  width: number;
  height: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  negativePrompt?: string;
  enhance: boolean;
  watermark: boolean;
}

export const MediaPhaseValues = ["queued", "generating", "downloading", "ready", "failed", "unknown", "canceled", "download_failed"] as const;
export type MediaPhase = (typeof MediaPhaseValues)[number];

export type MediaSource = { kind: "user" } | { kind: "orchestrator"; agent: string; channel: string };

export interface MediaImageUsage {
  images: number;
  width: number;
  height: number;
}

export interface MediaImageJob {
  kind: "image";
  id: string;
  prompt: string;
  model: string;
  connection: string;
  revision: number;
  source: MediaSource;
  usage?: MediaImageUsage;
  phase: MediaPhase;
  phaseText: string;
  problem: string;
  attachment?: Attachment;
  canCancel: boolean;
  canRetryDownload: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MediaUnderstandingRequest {
  id: string;
  prompt: string;
  inputs: string[];
  connection: string;
  revision: number;
  allowUpload: true;
  maxOutputTokens: number;
}

export interface MediaUnderstandingAuthorizationRequest extends MediaUnderstandingRequest {
  channel: string;
}

export interface MediaUnderstandingAuthorization {
  channel: string;
  expiresAt: number;
}

export interface MediaInputReference extends MediaInputRequest {
  id: string;
  hash: string;
}

export const MediaUnderstandingPhaseValues = [
  "authorized",
  "queued",
  "uploading",
  "generating",
  "ready",
  "incomplete",
  "failed",
  "unknown",
  "canceled",
] as const;
export type MediaUnderstandingPhase = (typeof MediaUnderstandingPhaseValues)[number];
export const MediaCleanupValues = ["pending", "running", "done", "blocked", "unknown"] as const;
export type MediaCleanup = (typeof MediaCleanupValues)[number];

export interface MediaUnderstandingResult {
  model: string;
  text: string;
  status: "completed" | "incomplete";
  incompleteReason: "max_output_tokens" | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface MediaUnderstandingJob {
  kind: "understanding";
  id: string;
  prompt: string;
  inputs: MediaInputReference[];
  model: string;
  connection: string;
  revision: number;
  source: MediaSource;
  authorization: MediaUnderstandingAuthorization | null;
  phase: MediaUnderstandingPhase;
  phaseText: string;
  problem: string;
  result: MediaUnderstandingResult | null;
  cleanup: MediaCleanup;
  cleanupText: string;
  canCancel: boolean;
  canCleanup: boolean;
  canRetryDownload: false;
  createdAt: number;
  updatedAt: number;
}

export const MediaAudioFormatValues = ["wav", "mp3", "flac", "aac", "opus", "pcm"] as const;
export type MediaAudioFormat = (typeof MediaAudioFormatValues)[number];

export interface MediaAudioMetadata {
  source: "file" | "provider";
  sampleRate?: number;
  duration?: number;
  channels?: number;
  bitDepth?: number;
}

export interface MediaAudioUsage {
  inputCharacters?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputAudioSeconds?: number;
}
export type MediaSpeechEvent =
  | { type: "format"; sampleRate: number; channels: number; bitDepth: 16 }
  | { type: "audio"; sequence: number; audio: string }
  | { type: "done" }
  | { type: "failed" };
export const mediaSpeechStreamPath = (id: string) => `/api/v1/media/speech/${encodeURIComponent(id)}/stream`;

export interface MediaSpeechRequest {
  id: string;
  text: string;
  voice: string;
  format: MediaAudioFormat;
  asynchronous?: boolean;
  streaming?: boolean;
  connection: string;
  revision: number;
}

export interface MediaSpeechJob {
  kind: "speech";
  id: string;
  prompt: string;
  model: string;
  connection: string;
  revision: number;
  source: MediaSource;
  voice: string;
  format: MediaAudioFormat;
  contentType?: string;
  metadata?: MediaAudioMetadata;
  usage?: MediaAudioUsage;
  canResume?: boolean;
  phase: MediaPhase;
  phaseText: string;
  problem: string;
  attachment?: Attachment;
  resultInput: MediaInputReference | null;
  canCancel: boolean;
  canRelease: boolean;
  canRetryDownload: boolean;
  createdAt: number;
  updatedAt: number;
}

export type MediaJob = MediaImageJob | MediaUnderstandingJob | MediaSpeechJob | MediaAudioJob;

export interface MediaJobRequest {
  id: string;
}
export interface FactMediaChanged {
  type: "mediaChanged";
  at: number;
  jobs: MediaJob[];
}
