// Written by scripts/api-client.ts from api.ts (Handlers and endpoints); do not edit: vp run api:client.

import type { z } from "zod";

import { t } from "@vibevalley/i18n";

import {
  type ApiErrorDetail,
  ApiErrorEnvelope,
  type ApiErrorKind,
  apiSuccessEnvelope,
  ApiVoidEnvelope,
  bizCodeMeta,
  type BizErrorCode,
  endpoints,
  pathOf,
} from "./api";
import type * as T from "./shapes";

/** A refusal from the server: its business code, semantic kind (Refused, VoiceUnavailable…), reason, and optional remediation detail. */
export class VibeValleyApiError extends Error {
  readonly status: number;
  readonly bizCode: BizErrorCode | undefined;
  readonly tag: ApiErrorKind | undefined;
  readonly reason: string;
  /** Structured remediation detail inside the envelope's error field (next steps, settings section). */
  readonly error: ApiErrorDetail | undefined;
  /** The response exactly as received, including plain text that was not JSON. */
  readonly body: string | undefined;

  constructor(status: number, tag: ApiErrorKind | undefined, reason: string, error?: ApiErrorDetail, body?: string, bizCode?: BizErrorCode) {
    super(reason);
    this.status = status;
    this.bizCode = bizCode;
    this.tag = tag;
    this.reason = reason;
    this.error = error;
    this.body = body;
  }
}

const decodeApiError = (u: unknown) => {
  const r = ApiErrorEnvelope.safeParse(u);
  return r.success ? r.data : undefined;
};
const resultDecoders = new Map<string, { readonly hasData: boolean; readonly envelope: z.ZodType }>();
for (const e of endpoints) {
  resultDecoders.set(pathOf(e.op), { hasData: e.result !== undefined, envelope: e.result ? apiSuccessEnvelope(e.result) : ApiVoidEnvelope });
}

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null;

