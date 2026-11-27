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
let resultDecoders: Map<string, { readonly hasData: boolean; readonly envelope: z.ZodType }> | undefined;
const decoderFor = (path: string) => {
  if (resultDecoders === undefined) {
    resultDecoders = new Map();
    for (const e of endpoints) {
      resultDecoders.set(pathOf(e.op), { hasData: e.result !== undefined, envelope: e.result ? apiSuccessEnvelope(e.result) : ApiVoidEnvelope });
    }
  }
  return resultDecoders.get(path);
};

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

  readonly debug = {
    snapshot: (options?: { signal?: AbortSignal }): Promise<T.DebugSnapshot> =>
      this.call<T.DebugSnapshot>("debug.snapshot", "/api/v1/debug/snapshot", undefined, options),
    timeline: {
      list: (a: T.DebugTimelineQuery, options?: { signal?: AbortSignal }): Promise<T.DebugTimelinePage> =>
        this.call<T.DebugTimelinePage>("debug.timeline.list", "/api/v1/debug/timeline/list", a, options),
      clear: (options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("debug.timeline.clear", "/api/v1/debug/timeline/clear", undefined, options),
    },
    trajectory: {
      list: (options?: { signal?: AbortSignal }): Promise<T.DebugTrajectorySummary[]> =>
        this.call<T.DebugTrajectorySummary[]>("debug.trajectory.list", "/api/v1/debug/trajectory/list", undefined, options),
      get: (a: T.DebugTrajectoryGetRequest, options?: { signal?: AbortSignal }): Promise<T.DebugTrajectoryDetail> =>
        this.call<T.DebugTrajectoryDetail>("debug.trajectory.get", "/api/v1/debug/trajectory/get", a, options),
      export: (a: T.DebugTrajectoryExportRequest, options?: { signal?: AbortSignal }): Promise<T.DebugTrajectoryExportResult> =>
        this.call<T.DebugTrajectoryExportResult>("debug.trajectory.export", "/api/v1/debug/trajectory/export", a, options),
    },
    override: {
      set: (a: T.DebugOverrideConfig, options?: { signal?: AbortSignal }): Promise<T.DebugOverrideConfig> =>
        this.call<T.DebugOverrideConfig>("debug.override.set", "/api/v1/debug/override/set", a, options),
    },
    bundle: {
      export: (options?: { signal?: AbortSignal }): Promise<T.DebugBundleResult> =>
        this.call<T.DebugBundleResult>("debug.bundle.export", "/api/v1/debug/bundle/export", undefined, options),
    },
  };

  readonly remote = {
    status: (options?: { signal?: AbortSignal }): Promise<T.RemoteStatus> =>
      this.call<T.RemoteStatus>("remote.status", "/api/v1/remote/status", undefined, options),
    enable: (a: T.RemoteEnableRequest, options?: { signal?: AbortSignal }): Promise<T.RemoteStatus> =>
      this.call<T.RemoteStatus>("remote.enable", "/api/v1/remote/enable", a, options),
    disable: (options?: { signal?: AbortSignal }): Promise<T.RemoteStatus> =>
      this.call<T.RemoteStatus>("remote.disable", "/api/v1/remote/disable", undefined, options),
    whoami: (options?: { signal?: AbortSignal }): Promise<T.RemoteWhoami> =>
      this.call<T.RemoteWhoami>("remote.whoami", "/api/v1/remote/whoami", undefined, options),
    pair: {
      create: (options?: { signal?: AbortSignal }): Promise<T.RemotePairCode> =>
        this.call<T.RemotePairCode>("remote.pair.create", "/api/v1/remote/pair/create", undefined, options),
      exchange: (a: T.RemotePairExchangeRequest, options?: { signal?: AbortSignal }): Promise<T.RemotePairExchangeResult> =>
        this.call<T.RemotePairExchangeResult>("remote.pair.exchange", "/api/v1/remote/pair/exchange", a, options),
    },
    device: {
      revoke: (a: T.RemoteDeviceRevokeRequest, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("remote.device.revoke", "/api/v1/remote/device/revoke", a, options),
    },
  };

  readonly machine = {
    list: (options?: { signal?: AbortSignal }): Promise<T.MachineInfo[]> =>
      this.call<T.MachineInfo[]>("machine.list", "/api/v1/machine/list", undefined, options),
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
    moss: {
      /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
      verify: (options?: { signal?: AbortSignal }): Promise<T.Validation> =>
        this.call<T.Validation>("voice.moss.verify", "/api/v1/voice/moss/verify", undefined, options),
    },
    grant: {
      create: (options?: { signal?: AbortSignal }): Promise<T.VoiceGrant> =>
        this.call<T.VoiceGrant>("voice.grant.create", "/api/v1/voice/grant/create", undefined, options),
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
    retro: {
      /** Deterministic issue cycle-time and retro analytics for a time window. */
      get: (a: T.IssueRetroGetInput, options?: { signal?: AbortSignal }): Promise<T.IssueRetroReport> =>
        this.call<T.IssueRetroReport>("issue.retro.get", "/api/v1/issue/retro/get", a, options),
    },
    digest: {
      /** Three-part morning digest combining overnight progress, repo health, and confirmable backlog triage. */
      get: (a: T.IssueDigestGetInput, options?: { signal?: AbortSignal }): Promise<T.MorningDigest> =>
        this.call<T.MorningDigest>("issue.digest.get", "/api/v1/issue/digest/get", a, options),
    },
    triage: {
      /** Pending backlog triage suggestions awaiting explicit user confirmation. */
      list: (options?: { signal?: AbortSignal }): Promise<T.BacklogTriageSuggestion[]> =>
        this.call<T.BacklogTriageSuggestion[]>("issue.triage.list", "/api/v1/issue/triage/list", undefined, options),
      /** Proposes a non-destructive triage suggestion for a backlog issue without overwriting its fields. */
      suggest: (a: T.BacklogTriageSuggestInput, options?: { signal?: AbortSignal }): Promise<T.BacklogTriageSuggestion> =>
        this.call<T.BacklogTriageSuggestion>("issue.triage.suggest", "/api/v1/issue/triage/suggest", a, options),
      /** Applies a pending backlog triage suggestion after explicit user click/confirmation. */
      confirm: (a: T.BacklogTriageConfirmInput, options?: { signal?: AbortSignal }): Promise<T.AppliedIssue> =>
        this.call<T.AppliedIssue>("issue.triage.confirm", "/api/v1/issue/triage/confirm", a, options),
      /** Dismisses a pending backlog triage suggestion without modifying the issue. */
      dismiss: (a: T.BacklogTriageDismissInput, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("issue.triage.dismiss", "/api/v1/issue/triage/dismiss", a, options),
    },
  };

  readonly session = {
    /** Stops a session's turn; it stays, and a comment starts the next. */
    stop: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("session.stop", "/api/v1/session/stop", a, options),
    list: (a: T.SessionListInput, options?: { signal?: AbortSignal }): Promise<T.Session[]> =>
      this.call<T.Session[]>("session.list", "/api/v1/session/list", a, options),
    get: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<T.Session> => this.call<T.Session>("session.get", "/api/v1/session/get", a, options),
    openWorkspace: (a: T.SessionOpenWorkspaceInput, options?: { signal?: AbortSignal }): Promise<T.SessionWorkspace> =>
      this.call<T.SessionWorkspace>("session.openWorkspace", "/api/v1/session/openWorkspace", a, options),
    /** Closes a direct workspace chat session, aborting any running turn without touching the project directory. */
    closeWorkspace: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("session.closeWorkspace", "/api/v1/session/closeWorkspace", a, options),
    /** Starts a turn when idle; steers the current turn when working. */
    send: (a: T.SessionSendInput, options?: { signal?: AbortSignal }): Promise<T.Session> =>
      this.call<T.Session>("session.send", "/api/v1/session/send", a, options),
    respondPermission: (a: T.SessionRespondPermissionInput, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("session.respondPermission", "/api/v1/session/respondPermission", a, options),
    respondInteraction: (a: T.SessionRespondInteractionInput, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("session.respondInteraction", "/api/v1/session/respondInteraction", a, options),
    setConfig: (a: T.SessionSetConfigInput, options?: { signal?: AbortSignal }): Promise<T.SessionWorkspace> =>
      this.call<T.SessionWorkspace>("session.setConfig", "/api/v1/session/setConfig", a, options),
    childTranscript: (a: T.SessionChildTranscriptInput, options?: { signal?: AbortSignal }): Promise<T.SessionChildTranscript> =>
      this.call<T.SessionChildTranscript>("session.childTranscript", "/api/v1/session/childTranscript", a, options),
    event: {
      /** Its log, oldest first. `run` narrows to one run; cursor fields page history. */
      list: (a: T.SessionEventListInput, options?: { signal?: AbortSignal }): Promise<T.SessionEventPage> =>
        this.call<T.SessionEventPage>("session.event.list", "/api/v1/session/event/list", a, options),
    },
  };

  readonly artifact = {
    /** The artifacts announced in a channel or made for an issue, newest change first; every one the workspace has when neither is given. */
    list: (a: T.ArtifactListRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact[]> =>
      this.call<T.Artifact[]>("artifact.list", "/api/v1/artifact/list", a, options),
    get: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
      this.call<T.Artifact>("artifact.get", "/api/v1/artifact/get", a, options),
    /** Creates a new directory-backed artifact seeded with starter files for its `artifactType`. */
    create: (a: T.ArtifactRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
      this.call<T.Artifact>("artifact.create", "/api/v1/artifact/create", a, options),
    /** Updates an artifact's title, linked issue, or default design-system flag. */
    update: (a: T.ArtifactUpdateRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
      this.call<T.Artifact>("artifact.update", "/api/v1/artifact/update", a, options),
    delete: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<void> =>
      this.call<void>("artifact.delete", "/api/v1/artifact/delete", a, options),
    previewDelete: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.Preview> =>
      this.call<T.Preview>("artifact.previewDelete", "/api/v1/artifact/previewDelete", a, options),
    content: {
      /** Reads the artifact's primary entry file content (optionally at a historical immutable snapshot version). */
      get: (a: T.ArtifactReadRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactContent> =>
        this.call<T.ArtifactContent>("artifact.content.get", "/api/v1/artifact/content/get", a, options),
    },
    version: {
      /** Cuts a new immutable directory snapshot version over the latest state. */
      create: (a: T.ArtifactVersionRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.version.create", "/api/v1/artifact/version/create", a, options),
    },
    type: {
      /** All 12 artifact types and the workspace's standing default design-system if any. */
      list: (options?: { signal?: AbortSignal }): Promise<T.ArtifactTypeInfo[]> =>
        this.call<T.ArtifactTypeInfo[]>("artifact.type.list", "/api/v1/artifact/type/list", undefined, options),
      /** An artifact type's SKILL.md guide or one of its named reference chapters. */
      read: (a: T.ArtifactTypeReadRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactTypeGuide> =>
        this.call<T.ArtifactTypeGuide>("artifact.type.read", "/api/v1/artifact/type/read", a, options),
    },
    file: {
      /** Lists files (`manifest.json`, `structure/*`, `asset/*`) inside an artifact directory. */
      list: (a: T.ArtifactFileListRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactFileListResult> =>
        this.call<T.ArtifactFileListResult>("artifact.file.list", "/api/v1/artifact/file/list", a, options),
      /** Reads one file by relative path inside an artifact directory (or historical version snapshot). */
      get: (a: T.ArtifactFileGetRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactFileContent> =>
        this.call<T.ArtifactFileContent>("artifact.file.get", "/api/v1/artifact/file/get", a, options),
      /** Atomically writes one or more files into `structure/` or `asset/` with origin attribution and collab sync. */
      write: (a: T.ArtifactFileWriteRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactFileWriteResult> =>
        this.call<T.ArtifactFileWriteResult>("artifact.file.write", "/api/v1/artifact/file/write", a, options),
      /** Deletes a relative path under `structure/` or `asset/` with origin attribution and collab sync. */
      delete: (a: T.ArtifactFileDeleteRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactFileDeleteResult> =>
        this.call<T.ArtifactFileDeleteResult>("artifact.file.delete", "/api/v1/artifact/file/delete", a, options),
    },
    suggestion: {
      /** The open and resolved suggestions on an artifact, oldest first. */
      list: (a: { id: T.ArtifactId }, options?: { signal?: AbortSignal }): Promise<T.Suggestion[]> =>
        this.call<T.Suggestion[]>("artifact.suggestion.list", "/api/v1/artifact/suggestion/list", a, options),
      /** A proposed edit to a file or structured target inside an artifact directory. */
      create: (a: { id: T.ArtifactId } & T.SuggestionCreate, options?: { signal?: AbortSignal }): Promise<T.Suggestion> =>
        this.call<T.Suggestion>("artifact.suggestion.create", "/api/v1/artifact/suggestion/create", a, options),
      /** Accepts a pending suggestion and applies it to the artifact directory and collab state. */
      accept: (a: { id: T.ArtifactId; suggestion: T.SuggestionId }, options?: { signal?: AbortSignal }): Promise<T.Suggestion> =>
        this.call<T.Suggestion>("artifact.suggestion.accept", "/api/v1/artifact/suggestion/accept", a, options),
      reject: (a: { id: T.ArtifactId; suggestion: T.SuggestionId }, options?: { signal?: AbortSignal }): Promise<T.Suggestion> =>
        this.call<T.Suggestion>("artifact.suggestion.reject", "/api/v1/artifact/suggestion/reject", a, options),
    },
    presence: {
      /** Ephemeral live presence update (cursor, selection, highlight, viewport); never persisted to SQLite. */
      update: (a: T.ArtifactPresenceUpdateRequest, options?: { signal?: AbortSignal }): Promise<void> =>
        this.call<void>("artifact.presence.update", "/api/v1/artifact/presence/update", a, options),
    },
    history: {
      /** Newest first. */
      list: (a: T.ArtifactHistoryListRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactHistoryEntry[]> =>
        this.call<T.ArtifactHistoryEntry[]>("artifact.history.list", "/api/v1/artifact/history/list", a, options),
      /** Read-only snapshot projection at the requested Loro frontiers. */
      preview: (a: T.ArtifactHistoryPreviewRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactHistoryPreviewResult> =>
        this.call<T.ArtifactHistoryPreviewResult>("artifact.history.preview", "/api/v1/artifact/history/preview", a, options),
      /** Restore an artifact to the snapshot at the requested Loro frontiers as a new commit. */
      restore: (a: T.ArtifactHistoryRestoreRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.history.restore", "/api/v1/artifact/history/restore", a, options),
      /** Fork a new artifact starting from the snapshot at the requested Loro frontiers. */
      fork: (a: T.ArtifactHistoryForkRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.history.fork", "/api/v1/artifact/history/fork", a, options),
      /** Selectively undo commits matching one origin while preserving concurrent edits from other actors. */
      undoOrigin: (a: T.ArtifactHistoryUndoOriginRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.history.undoOrigin", "/api/v1/artifact/history/undoOrigin", a, options),
      /** Compact old operation history into a shallow snapshot while keeping current state intact. */
      compact: (a: T.ArtifactHistoryCompactRequest, options?: { signal?: AbortSignal }): Promise<T.Artifact> =>
        this.call<T.Artifact>("artifact.history.compact", "/api/v1/artifact/history/compact", a, options),
    },
    collab: {
      /** Export incremental Loro CRDT updates (or full snapshot) relative to a client VersionVector. */
      export: (a: T.ArtifactCollabExportRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactCollabExportResult> =>
        this.call<T.ArtifactCollabExportResult>("artifact.collab.export", "/api/v1/artifact/collab/export", a, options),
      /** Import incremental Loro CRDT updates (or snapshot) into an artifact and optionally return missing server updates. */
      import: (a: T.ArtifactCollabImportRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactCollabImportResult> =>
        this.call<T.ArtifactCollabImportResult>("artifact.collab.import", "/api/v1/artifact/collab/import", a, options),
    },
    cover: {
      /** Saves a derived auto-captured cover image outside the artifact directory and CRDT. */
      set: (a: T.ArtifactCoverSetRequest, options?: { signal?: AbortSignal }): Promise<T.ArtifactCover> =>
        this.call<T.ArtifactCover>("artifact.cover.set", "/api/v1/artifact/cover/set", a, options),
    },
  };

  readonly game = {
    shop: {
      list: (options?: { signal?: AbortSignal }): Promise<T.FarmShopView> =>
        this.call<T.FarmShopView>("game.shop.list", "/api/v1/game/shop/list", undefined, options),
      buy: (a: T.ShopPurchaseRequest, options?: { signal?: AbortSignal }): Promise<T.FarmShopView> =>
        this.call<T.FarmShopView>("game.shop.buy", "/api/v1/game/shop/buy", a, options),
    },
    daily: {
      list: (options?: { signal?: AbortSignal }): Promise<T.DailyTaskBoard> =>
        this.call<T.DailyTaskBoard>("game.daily.list", "/api/v1/game/daily/list", undefined, options),
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
    mcp: {
      list: (a: T.McpListInput, options?: { signal?: AbortSignal }): Promise<T.McpListResult> =>
        this.call<T.McpListResult>("runtime.mcp.list", "/api/v1/runtime/mcp/list", a, options),
      install: (a: T.McpInstallInput, options?: { signal?: AbortSignal }): Promise<T.McpHostInfo> =>
        this.call<T.McpHostInfo>("runtime.mcp.install", "/api/v1/runtime/mcp/install", a, options),
      uninstall: (a: T.McpUninstallInput, options?: { signal?: AbortSignal }): Promise<T.McpHostInfo> =>
        this.call<T.McpHostInfo>("runtime.mcp.uninstall", "/api/v1/runtime/mcp/uninstall", a, options),
    },
    mcpServer: {
      list: (a: T.McpServerListInput, options?: { signal?: AbortSignal }): Promise<T.McpServerListResult> =>
        this.call<T.McpServerListResult>("runtime.mcpServer.list", "/api/v1/runtime/mcpServer/list", a, options),
      save: (a: T.McpServerSaveInput, options?: { signal?: AbortSignal }): Promise<T.McpServerListResult> =>
        this.call<T.McpServerListResult>("runtime.mcpServer.save", "/api/v1/runtime/mcpServer/save", a, options),
      toggle: (a: T.McpServerToggleInput, options?: { signal?: AbortSignal }): Promise<T.McpServerListResult> =>
        this.call<T.McpServerListResult>("runtime.mcpServer.toggle", "/api/v1/runtime/mcpServer/toggle", a, options),
      remove: (a: T.McpServerRemoveInput, options?: { signal?: AbortSignal }): Promise<T.McpServerListResult> =>
        this.call<T.McpServerListResult>("runtime.mcpServer.remove", "/api/v1/runtime/mcpServer/remove", a, options),
    },
  };

  readonly repo = {
    list: (options?: { signal?: AbortSignal }): Promise<T.RepoSummary[]> => this.call<T.RepoSummary[]>("repo.list", "/api/v1/repo/list", undefined, options),
    /** The first thing Create would refuse in this repo, without making it. */
    validate: (a: T.NewRepo, options?: { signal?: AbortSignal }): Promise<T.Validation> =>
      this.call<T.Validation>("repo.validate", "/api/v1/repo/validate", a, options),
    create: (a: T.NewRepo, options?: { signal?: AbortSignal }): Promise<T.RepoSummary> =>
      this.call<T.RepoSummary>("repo.create", "/api/v1/repo/create", a, options),
    mount: (a: T.MountRepo, options?: { signal?: AbortSignal }): Promise<T.RepoSummary> =>
      this.call<T.RepoSummary>("repo.mount", "/api/v1/repo/mount", a, options),
    unmount: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("repo.unmount", "/api/v1/repo/unmount", a, options),
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
    },
  };

  readonly skill = {
    list: (options?: { signal?: AbortSignal }): Promise<T.Skill[]> => this.call<T.Skill[]>("skill.list", "/api/v1/skill/list", undefined, options),
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Skill, options?: { signal?: AbortSignal }): Promise<T.Skill> => this.call<T.Skill>("skill.create", "/api/v1/skill/create", a, options),
    update: (a: T.Skill, options?: { signal?: AbortSignal }): Promise<T.Skill> => this.call<T.Skill>("skill.update", "/api/v1/skill/update", a, options),
    delete: (a: { id: string }, options?: { signal?: AbortSignal }): Promise<void> => this.call<void>("skill.delete", "/api/v1/skill/delete", a, options),
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
    /** Local regular file imported directly into CAS without base64 framing (`Caller::User` only). */
    importPath: (a: T.AttachmentImportPathInput, options?: { signal?: AbortSignal }): Promise<T.Attachment> =>
      this.call<T.Attachment>("attachment.importPath", "/api/v1/attachment/importPath", a, options),
  };

  private decodeBridgeEnvelope(path: string, raw: unknown): unknown {
    if (isObject(raw) && raw.bizCode === 0) return raw.data;
    const env = decodeApiError(raw);
    if (env) {
      const meta = bizCodeMeta[env.bizCode];
      throw new VibeValleyApiError(meta.status, meta.kind, env.message, env.error, undefined, env.bizCode);
    }
    if (isObject(raw) && typeof raw.bizCode === "number" && raw.bizCode !== 0) {
      const reason = typeof raw.message === "string" && raw.message !== "" ? raw.message : t("shared.serverAnswered", { status: 500 });
      throw new VibeValleyApiError(500, undefined, reason);
    }
    throw new Error(`${path}: a response not in its shape`);
  }

  private decodeEnvelope(path: string, raw: unknown, text?: string): unknown {
    const entry = decoderFor(path);
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
      value = this.decodeBridgeEnvelope(path, raw);
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- HTTP responses are validated with api.ts schemas; in-process bridge responses come from the typed Rust server
    return value as R;
  }
}
