// Written by scripts/api-client.ts from api.ts (Handlers and endpoints); do not edit: vp run api:client.

import { Predicate } from "effect";

import { t } from "@vibevalley/i18n";

import type { ApiError } from "./api";
import { VoiceFixValues } from "./shapes";
import type * as T from "./shapes";

/** A refusal from the server: its tagged error (Refused, VoiceUnavailable…) and reason, or the bare status. */
// The client is Promise-based and its callers (the page, the shells) reject and catch plain Errors, not Effect failures.
// @effect-diagnostics-next-line extendsNativeError:off
export class VibeValleyApiError extends Error {
  readonly status: number;
  readonly tag: string | undefined;
  readonly reason: string;
  /** The error as the server wrote it, for what it carries besides the reason. */
  readonly error: ApiError | undefined;
  /** The response exactly as received, including plain text that was not JSON. */
  readonly body: string | undefined;

  constructor(status: number, tag: string | undefined, reason: string, error?: ApiError, body?: string) {
    super(reason);
    this.status = status;
    this.tag = tag;
    this.reason = reason;
    this.error = error;
    this.body = body;
  }
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const validNext = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => Predicate.isObject(item) && typeof item.say === "string" && (item.run === undefined || strings(item.run))));
const validReason = (value: unknown): boolean => Predicate.isObject(value) && typeof value.reason === "string";

