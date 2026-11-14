// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { Attachment } from "../attachment/shapes.gen";
import type { MessageId, SessionId } from "../common/shapes.gen";

export const MediaAudioFormatValues = ["wav", "mp3", "flac", "aac", "opus", "pcm"] as const;
export type MediaAudioFormat = (typeof MediaAudioFormatValues)[number];

export type MediaAudioAccountRequest = { id: string, connection: string, revision: number, };

export type MediaSpeakersRequestSpeakers = { id: string, voice: string, };

export type MediaSpeakersRequestSegments = { speaker: string, text: string, };

export type MediaSpeakersRequest = { id: string, connection: string, revision: number, speakers: Array<MediaSpeakersRequestSpeakers>, segments: Array<MediaSpeakersRequestSegments>, format: MediaAudioFormat, };

export type MediaVoiceDesignRequest = { id: string, connection: string, revision: number, text: string, instruction: string, format: MediaAudioFormat, };

export type MediaCloneRequest = { id: string, connection: string, revision: number, input: string, name?: string, consent: true, };

export type MediaTranscriptionRequest = { id: string, connection: string, revision: number, input: string, allowUpload: true, diarize?: boolean, keyterms?: Array<string>, streaming?: boolean, };

export type MediaAudioRequest = { "kind": "speakers", id: string, connection: string, revision: number, speakers: Array<MediaSpeakersRequestSpeakers>, segments: Array<MediaSpeakersRequestSegments>, format: MediaAudioFormat, } | { "kind": "voiceDesign", id: string, connection: string, revision: number, text: string, instruction: string, format: MediaAudioFormat, } | { "kind": "clone", id: string, connection: string, revision: number, input: string, name?: string, consent: true, } | { "kind": "transcription", id: string, connection: string, revision: number, input: string, allowUpload: true, diarize?: boolean, keyterms?: Array<string>, streaming?: boolean, };

export type MediaAudioVoice = { id: string, name: string, createdAtSeconds: number, };

export type MediaAudioSegment = { speaker: string, text: string, start: number, end: number, };

export type MediaAudioResult = { "kind": "clone", voice: MediaAudioVoice, } | { "kind": "transcription", text: string, segments: Array<MediaAudioSegment>, };

export type MediaSource = { "kind": "user", } | { "kind": "orchestrator", agent: string, channel: string, };

export const MediaPhaseValues = ["queued", "generating", "downloading", "ready", "failed", "unknown", "canceled", "download_failed"] as const;
export type MediaPhase = (typeof MediaPhaseValues)[number];

export const MediaAudioMetadataSourceValues = ["file", "provider"] as const;
export type MediaAudioMetadataSource = (typeof MediaAudioMetadataSourceValues)[number];

export type MediaAudioMetadata = { source: MediaAudioMetadataSource, sampleRate?: number, duration?: number, channels?: number, bitDepth?: number, };

export type MediaAudioUsage = { inputCharacters?: number, promptTokens?: number, completionTokens?: number, totalTokens?: number, inputAudioSeconds?: number, };

export const MediaInputKindValues = ["image", "video", "audio"] as const;
export type MediaInputKind = (typeof MediaInputKindValues)[number];

export type MediaInputReference = { id: string, kind: MediaInputKind, name: string, mime: string, size: number, hash: string, };

