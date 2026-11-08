import type { Attachment } from "../channel/shapes";

export const mediaInputContentPath = (id: string) => `/api/v1/media/input/${encodeURIComponent(id)}/content`;

export interface MediaInputRequest {
  kind: "image" | "video";
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

export type MediaSource = { kind: "owner" } | { kind: "orchestrator"; agent: string; channel: string };

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

export interface MediaInputReference extends MediaInputRequest {
  id: string;
  hash: string;
}

export const MediaUnderstandingPhaseValues = ["queued", "uploading", "generating", "ready", "incomplete", "failed", "unknown", "canceled"] as const;
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

export type MediaJob = MediaImageJob | MediaUnderstandingJob;

export interface MediaJobRequest {
  id: string;
}
export interface FactMediaChanged {
  type: "mediaChanged";
  at: number;
  jobs: MediaJob[];
}