// Kept free of Schema: the page does not load the endpoint Schemas just to read an error.
function apiErrorOf(value: unknown): ApiError | undefined {
  if (!Predicate.isObject(value) || typeof value._tag !== "string") return undefined;
  let valid: boolean;
  switch (value._tag) {
    case "Refused":
    case "ConnectorRefused":
    case "LanRefused":
      valid = validReason(value) && validNext(value.next);
      break;
    case "Missing":
      valid = typeof value.what === "string" && validNext(value.next);
      break;
    case "VoiceUnavailable":
      valid = validReason(value) && (value.settings === undefined || VoiceFixValues.some((fix) => fix === value.settings));
      break;
    case "VoiceCallFailed":
      valid = validReason(value);
      break;
    default:
      valid = false;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every field the page reads is checked above; it reads them, not the class's methods
  return valid ? (value as unknown as ApiError) : undefined;
}

/** The server's HTTP API, one object per module and noun, a method per op: `api.issue.status.update({ id, status })`. */
export class VibeValleyApi {
  /** The server's address; empty is the page's own origin, which serves it. */
  readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;

  constructor(base = "", fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {
    this.base = base;
    this.fetcher = fetcher;
  }

  readonly server = {
    health: {
      get: (): Promise<T.Health> => this.call<T.Health>("/api/v1/server/health/get", undefined),
    },
  };

  readonly orchestrator = {
    open: (): Promise<void> => this.call<void>("/api/v1/orchestrator/open", undefined),
    /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
    stop: (a: { agent?: string }): Promise<void> => this.call<void>("/api/v1/orchestrator/stop", a),
    archive: {
      list: (a: { agent?: string; q?: string }): Promise<T.ArchiveListing> => this.call<T.ArchiveListing>("/api/v1/orchestrator/archive/list", a),
      get: (a: { agent?: string; name: string }): Promise<string> => this.call<string>("/api/v1/orchestrator/archive/get", a),
    },
    eval: {
      /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
      create: (a: T.OrchestratorEvalRequest): Promise<T.OrchestratorEval> => this.call<T.OrchestratorEval>("/api/v1/orchestrator/eval/create", a),
    },
  };

  readonly setting = {
    get: (): Promise<T.SettingsStatus> => this.call<T.SettingsStatus>("/api/v1/setting/get", undefined),
    /** The first thing Save would refuse in these settings, without saving them. */
    validate: (a: T.SettingsUpdate): Promise<T.Validation> => this.call<T.Validation>("/api/v1/setting/validate", a),
    update: (a: T.SettingsUpdate): Promise<T.SettingsStatus> => this.call<T.SettingsStatus>("/api/v1/setting/update", a),
  };

  readonly channel = {
    create: (a: T.ChannelRequest): Promise<string> => this.call<string>("/api/v1/channel/create", a),
    update: (a: { id: string } & T.ChannelUpdate): Promise<void> => this.call<void>("/api/v1/channel/update", a),
    markRead: (a: { id: string } & T.ChatReadRequest): Promise<void> => this.call<void>("/api/v1/channel/markRead", a),
    /** A channel nothing points at any more, with its threads and messages. */
    delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/channel/delete", a),
    /** What channel.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/channel/previewDelete", a),
    /** The owner's read moved back to just before this message. */
    markUnread: (a: { id: string } & T.ChatReadRequest): Promise<void> => this.call<void>("/api/v1/channel/markUnread", a),
    /** Every channel and direct channel, the default first. */
    list: (): Promise<T.Channel[]> => this.call<T.Channel[]>("/api/v1/channel/list", undefined),
    message: {
      send: (a: T.SayRequest): Promise<void> => this.call<void>("/api/v1/channel/message/send", a),
      list: (a: { id: string; before?: number; limit?: number }): Promise<T.ChatMessage[]> => this.call<T.ChatMessage[]>("/api/v1/channel/message/list", a),
      /** The owner's own words, changed; nobody is told again. */
      update: (a: T.MessageEdit): Promise<T.ChatMessage> => this.call<T.ChatMessage>("/api/v1/channel/message/update", a),
      /** Any message: its words go, its number stays, and what it still had to hand is dropped. */
      delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/channel/message/delete", a),
      /** What channel.message.delete would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/channel/message/previewDelete", a),
      search: (a: T.MessageSearch): Promise<T.MessageHit[]> => this.call<T.MessageHit[]>("/api/v1/channel/message/search", a),
    },
    default: {
      /** The channel what names none goes to from now on: a connector's, a call's. */
      set: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/channel/default/set", a),
    },
    reaction: {
      /** The owner's reaction on or off; as it already is, nothing changes. */
      set: (a: T.ReactionSet): Promise<T.ChatMessage> => this.call<T.ChatMessage>("/api/v1/channel/reaction/set", a),
    },
    pin: {
      /** The message pinned or not; as it already is, nothing changes. */
      set: (a: T.OnSet): Promise<T.ChatMessage> => this.call<T.ChatMessage>("/api/v1/channel/pin/set", a),
      /** A channel's pinned messages, newest pinned first. */
      list: (a: { id: string }): Promise<T.ChatMessage[]> => this.call<T.ChatMessage[]>("/api/v1/channel/pin/list", a),
    },
    thread: {
      /** The thread under a message, made if it has none: its id. requestKey: as IssueRequest's. */
      create: (a: { id: string; requestKey?: string }): Promise<string> => this.call<string>("/api/v1/channel/thread/create", a),
    },
    archive: {
      /** Out of the sidebar and the thread lists (on), or back; its messages and address stay. The default channel stays. As
       * it already is, nothing changes. */
      set: (a: T.OnSet): Promise<void> => this.call<void>("/api/v1/channel/archive/set", a),
    },
    direct: {
      /** The owner's direct channel with a helper profile (or the orchestrator), made if there is none: its id. */
      create: (a: { agent: string }): Promise<string> => this.call<string>("/api/v1/channel/direct/create", a),
    },
    notify: {
      set: (a: T.NotifyRequest): Promise<void> => this.call<void>("/api/v1/channel/notify/set", a),
    },
    unread: {
      /** The places the caller has not read all of, the newest first. */
      list: (): Promise<T.ChannelUnread[]> => this.call<T.ChannelUnread[]>("/api/v1/channel/unread/list", undefined),
    },
    attachment: {
      create: (a: T.AttachmentUpload): Promise<T.Attachment> => this.call<T.Attachment>("/api/v1/channel/attachment/create", a),
    },
  };

  readonly cron = {
    create: (a: T.CronRequest): Promise<T.Cron> => this.call<T.Cron>("/api/v1/cron/create", a),
    list: (): Promise<T.Cron[]> => this.call<T.Cron[]>("/api/v1/cron/list", undefined),
    /** Only what the body gives changes. */
    update: (a: { id: string } & T.CronUpdate): Promise<void> => this.call<void>("/api/v1/cron/update", a),
    delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/cron/delete", a),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/cron/previewDelete", a),
  };

  readonly voice = {
    /** A line heard on the call that is on, without its id: refused unless one call is. */
    hear: (a: { text: string; agent?: string; sendKey?: string }): Promise<void> => this.call<void>("/api/v1/voice/hear", a),
    dictate: (a: T.DictateRequest): Promise<T.Dictated> => this.call<T.Dictated>("/api/v1/voice/dictate", a),
    moss: {
      /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
      verify: (a: T.MossVerifyRequest): Promise<T.Validation> => this.call<T.Validation>("/api/v1/voice/moss/verify", a),
    },
    grant: {
      create: (): Promise<T.AgoraGrant> => this.call<T.AgoraGrant>("/api/v1/voice/grant/create", undefined),
      renew: (a: T.VoiceGrantRenew): Promise<T.AgoraGrant> => this.call<T.AgoraGrant>("/api/v1/voice/grant/renew", a),
    },
    call: {
      start: (a: T.VoiceCallStart): Promise<T.VoiceCall> => this.call<T.VoiceCall>("/api/v1/voice/call/start", a),
      stop: (a: T.VoiceCall): Promise<void> => this.call<void>("/api/v1/voice/call/stop", a),
      hear: (a: T.VoiceHeard): Promise<void> => this.call<void>("/api/v1/voice/call/hear", a),
      say: (a: T.VoiceSaid): Promise<void> => this.call<void>("/api/v1/voice/call/say", a),
    },
  };

  readonly issue = {
    /** The open issues by default, the newest first; the filter narrows them. */
    list: (a: T.IssueFilter): Promise<T.Issue[]> => this.call<T.Issue[]>("/api/v1/issue/list", a),
    /** A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done. */
    review: (a: { id: string } & T.IssueReviewRequest): Promise<T.Issue> => this.call<T.Issue>("/api/v1/issue/review", a),
    /** The issue becomes a task graph's parent and its tasks the issues under it, started at once. */
    split: (a: { id: string } & T.IssueSplitRequest): Promise<string> => this.call<string>("/api/v1/issue/split", a),
    get: (a: { id: string }): Promise<T.Issue> => this.call<T.Issue>("/api/v1/issue/get", a),
    create: (a: T.IssueRequest): Promise<T.AppliedIssue> => this.call<T.AppliedIssue>("/api/v1/issue/create", a),
    update: (a: { id: string } & T.IssueUpdate): Promise<T.AppliedIssue> => this.call<T.AppliedIssue>("/api/v1/issue/update", a),
    delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/issue/delete", a),
    /** What issue.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/issue/previewDelete", a),
    /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
     * leaves; with questions open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
    refine: (a: { id: string } & T.IssueRefineRequest): Promise<T.Issue> => this.call<T.Issue>("/api/v1/issue/refine", a),
    comment: {
      /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
      create: (a: { id: string } & T.CommentRequest): Promise<T.Applied> => this.call<T.Applied>("/api/v1/issue/comment/create", a),
    },
    diff: {
      get: (a: { id: string }): Promise<T.Changes> => this.call<T.Changes>("/api/v1/issue/diff/get", a),
    },
    history: {
      /** One joined read of issues and their real sessions, including explicit missing records. */
      list: (): Promise<T.IssueHistory[]> => this.call<T.IssueHistory[]>("/api/v1/issue/history/list", undefined),
    },
    run: {
      list: (a: { id: string }): Promise<T.Run[]> => this.call<T.Run[]>("/api/v1/issue/run/list", a),
    },
    timeline: {
      /** The issue's milestones, newest first, and what all its runs cost. */
      get: (a: { id: string }): Promise<T.IssueTimeline> => this.call<T.IssueTimeline>("/api/v1/issue/timeline/get", a),
    },
    status: {
      /** Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is
       * another round (the words are the findings; stuck, none takes the server's own); done is accepted and delivered as the
       * issue says; canceled sends its session home. Issue.moves lists where it may go. */
      update: (a: { id: string } & T.IssueStatusRequest): Promise<T.AppliedIssue> => this.call<T.AppliedIssue>("/api/v1/issue/status/update", a),
      /** What issue.status.update would do with the same body, refused as it would be; nothing changes. */
      previewUpdate: (a: { id: string } & T.IssueStatusRequest): Promise<T.Preview> => this.call<T.Preview>("/api/v1/issue/status/previewUpdate", a),
    },
  };

  readonly session = {
    /** Stops a session's turn; it stays, and a comment starts the next. */
    stop: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/session/stop", a),
    list: (a: { agent?: string }): Promise<T.Session[]> => this.call<T.Session[]>("/api/v1/session/list", a),
    get: (a: { id: string }): Promise<T.Session> => this.call<T.Session>("/api/v1/session/get", a),
    event: {
      /** Its log, oldest first; run gives one run's only. The orchestrator's log is session orchestrator's. */
      list: (a: { id: string; run?: string }): Promise<T.SessionEvent[]> => this.call<T.SessionEvent[]>("/api/v1/session/event/list", a),
    },
  };

  readonly graph = {
    split: (a: T.GraphSplitRequest): Promise<string> => this.call<string>("/api/v1/graph/split", a),
    act: (a: { id: string } & T.GraphActRequest): Promise<string> => this.call<string>("/api/v1/graph/act", a),
    /** Every task graph, as the board has them. */
    list: (): Promise<T.TaskGraph[]> => this.call<T.TaskGraph[]>("/api/v1/graph/list", undefined),
    get: (a: { id: string }): Promise<T.TaskGraph> => this.call<T.TaskGraph>("/api/v1/graph/get", a),
    task: {
      update: (a: { id: string; task: string } & T.TaskEdit): Promise<string> => this.call<string>("/api/v1/graph/task/update", a),
      delete: (a: { id: string; task: string }): Promise<string> => this.call<string>("/api/v1/graph/task/delete", a),
      /** What deleteTask would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string; task: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/graph/task/previewDelete", a),
      act: (a: { id: string; task: string } & T.TaskActRequest): Promise<string> => this.call<string>("/api/v1/graph/task/act", a),
    },
    diff: {
      get: (a: { id: string }): Promise<T.Changes> => this.call<T.Changes>("/api/v1/graph/diff/get", a),
    },
    event: {
      list: (a: { id: string }): Promise<T.GraphEvent[]> => this.call<T.GraphEvent[]>("/api/v1/graph/event/list", a),
    },
  };

  readonly artifact = {
    /** The artifacts announced in a channel or made for an issue, newest change first; every one the farm has when neither is given. */
    list: (a: T.ArtifactListRequest): Promise<T.Artifact[]> => this.call<T.Artifact[]>("/api/v1/artifact/list", a),
    get: (a: { id: string }): Promise<T.Artifact> => this.call<T.Artifact>("/api/v1/artifact/get", a),
    /** Without content, an empty blocks one to write in; with content, a hand-in its maker announces with its card. */
    create: (a: T.ArtifactRequest): Promise<T.Artifact> => this.call<T.Artifact>("/api/v1/artifact/create", a),
    /** Its title, as the owner renames it. */
    update: (a: { id: string; title: string }): Promise<T.Artifact> => this.call<T.Artifact>("/api/v1/artifact/update", a),
    delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/artifact/delete", a),
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/artifact/previewDelete", a),
    /** A batch of ops, as the owner: taken in order, in one transaction, one batch at a time. */
    submit: (a: { id: string } & T.BlockSubmit): Promise<T.BlockAck> => this.call<T.BlockAck>("/api/v1/artifact/submit", a),
    /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
     * one already running is refused. */
    demo: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/artifact/demo", a),
    content: {
      /** Its words: an html one's version as made, a blocks one's Markdown now (its version is its seq). What an agent reads
       * to make the next one. */
      get: (a: T.ArtifactReadRequest): Promise<T.ArtifactContent> => this.call<T.ArtifactContent>("/api/v1/artifact/content/get", a),
    },
    version: {
      /** An html one's new version over the latest; the old ones stay. Announced like the first. A blocks one is changed
       * block by block instead. */
      create: (a: T.ArtifactVersionRequest): Promise<T.Artifact> => this.call<T.Artifact>("/api/v1/artifact/version/create", a),
    },
    block: {
      /** A blocks artifact and every live block (no tombstones), in order. */
      list: (a: { id: string }): Promise<T.BlockSnapshot> => this.call<T.BlockSnapshot>("/api/v1/artifact/block/list", a),
      /** One block appended, as one batch of one op. */
      create: (a: { id: string } & T.BlockCreate): Promise<T.BlockOpResult> => this.call<T.BlockOpResult>("/api/v1/artifact/block/create", a),
      update: (a: { id: string } & T.BlockUpdate): Promise<T.BlockOpResult> => this.call<T.BlockOpResult>("/api/v1/artifact/block/update", a),
    },
    markdown: {
      /** A blocks artifact as Markdown: the format artifacts trade with agents and MEMORY.md in, not how they are stored. */
      get: (a: { id: string }): Promise<T.ArtifactMarkdown> => this.call<T.ArtifactMarkdown>("/api/v1/artifact/markdown/get", a),
    },
  };

  readonly game = {
    achievement: {
      list: (): Promise<T.Achievement[]> => this.call<T.Achievement[]>("/api/v1/game/achievement/list", undefined),
    },
    title: {
      set: (a: T.ChooseTitleRequest): Promise<void> => this.call<void>("/api/v1/game/title/set", a),
    },
  };

  readonly runtime = {
    list: (): Promise<T.RuntimeInfo[]> => this.call<T.RuntimeInfo[]>("/api/v1/runtime/list", undefined),
    refresh: (a: { id: string }): Promise<T.RuntimeInfo> => this.call<T.RuntimeInfo>("/api/v1/runtime/refresh", a),
    setting: {
      update: (a: { id: string } & T.RuntimeSettings): Promise<T.RuntimeInfo> => this.call<T.RuntimeInfo>("/api/v1/runtime/setting/update", a),
    },
  };

  readonly github = {
    get: (): Promise<T.GitHubStatus> => this.call<T.GitHubStatus>("/api/v1/github/get", undefined),
    refresh: (): Promise<T.GitHubStatus> => this.call<T.GitHubStatus>("/api/v1/github/refresh", undefined),
  };

  readonly agent = {
    list: (): Promise<T.Agent[]> => this.call<T.Agent[]>("/api/v1/agent/list", undefined),
    /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
    validate: (a: T.AgentValidateRequest): Promise<T.AgentValidation[]> => this.call<T.AgentValidation[]>("/api/v1/agent/validate", a),
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Agent): Promise<T.Agent> => this.call<T.Agent>("/api/v1/agent/create", a),
    update: (a: T.Agent): Promise<T.Agent> => this.call<T.Agent>("/api/v1/agent/update", a),
    delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/agent/delete", a),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/agent/previewDelete", a),
    template: {
      /** The templates a profile can be installed from: the built-in ones, then those added on this machine. */
      list: (): Promise<T.AgentTemplate[]> => this.call<T.AgentTemplate[]>("/api/v1/agent/template/list", undefined),
      /** A new profile from a template; installing one again makes another. */
      install: (a: { id: string }): Promise<T.Agent> => this.call<T.Agent>("/api/v1/agent/template/install", a),
      /** A profile made again from its template's version now: what came from the template is replaced, what is the
       * machine's (environment, default project, on or off) stays. */
      update: (a: { agent: string }): Promise<T.Agent> => this.call<T.Agent>("/api/v1/agent/template/update", a),
      /** A template folder on this machine copied in beside the built-in ones; nothing is installed. */
      add: (a: { path: string }): Promise<T.AgentTemplate> => this.call<T.AgentTemplate>("/api/v1/agent/template/add", a),
      /** An added template gone; the profiles installed from it stay. */
      delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/agent/template/delete", a),
      /** What deleting the template would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/agent/template/previewDelete", a),
    },
  };

  readonly memory = {
    /** An agent's memories: an orchestrator's are the lines of its MEMORY.md, with the file and how many of the newest
     * its prompt carries; every other agent's are rows. */
    list: (a: { agent: string }): Promise<T.MemoryList> => this.call<T.MemoryList>("/api/v1/memory/list", a),
    /** What the agent would be reminded of on its next start; the orchestrator is not reminded, it carries its whole file. */
    recall: (a: { agent: string; project?: string; text?: string }): Promise<T.RecallPreview> => this.call<T.RecallPreview>("/api/v1/memory/recall", a),
    create: (a: { agent: string } & T.MemoryRequest): Promise<T.Memory> => this.call<T.Memory>("/api/v1/memory/create", a),
    /** Memories whose words match, from every source the agent has; none named is every profile's. */
    search: (a: { agent?: string; project?: string; text?: string }): Promise<T.MemorySearch> => this.call<T.MemorySearch>("/api/v1/memory/search", a),
    delete: (a: { agent: string; memory: string }): Promise<void> => this.call<void>("/api/v1/memory/delete", a),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { agent: string; memory: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/memory/previewDelete", a),
  };

  readonly skill = {
    list: (): Promise<T.Skill[]> => this.call<T.Skill[]>("/api/v1/skill/list", undefined),
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Skill): Promise<T.Skill> => this.call<T.Skill>("/api/v1/skill/create", a),
    update: (a: T.Skill): Promise<T.Skill> => this.call<T.Skill>("/api/v1/skill/update", a),
    delete: (a: { id: string }): Promise<void> => this.call<void>("/api/v1/skill/delete", a),
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/skill/previewDelete", a),
  };

  readonly project = {
    list: (): Promise<T.ProjectSummary[]> => this.call<T.ProjectSummary[]>("/api/v1/project/list", undefined),
    /** The first thing Create would refuse in this project, without making it. */
    validate: (a: T.NewProject): Promise<T.Validation> => this.call<T.Validation>("/api/v1/project/validate", a),
    create: (a: T.NewProject): Promise<T.ProjectSummary> => this.call<T.ProjectSummary>("/api/v1/project/create", a),
    language: {
      list: (a: { id: string }): Promise<T.ProjectLanguages> => this.call<T.ProjectLanguages>("/api/v1/project/language/list", a),
    },
    template: {
      /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
      list: (a: { id: string }): Promise<T.ProjectTemplates> => this.call<T.ProjectTemplates>("/api/v1/project/template/list", a),
    },
    activity: {
      get: (a: { id: string }): Promise<T.ProjectActivity> => this.call<T.ProjectActivity>("/api/v1/project/activity/get", a),
    },
  };

  readonly connector = {
    list: (): Promise<T.ConnectorStatus[]> => this.call<T.ConnectorStatus[]>("/api/v1/connector/list", undefined),
    login: (a: { id: T.ConnectorID } & T.ConnectorLogin): Promise<T.ConnectorStatus> => this.call<T.ConnectorStatus>("/api/v1/connector/login", a),
    verify: (a: { id: T.ConnectorID } & T.VerifyRequest): Promise<T.ConnectorStatus> => this.call<T.ConnectorStatus>("/api/v1/connector/verify", a),
    logout: (a: { id: T.ConnectorID }): Promise<T.ConnectorStatus> => this.call<T.ConnectorStatus>("/api/v1/connector/logout", a),
    channel: {
      set: (a: { id: T.ConnectorID } & T.ConnectorsChannelRequest): Promise<T.ConnectorStatus> =>
        this.call<T.ConnectorStatus>("/api/v1/connector/channel/set", a),
    },
  };

  readonly lan = {
    get: (): Promise<T.LanStatus> => this.call<T.LanStatus>("/api/v1/lan/get", undefined),
    update: (a: T.SetOpenRequest): Promise<T.LanStatus> => this.call<T.LanStatus>("/api/v1/lan/update", a),
    pair: (a: T.LanPairRequest): Promise<T.LanPaired> => this.call<T.LanPaired>("/api/v1/lan/pair", a),
    pairing: {
      start: (): Promise<T.LanStatus> => this.call<T.LanStatus>("/api/v1/lan/pairing/start", undefined),
      stop: (): Promise<T.LanStatus> => this.call<T.LanStatus>("/api/v1/lan/pairing/stop", undefined),
      /** What stopPairing would do, refused as it would be; nothing changes. */
      previewStop: (): Promise<T.Preview> => this.call<T.Preview>("/api/v1/lan/pairing/previewStop", undefined),
      answer: (a: T.AnswerPairingRequest): Promise<T.LanStatus> => this.call<T.LanStatus>("/api/v1/lan/pairing/answer", a),
    },
    device: {
      delete: (a: { id: string }): Promise<T.LanStatus> => this.call<T.LanStatus>("/api/v1/lan/device/delete", a),
      /** What deleteDevice would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }): Promise<T.Preview> => this.call<T.Preview>("/api/v1/lan/device/previewDelete", a),
    },
    me: {
      get: (): Promise<T.LanDevice> => this.call<T.LanDevice>("/api/v1/lan/me/get", undefined),
    },
  };

  /** R is the answer api.ts gives the path; each method above names it. */
  private async call<R>(path: string, input: unknown): Promise<R> {
    const res = await this.fetcher(
      this.base + path,
      input === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    );
    const text = await res.text();
    if (!res.ok) {
      let decoded: unknown;
      try {
        decoded = text === "" ? undefined : JSON.parse(text);
      } catch {
        decoded = undefined;
      }
      const error = apiErrorOf(decoded);
      const j = Predicate.isObject(decoded) ? decoded : {};
      const reason = error
        ? error._tag === "Missing"
          ? error.what
          : error.reason
        : typeof j.reason === "string"
          ? j.reason
          : typeof j.what === "string"
            ? j.what
            : text.trim() || t("shared.serverAnswered", { status: res.status });
      throw new VibeValleyApiError(res.status, typeof j._tag === "string" ? j._tag : undefined, reason, error, text);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the server answers each path with what api.ts says (its handlers are typed by the same Handlers); the page trusts its own server rather than load every Schema
    return (text === "" ? undefined : JSON.parse(text)) as R;
  }
}