export type MediaAudioJob = { "kind": "speakers", id: string, prompt: string, model: string, connection: string, revision: number, source: MediaSource, phase: MediaPhase, phaseText: string, problem: string, format: MediaAudioFormat | null, contentType: string | null, metadata?: MediaAudioMetadata, usage?: MediaAudioUsage, input: MediaInputReference | null, resultInput: MediaInputReference | null, attachment?: Attachment, previewInput: string | null, result: MediaAudioResult | null, canCancel: boolean, canRetryDownload: boolean, canResume: boolean, canCleanup: boolean, canRelease: boolean, createdAt: number, updatedAt: number, request: MediaSpeakersRequest, } | { "kind": "voiceDesign", id: string, prompt: string, model: string, connection: string, revision: number, source: MediaSource, phase: MediaPhase, phaseText: string, problem: string, format: MediaAudioFormat | null, contentType: string | null, metadata?: MediaAudioMetadata, usage?: MediaAudioUsage, input: MediaInputReference | null, resultInput: MediaInputReference | null, attachment?: Attachment, previewInput: string | null, result: MediaAudioResult | null, canCancel: boolean, canRetryDownload: boolean, canResume: boolean, canCleanup: boolean, canRelease: boolean, createdAt: number, updatedAt: number, request: MediaVoiceDesignRequest, } | { "kind": "clone", id: string, prompt: string, model: string, connection: string, revision: number, source: MediaSource, phase: MediaPhase, phaseText: string, problem: string, format: MediaAudioFormat | null, contentType: string | null, metadata?: MediaAudioMetadata, usage?: MediaAudioUsage, input: MediaInputReference | null, resultInput: MediaInputReference | null, attachment?: Attachment, previewInput: string | null, result: MediaAudioResult | null, canCancel: boolean, canRetryDownload: boolean, canResume: boolean, canCleanup: boolean, canRelease: boolean, createdAt: number, updatedAt: number, request: MediaCloneRequest, } | { "kind": "transcription", id: string, prompt: string, model: string, connection: string, revision: number, source: MediaSource, phase: MediaPhase, phaseText: string, problem: string, format: MediaAudioFormat | null, contentType: string | null, metadata?: MediaAudioMetadata, usage?: MediaAudioUsage, input: MediaInputReference | null, resultInput: MediaInputReference | null, attachment?: Attachment, previewInput: string | null, result: MediaAudioResult | null, canCancel: boolean, canRetryDownload: boolean, canResume: boolean, canCleanup: boolean, canRelease: boolean, createdAt: number, updatedAt: number, request: MediaTranscriptionRequest, };

export type MediaInputRequest = { kind: MediaInputKind, name: string, mime: string, size: number, };

export const MediaInputPhaseValues = ["reserved", "uploading", "ready", "failed", "deleting"] as const;
export type MediaInputPhase = (typeof MediaInputPhaseValues)[number];

export type MediaInput = { id: string, kind: MediaInputKind, name: string, mime: string, size: number, phase: MediaInputPhase, hash: string | null, createdAt: number, expiresAt: number, canDelete: boolean, };

export const MediaImageFormatValues = ["text", "layout"] as const;
export type MediaImageFormat = (typeof MediaImageFormatValues)[number];

export type MediaImageRequest = { id: string, prompt: string, format: MediaImageFormat, width: number, height: number, seed?: number, steps?: number, guidance?: number, negativePrompt?: string, enhance: boolean, watermark: boolean, };

export type MediaImageUsage = { images: number, width: number, height: number, };

export const MediaImageJobKindValues = ["image"] as const;
export type MediaImageJobKind = (typeof MediaImageJobKindValues)[number];

export type MediaImageJob = { kind: MediaImageJobKind, id: string, prompt: string, model: string, connection: string, revision: number, source: MediaSource, usage?: MediaImageUsage, phase: MediaPhase, phaseText: string, problem: string, attachment?: Attachment, canCancel: boolean, canRetryDownload: boolean, createdAt: number, updatedAt: number, };

export type MediaUnderstandingRequest = { id: string, prompt: string, inputs: Array<string>, connection: string, revision: number, allowUpload: true, maxOutputTokens: number, };

export type MediaUnderstandingAuthorizationRequest = { id: string, prompt: string, inputs: Array<string>, connection: string, revision: number, allowUpload: true, maxOutputTokens: number, channel: string, };

export type MediaUnderstandingAuthorization = { channel: string, expiresAt: number, };

export const MediaUnderstandingStatusValues = ["completed", "incomplete"] as const;
export type MediaUnderstandingStatus = (typeof MediaUnderstandingStatusValues)[number];

export const MediaUnderstandingResultIncompleteReasonValues = ["max_output_tokens"] as const;
export type MediaUnderstandingResultIncompleteReason = (typeof MediaUnderstandingResultIncompleteReasonValues)[number];

export type MediaUnderstandingResultUsage = { inputTokens: number, outputTokens: number, totalTokens: number, };

export type MediaUnderstandingResult = { model: string, text: string, status: MediaUnderstandingStatus, incompleteReason: MediaUnderstandingResultIncompleteReason | null, usage: MediaUnderstandingResultUsage, };

export const MediaUnderstandingJobKindValues = ["understanding"] as const;
export type MediaUnderstandingJobKind = (typeof MediaUnderstandingJobKindValues)[number];