export type VibeValleyCaller = (op: string, input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");

/** The server's HTTP or bridge API, one object per module and noun, a method per op: `api.issue.status.update({ id, status })`. */
export class VibeValleyApi {
  /** The server's address; empty is the page's own origin, which serves it. */
  readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  private readonly caller: VibeValleyCaller | undefined;
  /** A device key to send as a Bearer token: the command line's, signed in to a server through its gate. */
  private readonly key: string | undefined;

  constructor(
    base = "",
    fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
    key?: string,
    caller?: VibeValleyCaller,
  ) {
    this.base = base;
    this.fetcher = fetcher;
    this.key = key;
    this.caller = caller;
  }

  /** Calls endpoints directly via an in-process envelope transport without HTTP or JSON round-trips. */
  static over(caller: VibeValleyCaller): VibeValleyApi {
    return new VibeValleyApi("", undefined, undefined, caller);
  }

  readonly server = {
    health: {
      get: (options?: { signal?: AbortSignal }): Promise<T.Health> => this.call<T.Health>("server.health.get", "/api/v1/server/health/get", undefined, options),
    },
  };

  readonly orchestrator = {
    open: (options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("orchestrator.open", "/api/v1/orchestrator/open", undefined, options),
    /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
    stop: (a: { agent?: string }, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("orchestrator.stop", "/api/v1/orchestrator/stop", a, options),
    eval: {
      /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
      create: (a: T.OrchestratorEvalRequest, options?: { signal?: AbortSignal }): Promise<T.OrchestratorEval> =>
        this.call<T.OrchestratorEval>("orchestrator.eval.create", "/api/v1/orchestrator/eval/create", a, options),
    },
    approval: {
      list: (a: T.OrchestratorApprovalListInput, options?: { signal?: AbortSignal }): Promise<T.OrchestratorApproval[]> =>
        this.call<T.OrchestratorApproval[]>("orchestrator.approval.list", "/api/v1/orchestrator/approval/list", a, options),
      resolve: (a: T.OrchestratorApprovalResolveInput, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("orchestrator.approval.resolve", "/api/v1/orchestrator/approval/resolve", a, options),
    },
  };

  readonly setting = {
    get: (options?: { signal?: AbortSignal }): Promise<T.SettingsStatus> =>
      this.call<T.SettingsStatus>("setting.get", "/api/v1/setting/get", undefined, options),
    /** The first thing Save would refuse in these settings, without saving them. */
    validate: (a: T.SettingsUpdate, options?: { signal?: AbortSignal }): Promise<T.Validation> =>
      this.call<T.Validation>("setting.validate", "/api/v1/setting/validate", a, options),
    update: (a: T.SettingsUpdate, options?: { signal?: AbortSignal }): Promise<T.SettingsStatus> =>
      this.call<T.SettingsStatus>("setting.update", "/api/v1/setting/update", a, options),
  };

  readonly provider = {
    get: (options?: { signal?: AbortSignal }): Promise<T.ProviderStatus> =>
      this.call<T.ProviderStatus>("provider.get", "/api/v1/provider/get", undefined, options),
    update: (a: T.ProviderUpdate, options?: { signal?: AbortSignal }): Promise<T.ProviderStatus> =>
      this.call<T.ProviderStatus>("provider.update", "/api/v1/provider/update", a, options),
    voice: {
      list: (a: T.ProviderVoiceRequest, options?: { signal?: AbortSignal }): Promise<T.ProviderVoiceListing> =>
        this.call<T.ProviderVoiceListing>("provider.voice.list", "/api/v1/provider/voice/list", a, options),
    },
    model: {
      list: (a: T.ProviderModelRequest, options?: { signal?: AbortSignal }): Promise<T.ProviderModelListing> =>
        this.call<T.ProviderModelListing>("provider.model.list", "/api/v1/provider/model/list", a, options),
    },
  };

  readonly media = {
    dialogue: {
      create: (a: T.MediaSpeakersRequest, options?: { signal?: AbortSignal }): Promise<T.MediaAudioJob> =>
        this.call<T.MediaAudioJob>("media.dialogue.create", "/api/v1/media/dialogue/create", a, options),
    },
    voiceDesign: {
      create: (a: T.MediaVoiceDesignRequest, options?: { signal?: AbortSignal }): Promise<T.MediaAudioJob> =>
        this.call<T.MediaAudioJob>("media.voiceDesign.create", "/api/v1/media/voiceDesign/create", a, options),
    },
    clone: {
      create: (a: T.MediaCloneRequest, options?: { signal?: AbortSignal }): Promise<T.MediaAudioJob> =>
        this.call<T.MediaAudioJob>("media.clone.create", "/api/v1/media/clone/create", a, options),
    },
    transcription: {
      create: (a: T.MediaTranscriptionRequest, options?: { signal?: AbortSignal }): Promise<T.MediaAudioJob> =>
        this.call<T.MediaAudioJob>("media.transcription.create", "/api/v1/media/transcription/create", a, options),
    },
    audio: {
      resume: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaAudioJob> =>
        this.call<T.MediaAudioJob>("media.audio.resume", "/api/v1/media/audio/resume", a, options),
      previewCleanup: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("media.audio.previewCleanup", "/api/v1/media/audio/previewCleanup", a, options),
      cleanup: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaAudioJob> =>
        this.call<T.MediaAudioJob>("media.audio.cleanup", "/api/v1/media/audio/cleanup", a, options),
    },
    input: {
      create: (a: T.MediaInputRequest, options?: { signal?: AbortSignal }): Promise<T.MediaInput> =>
        this.call<T.MediaInput>("media.input.create", "/api/v1/media/input/create", a, options),
      /** A kept attachment (a library item) taken as an input, checked as an upload is. */
      adopt: (a: { attachment: string }, options?: { signal?: AbortSignal }): Promise<T.MediaInput> =>
        this.call<T.MediaInput>("media.input.adopt", "/api/v1/media/input/adopt", a, options),
      get: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaInput> =>
        this.call<T.MediaInput>("media.input.get", "/api/v1/media/input/get", a, options),
      list: (options?: { signal?: AbortSignal }): Promise<T.MediaInput[]> =>
        this.call<T.MediaInput[]>("media.input.list", "/api/v1/media/input/list", undefined, options),
      delete: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("media.input.delete", "/api/v1/media/input/delete", a, options),
      previewDelete: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("media.input.previewDelete", "/api/v1/media/input/previewDelete", a, options),
    },
    image: {
      create: (a: T.MediaImageRequest, options?: { signal?: AbortSignal }): Promise<T.MediaImageJob> =>
        this.call<T.MediaImageJob>("media.image.create", "/api/v1/media/image/create", a, options),
    },
    understanding: {
      create: (a: T.MediaUnderstandingRequest, options?: { signal?: AbortSignal }): Promise<T.MediaUnderstandingJob> =>
        this.call<T.MediaUnderstandingJob>("media.understanding.create", "/api/v1/media/understanding/create", a, options),
      authorize: (a: T.MediaUnderstandingAuthorizationRequest, options?: { signal?: AbortSignal }): Promise<T.MediaUnderstandingJob> =>
        this.call<T.MediaUnderstandingJob>("media.understanding.authorize", "/api/v1/media/understanding/authorize", a, options),
      start: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaUnderstandingJob> =>
        this.call<T.MediaUnderstandingJob>("media.understanding.start", "/api/v1/media/understanding/start", a, options),
      previewCleanup: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("media.understanding.previewCleanup", "/api/v1/media/understanding/previewCleanup", a, options),
      cleanup: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaUnderstandingJob> =>
        this.call<T.MediaUnderstandingJob>("media.understanding.cleanup", "/api/v1/media/understanding/cleanup", a, options),
    },
    speech: {
      create: (a: T.MediaSpeechRequest, options?: { signal?: AbortSignal }): Promise<T.MediaSpeechJob> =>
        this.call<T.MediaSpeechJob>("media.speech.create", "/api/v1/media/speech/create", a, options),
      resume: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaSpeechJob> =>
        this.call<T.MediaSpeechJob>("media.speech.resume", "/api/v1/media/speech/resume", a, options),
    },
    job: {
      get: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaJob> =>
        this.call<T.MediaJob>("media.job.get", "/api/v1/media/job/get", a, options),
      cancel: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaJob> =>
        this.call<T.MediaJob>("media.job.cancel", "/api/v1/media/job/cancel", a, options),
      previewRelease: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("media.job.previewRelease", "/api/v1/media/job/previewRelease", a, options),
      release: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaJob> =>
        this.call<T.MediaJob>("media.job.release", "/api/v1/media/job/release", a, options),
      download: (a: T.MediaJobRequest, options?: { signal?: AbortSignal }): Promise<T.MediaJob> =>
        this.call<T.MediaJob>("media.job.download", "/api/v1/media/job/download", a, options),
      list: (options?: { signal?: AbortSignal }): Promise<T.MediaJob[]> =>
        this.call<T.MediaJob[]>("media.job.list", "/api/v1/media/job/list", undefined, options),
    },
  };

  readonly library = {
    item: {
      /** Newest first. */
      list: (a: T.LibraryListRequest, options?: { signal?: AbortSignal }): Promise<T.LibraryItem[]> =>
        this.call<T.LibraryItem[]>("library.item.list", "/api/v1/library/item/list", a, options),
      add: (a: T.LibraryAddRequest, options?: { signal?: AbortSignal }): Promise<T.LibraryItem> =>
        this.call<T.LibraryItem>("library.item.add", "/api/v1/library/item/add", a, options),
      /** Only the item goes: a message that has the file still opens it. */
      delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("library.item.delete", "/api/v1/library/item/delete", a, options),
      previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("library.item.previewDelete", "/api/v1/library/item/previewDelete", a, options),
    },
  };

  readonly channel = {
    create: (a: T.ChannelRequest, options?: { signal?: AbortSignal }): Promise<string> =>
      this.call<string>("channel.create", "/api/v1/channel/create", a, options),
    update: (a: { id: string } & T.ChannelUpdate, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("channel.update", "/api/v1/channel/update", a, options),
    markRead: (a: { id: string } & T.ChatReadRequest, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("channel.markRead", "/api/v1/channel/markRead", a, options),
    /** A channel nothing points at any more, with its threads and messages. */
    delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("channel.delete", "/api/v1/channel/delete", a, options),
    /** What channel.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("channel.previewDelete", "/api/v1/channel/previewDelete", a, options),
    /** The user's read moved back to just before this message. */
    markUnread: (a: { id: string } & T.ChatReadRequest, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("channel.markUnread", "/api/v1/channel/markUnread", a, options),
    /** Every channel and direct channel, the default first. */
    list: (options?: { signal?: AbortSignal }): Promise<T.Channel[]> => this.call<T.Channel[]>("channel.list", "/api/v1/channel/list", undefined, options),
    message: {
      send: (a: T.SayRequest, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("channel.message.send", "/api/v1/channel/message/send", a, options),
      /** What deleteTask would do, refused as it would be; nothing changes. */
      list: (a: { id: string; before?: number; limit?: number }, options?: { signal?: AbortSignal }): Promise<T.ChatMessage[]> =>
        this.call<T.ChatMessage[]>("channel.message.list", "/api/v1/channel/message/list", a, options),
      /** The user's own words, changed; nobody is told again. */
      update: (a: T.MessageEdit, options?: { signal?: AbortSignal }): Promise<T.ChatMessage> =>
        this.call<T.ChatMessage>("channel.message.update", "/api/v1/channel/message/update", a, options),
      /** Any message: its words go, its number stays, and what it still had to hand is dropped. */
      delete: (a: { id: T.MessageId }, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("channel.message.delete", "/api/v1/channel/message/delete", a, options),
      /** What channel.message.delete would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: T.MessageId }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("channel.message.previewDelete", "/api/v1/channel/message/previewDelete", a, options),
      search: (a: T.MessageSearch, options?: { signal?: AbortSignal }): Promise<T.MessageHit[]> =>
        this.call<T.MessageHit[]>("channel.message.search", "/api/v1/channel/message/search", a, options),
    },
    default: {
      /** The channel what names none goes to from now on: a connector's, a call's. */
      set: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("channel.default.set", "/api/v1/channel/default/set", a, options),
    },
    reaction: {
      /** The user's reaction on or off; as it already is, nothing changes. */
      set: (a: T.ReactionSet, options?: { signal?: AbortSignal }): Promise<T.ChatMessage> =>
        this.call<T.ChatMessage>("channel.reaction.set", "/api/v1/channel/reaction/set", a, options),
    },
    pin: {
      /** The message pinned or not; as it already is, nothing changes. */
      set: (a: { id: T.MessageId; on: boolean }, options?: { signal?: AbortSignal }): Promise<T.ChatMessage> =>
        this.call<T.ChatMessage>("channel.pin.set", "/api/v1/channel/pin/set", a, options),
      /** A channel's pinned messages, newest pinned first. */
      list: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.ChatMessage[]> =>
        this.call<T.ChatMessage[]>("channel.pin.list", "/api/v1/channel/pin/list", a, options),
    },
    thread: {
      /** The thread under a message, made if it has none: its id. requestKey: as IssueRequest's. */
      create: (a: { id: T.MessageId; requestKey?: string }, options?: { signal?: AbortSignal }): Promise<string> =>
        this.call<string>("channel.thread.create", "/api/v1/channel/thread/create", a, options),
    },
    archive: {
      /** Out of the sidebar and the thread lists (on), or back. its messages and address stay. */
      set: (a: T.OnSet, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("channel.archive.set", "/api/v1/channel/archive/set", a, options),
    },
    direct: {
      /** The user's direct channel with a helper profile (or the orchestrator), made if there is none: its id. */
      create: (a: { agent: string }, options?: { signal?: AbortSignal }): Promise<string> =>
        this.call<string>("channel.direct.create", "/api/v1/channel/direct/create", a, options),
    },
    notify: {
      set: (a: T.NotifyRequest, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("channel.notify.set", "/api/v1/channel/notify/set", a, options),
    },
    unread: {
      /** The places the caller has not read all of, the newest first. */
      list: (options?: { signal?: AbortSignal }): Promise<T.ChannelUnread[]> =>
        this.call<T.ChannelUnread[]>("channel.unread.list", "/api/v1/channel/unread/list", undefined, options),
    },
  };

  readonly cron = {
    create: (a: T.CronRequest, options?: { signal?: AbortSignal }): Promise<T.Cron> => this.call<T.Cron>("cron.create", "/api/v1/cron/create", a, options),
    list: (options?: { signal?: AbortSignal }): Promise<T.Cron[]> => this.call<T.Cron[]>("cron.list", "/api/v1/cron/list", undefined, options),
    /** Only what the body gives changes. */
    update: (a: { id: string } & T.CronUpdate, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("cron.update", "/api/v1/cron/update", a, options),
    delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("cron.delete", "/api/v1/cron/delete", a, options),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("cron.previewDelete", "/api/v1/cron/previewDelete", a, options),
  };

  readonly voice = {
    /** A line heard on the call that is on, without its id: refused unless one call is. */
    hear: (a: { text: string; agent?: string; sendKey?: string }, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("voice.hear", "/api/v1/voice/hear", a, options),
    dictate: (a: T.DictateRequest, options?: { signal?: AbortSignal }): Promise<T.Dictated> =>
      this.call<T.Dictated>("voice.dictate", "/api/v1/voice/dictate", a, options),
    moss: {
      /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
      verify: (options?: { signal?: AbortSignal }): Promise<T.Validation> =>
        this.call<T.Validation>("voice.moss.verify", "/api/v1/voice/moss/verify", undefined, options),
    },
    grant: {
      create: (options?: { signal?: AbortSignal }): Promise<T.AgoraGrant> =>
        this.call<T.AgoraGrant>("voice.grant.create", "/api/v1/voice/grant/create", undefined, options),
      renew: (a: T.VoiceGrantRenew, options?: { signal?: AbortSignal }): Promise<T.AgoraGrant> =>
        this.call<T.AgoraGrant>("voice.grant.renew", "/api/v1/voice/grant/renew", a, options),
    },
    call: {
      start: (a: T.VoiceCallStart, options?: { signal?: AbortSignal }): Promise<T.VoiceCall> =>
        this.call<T.VoiceCall>("voice.call.start", "/api/v1/voice/call/start", a, options),
      stop: (a: T.VoiceCall, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("voice.call.stop", "/api/v1/voice/call/stop", a, options),
      hear: (a: T.VoiceHeard, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("voice.call.hear", "/api/v1/voice/call/hear", a, options),
      say: (a: T.VoiceSaid, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("voice.call.say", "/api/v1/voice/call/say", a, options),
    },
  };

  readonly issue = {
    /** The open issues by default, the newest first; the filter narrows them. */
    list: (a: T.IssueFilter, options?: { signal?: AbortSignal }): Promise<T.Issue[]> => this.call<T.Issue[]>("issue.list", "/api/v1/issue/list", a, options),
    /** A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done. */
    review: (a: { id: string } & T.IssueReviewRequest, options?: { signal?: AbortSignal }): Promise<T.Issue> =>
      this.call<T.Issue>("issue.review", "/api/v1/issue/review", a, options),
    /** The issue becomes a parent issue and the split's issues its children, started at once. */
    split: (a: { id: string } & T.IssueSplitRequest, options?: { signal?: AbortSignal }): Promise<string> =>
      this.call<string>("issue.split", "/api/v1/issue/split", a, options),
    get: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Issue> => this.call<T.Issue>("issue.get", "/api/v1/issue/get", a, options),
    create: (a: T.IssueRequest, options?: { signal?: AbortSignal }): Promise<T.AppliedIssue> =>
      this.call<T.AppliedIssue>("issue.create", "/api/v1/issue/create", a, options),
    update: (a: { id: string } & T.IssueUpdate, options?: { signal?: AbortSignal }): Promise<T.AppliedIssue> =>
      this.call<T.AppliedIssue>("issue.update", "/api/v1/issue/update", a, options),
    delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("issue.delete", "/api/v1/issue/delete", a, options),
    /** What issue.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("issue.previewDelete", "/api/v1/issue/previewDelete", a, options),
    /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then leaves. */
    refine: (a: { id: string } & T.IssueRefineRequest, options?: { signal?: AbortSignal }): Promise<T.Issue> =>
      this.call<T.Issue>("issue.refine", "/api/v1/issue/refine", a, options),
    conversation: {
      get: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<string | null> =>
        this.call<string | null>("issue.conversation.get", "/api/v1/issue/conversation/get", a, options),
    },
    comment: {
      /** To the issue's newest session, as the user: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
      create: (a: { id: string } & T.CommentRequest, options?: { signal?: AbortSignal }): Promise<T.Applied> =>
        this.call<T.Applied>("issue.comment.create", "/api/v1/issue/comment/create", a, options),
    },
    diff: {
      get: (a: { id: string; sinceTree?: string }, options?: { signal?: AbortSignal }): Promise<T.Changes> =>
        this.call<T.Changes>("issue.diff.get", "/api/v1/issue/diff/get", a, options),
    },
    history: {
      /** One joined read of issues and their real sessions, including explicit missing records. */
      list: (options?: { signal?: AbortSignal }): Promise<T.IssueHistory[]> =>
        this.call<T.IssueHistory[]>("issue.history.list", "/api/v1/issue/history/list", undefined, options),
    },
    run: {
      list: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Run[]> =>
        this.call<T.Run[]>("issue.run.list", "/api/v1/issue/run/list", a, options),
    },
    timeline: {
      /** The issue's milestones, newest first, and what all its runs cost. */
      get: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.IssueTimeline> =>
        this.call<T.IssueTimeline>("issue.timeline.get", "/api/v1/issue/timeline/get", a, options),
    },
    status: {
      /** Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is another round (the words are the findings. */
      update: (a: { id: string } & T.IssueStatusRequest, options?: { signal?: AbortSignal }): Promise<T.AppliedIssue> =>
        this.call<T.AppliedIssue>("issue.status.update", "/api/v1/issue/status/update", a, options),
      /** What issue.status.update would do with the same body, refused as it would be; nothing changes. */
      previewUpdate: (a: { id: string } & T.IssueStatusRequest, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("issue.status.previewUpdate", "/api/v1/issue/status/previewUpdate", a, options),
    },
  };

  readonly session = {
    /** Stops a session's turn; it stays, and a comment starts the next. */
    stop: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("session.stop", "/api/v1/session/stop", a, options),
    list: (a: { agent?: string }, options?: { signal?: AbortSignal }): Promise<T.Session[]> =>
      this.call<T.Session[]>("session.list", "/api/v1/session/list", a, options),
    get: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Session> => this.call<T.Session>("session.get", "/api/v1/session/get", a, options),
    event: {
      /** Its log, oldest first. run gives one run's only. */
      list: (a: { id: string; run?: string }, options?: { signal?: AbortSignal }): Promise<T.SessionEvent[]> =>
        this.call<T.SessionEvent[]>("session.event.list", "/api/v1/session/event/list", a, options),
    },
  };

  readonly artifact = {
    /** The artifacts announced in a channel or made for an issue, newest change first; every one the farm has when neither is given. */
    list: (a: T.ArtifactListRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact[]> =>
      this.call<T.Artifact[]>("artifact.list", "/api/v1/artifact/list", a, options),
    get: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
      this.call<T.Artifact>("artifact.get", "/api/v1/artifact/get", a, options),
    /** Without content, an empty blocks one to write in; with content, a hand-in its maker announces with its card. */
    create: (a: T.ArtifactRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
      this.call<T.Artifact>("artifact.create", "/api/v1/artifact/create", a, options),
    /** Its title, as the user renames it. */
    update: (a: T.ArtifactUpdateRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
      this.call<T.Artifact>("artifact.update", "/api/v1/artifact/update", a, options),
    delete: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("artifact.delete", "/api/v1/artifact/delete", a, options),
    previewDelete: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("artifact.previewDelete", "/api/v1/artifact/previewDelete", a, options),
    /** A batch of ops, as the user: taken in order, in one transaction, one batch at a time. */
    submit: (a: { id: T.ArtifactId } & T.BlockSubmit, options?: { signal?: AbortSignal }): Promise<T.BlockAck> =>
      this.call<T.BlockAck>("artifact.submit", "/api/v1/artifact/submit", a, options),
    /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
     * one already running is refused. */
    demo: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("artifact.demo", "/api/v1/artifact/demo", a, options),
    content: {
      /** Its words: an html one's version as made, a blocks one's Markdown now (its version is its seq). What an agent reads
       * to make the next one. */
      get: (a: T.ArtifactReadRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactContent> =>
        this.call<T.ArtifactContent>("artifact.content.get", "/api/v1/artifact/content/get", a, options),
    },
    version: {
      /** An html one's new version over the latest. the old ones stay. */
      create: (a: T.ArtifactVersionRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.version.create", "/api/v1/artifact/version/create", a, options),
    },
    html: {
      /** The user's words in place of some in an html one's page: the next version, the rest of its bytes as they were. */
      edit: (a: T.ArtifactHtmlEdit, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.html.edit", "/api/v1/artifact/html/edit", a, options),
    },
    block: {
      /** A blocks artifact and every live block (no tombstones), in order. */
      list: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.BlockSnapshot> =>
        this.call<T.BlockSnapshot>("artifact.block.list", "/api/v1/artifact/block/list", a, options),
      /** One block inserted, as one batch of one op. */
      create: (a: { id: T.ArtifactId } & T.BlockCreate, options?: { signal?: AbortSignal }): Promise<T.BlockOpResult> =>
        this.call<T.BlockOpResult>("artifact.block.create", "/api/v1/artifact/block/create", a, options),
      /** One block's words, type or attrs changed, as one batch. */
      update: (a: { id: T.ArtifactId } & T.BlockUpdate, options?: { signal?: AbortSignal }): Promise<T.BlockOpResult> =>
        this.call<T.BlockOpResult>("artifact.block.update", "/api/v1/artifact/block/update", a, options),
      /** One block and its children put in their tombstones. */
      delete: (a: { id: T.ArtifactId } & T.BlockDelete, options?: { signal?: AbortSignal }): Promise<T.BlockOpResult> =>
        this.call<T.BlockOpResult>("artifact.block.delete", "/api/v1/artifact/block/delete", a, options),
      previewDelete: (a: { id: T.ArtifactId } & T.BlockDelete, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("artifact.block.previewDelete", "/api/v1/artifact/block/previewDelete", a, options),
    },
    suggestion: {
      /** The open and resolved suggestions on an artifact, oldest first. */
      list: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.Suggestion[]> =>
        this.call<T.Suggestion[]>("artifact.suggestion.list", "/api/v1/artifact/suggestion/list", a, options),
      /** A change an agent proposes to a block the user wrote. */
      create: (a: { id: T.ArtifactId } & T.SuggestionCreate, options?: { signal?: AbortSignal }): Promise<T.Suggestion> =>
        this.call<T.Suggestion>("artifact.suggestion.create", "/api/v1/artifact/suggestion/create", a, options),
      /** The user takes a suggestion; a block that moved on since it was read comes back stale, and is not changed. */
      accept: (a: { id: T.ArtifactId; suggestion: T.SuggestionId }, options?: { signal?: AbortSignal }): Promise<T.Suggestion> =>
        this.call<T.Suggestion>("artifact.suggestion.accept", "/api/v1/artifact/suggestion/accept", a, options),
      reject: (a: { id: T.ArtifactId; suggestion: T.SuggestionId }, options?: { signal?: AbortSignal }): Promise<T.Suggestion> =>
        this.call<T.Suggestion>("artifact.suggestion.reject", "/api/v1/artifact/suggestion/reject", a, options),
    },
    markdown: {
      /** A blocks artifact as Markdown: the format artifacts trade with agents and MEMORY.md in, not how they are stored. */
      get: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.ArtifactMarkdown> =>
        this.call<T.ArtifactMarkdown>("artifact.markdown.get", "/api/v1/artifact/markdown/get", a, options),
    },
    type: {
      /** All structured artifact types and the farm's standing default design-system if any. */
      list: (options?: { signal?: AbortSignal }): Promise<T.ArtifactTypeInfo[]> =>
        this.call<T.ArtifactTypeInfo[]>("artifact.type.list", "/api/v1/artifact/type/list", undefined, options),
      /** A structured artifact type's SKILL.md guide or one of its named reference chapters. */
      read: (a: T.ArtifactTypeReadRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactTypeGuide> =>
        this.call<T.ArtifactTypeGuide>("artifact.type.read", "/api/v1/artifact/type/read", a, options),
    },
    entry: {
      /** A store artifact's entries (filtered by path prefix when given), with values when requested. */
      list: (a: T.ArtifactEntryListRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactEntrySnapshot> =>
        this.call<T.ArtifactEntrySnapshot>("artifact.entry.list", "/api/v1/artifact/entry/list", a, options),
      /** One store entry with its value and revision. */
      get: (a: T.ArtifactEntryGetRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactEntry> =>
        this.call<T.ArtifactEntry>("artifact.entry.get", "/api/v1/artifact/entry/get", a, options),
      /** An atomic batch of set, patch, delete or copy writes on a store artifact with per-entry optimistic concurrency. */
      batch: (a: T.ArtifactEntryBatchRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactEntryBatchResult> =>
        this.call<T.ArtifactEntryBatchResult>("artifact.entry.batch", "/api/v1/artifact/entry/batch", a, options),
    },
  };

  readonly game = {
    achievement: {
      /** Every achievement, as the board has them. */
      list: (options?: { signal?: AbortSignal }): Promise<T.Achievement[]> =>
        this.call<T.Achievement[]>("game.achievement.list", "/api/v1/game/achievement/list", undefined, options),
    },
    title: {
      set: (a: T.ChooseTitleRequest, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("game.title.set", "/api/v1/game/title/set", a, options),
    },
  };

  readonly runtime = {
    list: (options?: { signal?: AbortSignal }): Promise<T.RuntimeInfo[]> =>
      this.call<T.RuntimeInfo[]>("runtime.list", "/api/v1/runtime/list", undefined, options),
    refresh: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.RuntimeInfo> =>
      this.call<T.RuntimeInfo>("runtime.refresh", "/api/v1/runtime/refresh", a, options),
    setting: {
      update: (a: { id: string } & T.RuntimeSettings, options?: { signal?: AbortSignal }): Promise<T.RuntimeInfo> =>
        this.call<T.RuntimeInfo>("runtime.setting.update", "/api/v1/runtime/setting/update", a, options),
    },
  };

  readonly repo = {
    list: (options?: { signal?: AbortSignal }): Promise<T.RepoSummary[]> => this.call<T.RepoSummary[]>("repo.list", "/api/v1/repo/list", undefined, options),
    /** The first thing Create would refuse in this repo, without making it. */
    validate: (a: T.NewRepo, options?: { signal?: AbortSignal }): Promise<T.Validation> =>
      this.call<T.Validation>("repo.validate", "/api/v1/repo/validate", a, options),
    create: (a: T.NewRepo, options?: { signal?: AbortSignal }): Promise<T.RepoSummary> =>
      this.call<T.RepoSummary>("repo.create", "/api/v1/repo/create", a, options),
    pr: {
      submit: (a: T.SubmitBranch, options?: { signal?: AbortSignal }): Promise<T.BranchPublication> =>
        this.call<T.BranchPublication>("repo.pr.submit", "/api/v1/repo/pr/submit", a, options),
    },
    language: {
      list: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.RepoLanguages> =>
        this.call<T.RepoLanguages>("repo.language.list", "/api/v1/repo/language/list", a, options),
    },
    template: {
      list: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.RepoTemplates> =>
        this.call<T.RepoTemplates>("repo.template.list", "/api/v1/repo/template/list", a, options),
    },
    activity: {
      get: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.RepoActivity> =>
        this.call<T.RepoActivity>("repo.activity.get", "/api/v1/repo/activity/get", a, options),
    },
  };

  readonly github = {
    get: (options?: { signal?: AbortSignal }): Promise<T.GitHubStatus> => this.call<T.GitHubStatus>("github.get", "/api/v1/github/get", undefined, options),
    refresh: (options?: { signal?: AbortSignal }): Promise<T.GitHubStatus> =>
      this.call<T.GitHubStatus>("github.refresh", "/api/v1/github/refresh", undefined, options),
  };

  readonly agent = {
    list: (options?: { signal?: AbortSignal }): Promise<T.Agent[]> => this.call<T.Agent[]>("agent.list", "/api/v1/agent/list", undefined, options),
    /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
    validate: (a: T.AgentValidateRequest, options?: { signal?: AbortSignal }): Promise<T.AgentValidation[]> =>
      this.call<T.AgentValidation[]>("agent.validate", "/api/v1/agent/validate", a, options),
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Agent, options?: { signal?: AbortSignal }): Promise<T.Agent> => this.call<T.Agent>("agent.create", "/api/v1/agent/create", a, options),
    update: (a: T.Agent, options?: { signal?: AbortSignal }): Promise<T.Agent> => this.call<T.Agent>("agent.update", "/api/v1/agent/update", a, options),
    delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("agent.delete", "/api/v1/agent/delete", a, options),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("agent.previewDelete", "/api/v1/agent/previewDelete", a, options),
    template: {
      /** The templates a profile can be installed from: the built-in ones, then those added on this machine. */
      list: (options?: { signal?: AbortSignal }): Promise<T.AgentTemplate[]> =>
        this.call<T.AgentTemplate[]>("agent.template.list", "/api/v1/agent/template/list", undefined, options),
      /** A new profile from a template; installing one again makes another. */
      install: (a: { id: string; runtime?: string | undefined }, options?: { signal?: AbortSignal }): Promise<T.Agent> =>
        this.call<T.Agent>("agent.template.install", "/api/v1/agent/template/install", a, options),
      /** A profile made again from its template's version now. */
      update: (a: { agent: string }, options?: { signal?: AbortSignal }): Promise<T.Agent> =>
        this.call<T.Agent>("agent.template.update", "/api/v1/agent/template/update", a, options),
      /** A template folder on this machine copied in beside the built-in ones; nothing is installed. */
      add: (a: { path: string }, options?: { signal?: AbortSignal }): Promise<T.AgentTemplate> =>
        this.call<T.AgentTemplate>("agent.template.add", "/api/v1/agent/template/add", a, options),
      /** An added template gone; the profiles installed from it stay. */
      delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("agent.template.delete", "/api/v1/agent/template/delete", a, options),
      /** What deleting the template would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
        this.call<T.Preview>("agent.template.previewDelete", "/api/v1/agent/template/previewDelete", a, options),
    },
  };

  readonly skill = {
    list: (options?: { signal?: AbortSignal }): Promise<T.Skill[]> => this.call<T.Skill[]>("skill.list", "/api/v1/skill/list", undefined, options),
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Skill, options?: { signal?: AbortSignal }): Promise<T.Skill> => this.call<T.Skill>("skill.create", "/api/v1/skill/create", a, options),
    update: (a: T.Skill, options?: { signal?: AbortSignal }): Promise<T.Skill> => this.call<T.Skill>("skill.update", "/api/v1/skill/update", a, options),
    delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("skill.delete", "/api/v1/skill/delete", a, options),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("skill.previewDelete", "/api/v1/skill/previewDelete", a, options),
  };

  readonly pkm = {
    search: (a: T.PkmSearchRequest, options?: { signal?: AbortSignal }): Promise<T.PkmSearchHit[]> =>
      this.call<T.PkmSearchHit[]>("pkm.search", "/api/v1/pkm/search", a, options),
    /** Into today's journal as LATER lines tagged #inbox (an agent's says who noted it), or at the end of a page. */
    capture: (a: T.PkmCaptureRequest, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
      this.call<T.PkmPage>("pkm.capture", "/api/v1/pkm/capture", a, options),
    /** Puts back the file the last change wrote. */
    undo: (options?: { signal?: AbortSignal }): Promise<T.PkmUndo> => this.call<T.PkmUndo>("pkm.undo", "/api/v1/pkm/undo", undefined, options),
    /** Reads again every file that changed on disk. */
    scan: (options?: { signal?: AbortSignal }): Promise<T.PkmScan> => this.call<T.PkmScan>("pkm.scan", "/api/v1/pkm/scan", undefined, options),
    page: {
      /** Every page in the vault, newest first; files changed on disk are read again first. */
      list: (options?: { signal?: AbortSignal }): Promise<T.PkmVault> => this.call<T.PkmVault>("pkm.page.list", "/api/v1/pkm/page/list", undefined, options),
      /** The page with its ((refs)) read out, the blocks linking to it and its open remarks; read again from its file when that changed. */
      get: (a: T.PkmPageRef, options?: { signal?: AbortSignal }): Promise<T.PkmPageView> =>
        this.call<T.PkmPageView>("pkm.page.get", "/api/v1/pkm/page/get", a, options),
      /** Makes the page, or sets the props and tier of the one with that title (its file moves to the tier's folder). */
      save: (a: T.PkmPageRequest, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
        this.call<T.PkmPage>("pkm.page.save", "/api/v1/pkm/page/save", a, options),
      move: (a: T.PkmMoveRequest, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
        this.call<T.PkmPage>("pkm.page.move", "/api/v1/pkm/page/move", a, options),
      rename: (a: T.PkmRenameRequest, options?: { signal?: AbortSignal }): Promise<T.PkmRename> =>
        this.call<T.PkmRename>("pkm.page.rename", "/api/v1/pkm/page/rename", a, options),
      /** The page as plain Markdown: refs read out, links and remarks taken off. */
      export: (a: T.PkmPageRef, options?: { signal?: AbortSignal }): Promise<T.PkmMarkdown> =>
        this.call<T.PkmMarkdown>("pkm.page.export", "/api/v1/pkm/page/export", a, options),
    },
    block: {
      /** The ops in order on the page as its file is now, written back once. */
      apply: (a: T.PkmMutation, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
        this.call<T.PkmPage>("pkm.block.apply", "/api/v1/pkm/block/apply", a, options),
    },
    source: {
      /** The page's file as written, ids and all, with when it was written. */
      get: (a: T.PkmPageRef, options?: { signal?: AbortSignal }): Promise<T.PkmSource> =>
        this.call<T.PkmSource>("pkm.source.get", "/api/v1/pkm/source/get", a, options),
      /** The page written anew from its file's text; refused when the file changed after it was read. */
      update: (a: T.PkmSourceUpdate, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
        this.call<T.PkmPage>("pkm.source.update", "/api/v1/pkm/source/update", a, options),
    },
    journal: {
      /** The journal of a day, made empty when it has none yet. */
      open: (a: T.PkmJournalRequest, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
        this.call<T.PkmPage>("pkm.journal.open", "/api/v1/pkm/journal/open", a, options),
    },
    radar: {
      get: (a: { staleDays?: number }, options?: { signal?: AbortSignal }): Promise<T.PkmRadar> =>
        this.call<T.PkmRadar>("pkm.radar.get", "/api/v1/pkm/radar/get", a, options),
    },
    comment: {
      list: (a: { page?: string }, options?: { signal?: AbortSignal }): Promise<T.PkmComment[]> =>
        this.call<T.PkmComment[]>("pkm.comment.list", "/api/v1/pkm/comment/list", a, options),
      /** A rewrite of a block for the user to accept: it keeps every [[link]] and ((ref)) the block had. */
      suggest: (a: T.PkmProposalRequest, options?: { signal?: AbortSignal }): Promise<T.PkmProposal> =>
        this.call<T.PkmProposal>("pkm.comment.suggest", "/api/v1/pkm/comment/suggest", a, options),
      /** Accepted, the suggested text replaces the block's and its remarks come off; rejected, the block stays. */
      resolve: (a: T.PkmResolveRequest, options?: { signal?: AbortSignal }): Promise<T.PkmPage> =>
        this.call<T.PkmPage>("pkm.comment.resolve", "/api/v1/pkm/comment/resolve", a, options),
    },
    clip: {
      create: (a: T.PkmClipRequest, options?: { signal?: AbortSignal }): Promise<T.PkmClip> =>
        this.call<T.PkmClip>("pkm.clip.create", "/api/v1/pkm/clip/create", a, options),
    },
    cluster: {
      /** A resource page of ((refs)) to the inbox, journal and resource blocks about the topic. */
      create: (a: T.PkmClusterRequest, options?: { signal?: AbortSignal }): Promise<T.PkmCluster> =>
        this.call<T.PkmCluster>("pkm.cluster.create", "/api/v1/pkm/cluster/create", a, options),
    },
  };

  readonly memory = {
    /** An agent's memories from the database and its configured sources. */
    list: (a: { agent: string }, options?: { signal?: AbortSignal }): Promise<T.MemoryList> =>
      this.call<T.MemoryList>("memory.list", "/api/v1/memory/list", a, options),
    /** What the agent would recall for this repo and input. */
    recall: (a: { agent: string; repo?: string; text?: string }, options?: { signal?: AbortSignal }): Promise<T.RecallPreview> =>
      this.call<T.RecallPreview>("memory.recall", "/api/v1/memory/recall", a, options),
    create: (a: { agent: string } & T.MemoryRequest, options?: { signal?: AbortSignal }): Promise<T.Memory> =>
      this.call<T.Memory>("memory.create", "/api/v1/memory/create", a, options),
    /** Memories whose words match, from every source the agent has; none named is every profile's. */
    search: (a: { agent?: string; repo?: string; text?: string }, options?: { signal?: AbortSignal }): Promise<T.MemorySearch> =>
      this.call<T.MemorySearch>("memory.search", "/api/v1/memory/search", a, options),
    delete: (a: { agent: string; memory: string }, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("memory.delete", "/api/v1/memory/delete", a, options),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { agent: string; memory: string }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("memory.previewDelete", "/api/v1/memory/previewDelete", a, options),
  };

  readonly connector = {
    list: (options?: { signal?: AbortSignal }): Promise<T.ConnectorStatus[]> =>
      this.call<T.ConnectorStatus[]>("connector.list", "/api/v1/connector/list", undefined, options),
    login: (a: { id: T.ConnectorID } & T.ConnectorLogin, options?: { signal?: AbortSignal }): Promise<T.ConnectorStatus> =>
      this.call<T.ConnectorStatus>("connector.login", "/api/v1/connector/login", a, options),
    verify: (a: { id: T.ConnectorID } & T.VerifyRequest, options?: { signal?: AbortSignal }): Promise<T.ConnectorStatus> =>
      this.call<T.ConnectorStatus>("connector.verify", "/api/v1/connector/verify", a, options),
    logout: (a: { id: T.ConnectorID }, options?: { signal?: AbortSignal }): Promise<T.ConnectorStatus> =>
      this.call<T.ConnectorStatus>("connector.logout", "/api/v1/connector/logout", a, options),
    channel: {
      set: (a: { id: T.ConnectorID } & T.ConnectorsChannelRequest, options?: { signal?: AbortSignal }): Promise<T.ConnectorStatus> =>
        this.call<T.ConnectorStatus>("connector.channel.set", "/api/v1/connector/channel/set", a, options),
    },
  };

  readonly attachment = {
    /** Kept once by its bytes: the same file again is the same attachment. */
    create: (a: T.AttachmentUpload, options?: { signal?: AbortSignal }): Promise<T.Attachment> =>
      this.call<T.Attachment>("attachment.create", "/api/v1/attachment/create", a, options),
  };

  private decodeEnvelope(path: string, raw: unknown, text?: string): unknown {
    const entry = resultDecoders.get(path);
    const checked = entry ? entry.envelope.safeParse(raw) : undefined;
    if (checked && !checked.success) {
      const env = decodeApiError(raw);
      if (env) {
        const meta = bizCodeMeta[env.bizCode];
        throw new VibeValleyApiError(meta.status, meta.kind, env.message, env.error, text, env.bizCode);
      }
      if (text === undefined && isObject(raw) && typeof raw.bizCode === "number" && raw.bizCode !== 0) {
        const reason = typeof raw.message === "string" && raw.message !== "" ? raw.message : t("shared.serverAnswered", { status: 500 });
        throw new VibeValleyApiError(500, undefined, reason);
      }
      throw new Error(`${path}: a response not in its shape: ${checked.error.message}`);
    }
    return checked && entry?.hasData === true && isObject(checked.data) ? checked.data.data : undefined;
  }

  /** R is the answer api.ts gives the path; each method above names it. */
  private async call<R>(op: string, path: string, input: unknown, options?: { signal?: AbortSignal }): Promise<R> {
    let value: unknown;
    if (this.caller !== undefined) {
      const signal = options?.signal;
      if (signal?.aborted === true) throw abortError(signal);
      const pending = this.caller(op, input, options);
      const raw =
        signal === undefined
          ? await pending
          : await new Promise<unknown>((resolve, reject) => {
              const onAbort = () => reject(abortError(signal));
              signal.addEventListener("abort", onAbort, { once: true });
              pending.then(
                (v) => {
                  signal.removeEventListener("abort", onAbort);
                  resolve(v);
                },
                (e: unknown) => {
                  signal.removeEventListener("abort", onAbort);
                  reject(e);
                },
              );
            });
      value = this.decodeEnvelope(path, raw);
    } else {
      const headers: Record<string, string> = this.key === undefined ? {} : { authorization: "Bearer " + this.key };
      const res = await this.fetcher(this.base + path, {
        ...(input === undefined
          ? { method: "POST", headers }
          : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(input) }),
        ...options,
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed: unknown;
        try {
          parsed = text === "" ? undefined : JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        const env = decodeApiError(parsed);
        if (env) {
          const meta = bizCodeMeta[env.bizCode];
          throw new VibeValleyApiError(res.status, meta.kind, env.message, env.error, text, env.bizCode);
        }
        const j = isObject(parsed) ? parsed : {};
        const reason = typeof j.message === "string" && j.message !== "" ? j.message : text.trim() || t("shared.serverAnswered", { status: res.status });
        throw new VibeValleyApiError(res.status, undefined, reason, undefined, text);
      }
      const raw: unknown = text === "" ? undefined : JSON.parse(text);
      value = this.decodeEnvelope(path, raw, text);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above with the endpoint's own result Schema from api.ts
    return value as R;
  }
}