export const MediaUnderstandingPhaseValues = ["authorized", "queued", "uploading", "generating", "ready", "incomplete", "failed", "unknown", "canceled"] as const;
export type MediaUnderstandingPhase = (typeof MediaUnderstandingPhaseValues)[number];

export const MediaCleanupValues = ["pending", "running", "done", "blocked", "unknown"] as const;
export type MediaCleanup = (typeof MediaCleanupValues)[number];

export type MediaUnderstandingJob = { kind: MediaUnderstandingJobKind, id: string, prompt: string, inputs: Array<MediaInputReference>, model: string, connection: string, revision: number, source: MediaSource, authorization: MediaUnderstandingAuthorization | null, phase: MediaUnderstandingPhase, phaseText: string, problem: string, result: MediaUnderstandingResult | null, cleanup: MediaCleanup, cleanupText: string, canCancel: boolean, canCleanup: boolean, canRetryDownload: false, createdAt: number, updatedAt: number, };

export type MediaSpeechEvent = { "type": "format", sampleRate: number, channels: number, 
/**
 * Always 16.
 */
bitDepth: 16, } | { "type": "audio", sequence: number, audio: string, } | { "type": "done", } | { "type": "failed", };

export type MediaSpeechRequest = { id: string, text: string, voice: string, format: MediaAudioFormat, asynchronous?: boolean, streaming?: boolean, connection: string, revision: number, };

export const MediaSpeechJobKindValues = ["speech"] as const;
export type MediaSpeechJobKind = (typeof MediaSpeechJobKindValues)[number];

export type MediaSpeechJob = { kind: MediaSpeechJobKind, id: string, prompt: string, model: string, connection: string, revision: number, source: MediaSource, voice: string, format: MediaAudioFormat, contentType?: string, metadata?: MediaAudioMetadata, usage?: MediaAudioUsage, canResume?: boolean, canRelease: boolean, phase: MediaPhase, phaseText: string, problem: string, attachment?: Attachment, resultInput: MediaInputReference | null, canCancel: boolean, canRetryDownload: boolean, createdAt: number, updatedAt: number, };

export type MediaJob = MediaImageJob | MediaUnderstandingJob | MediaSpeechJob | MediaAudioJob;

export type MediaJobRequest = { id: string, };

export type FactMediaChanged = { "type": "mediaChanged", at: number, jobs: Array<MediaJob>, };

export const JobKindValues = ["image", "understanding", "speech", "speakers", "voiceDesign", "clone", "transcription"] as const;
export type JobKind = (typeof JobKindValues)[number];

export type LibraryOriginFetchedFrom = { url: string, } | { path: string, };

/**
 * Duplicate bytes only advance lastAt without overwriting origin.
 */
export type LibraryOrigin = { "kind": "generated", job: string, jobKind: JobKind, } | { "kind": "uploaded", channel?: string, message?: MessageId, } | { "kind": "fetched", agent: string, session?: SessionId, from: LibraryOriginFetchedFrom, };

export type LibraryItem = { attachment: Attachment, origin: LibraryOrigin, addedAt: number, lastAt: number, };

export const LibraryOriginKindValues = ["generated", "uploaded", "fetched"] as const;
export type LibraryOriginKind = (typeof LibraryOriginKindValues)[number];

export const LibraryFileKindValues = ["image", "audio", "video", "other"] as const;
export type LibraryFileKind = (typeof LibraryFileKindValues)[number];

export const LibrarySortValues = ["recent", "name", "size"] as const;
export type LibrarySort = (typeof LibrarySortValues)[number];

export type LibraryListRequest = { origin?: LibraryOriginKind, type?: LibraryFileKind, text?: string, sort?: LibrarySort, };

/**
 * Exactly one of attachment, url, or path must be set.
 */
export type LibraryAddRequest = { attachment?: string, url?: string, path?: string, name?: string, };

export type MediaInputAdoptInput = { attachment: string, };

export type LibraryItemDeleteInput = { id: string, };

export type Id = string;

export type VoiceId = string;

export type SpeakerId = string;

export type InputName = string;

export type Tokens = number;

export type LibraryItems = Array<{ attachment: Attachment, origin: LibraryOrigin, addedAt: number, lastAt: number, }>;
