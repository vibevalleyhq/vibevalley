// Written by scripts/api-client.ts from api.ts (Handlers and endpoints); do not edit: vp run api:client.

import type { ApiError } from "./api";
import { VoiceFixValues } from "./shapes";
import type * as T from "./shapes";
import { t } from "@vibevalley/i18n";

/** A refusal from the server: its tagged error (Refused, VoiceUnavailable…) and reason, or the bare status. */
export class VibeValleyApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    readonly reason: string,
    /** The error as the server wrote it, for what it carries besides the reason. */
    readonly error?: ApiError,
    /** The response exactly as received, including plain text that was not JSON. */
    readonly body?: string,
  ) {
    super(reason);
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const validNext = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => record(item) && typeof item.say === "string" && (item.run === undefined || strings(item.run))));
const validReason = (value: unknown): boolean => record(value) && typeof value.reason === "string";

// Kept dependency-free: the page does not load the endpoint Schemas just to read an error.
function apiErrorOf(value: unknown): ApiError | undefined {
  if (!record(value) || typeof value._tag !== "string") return undefined;
  switch (value._tag) {
    case "Refused":
    case "ConnectorRefused":
    case "LanRefused":
      return validReason(value) && validNext(value.next) ? (value as unknown as ApiError) : undefined;
    case "Missing":
      return typeof value.what === "string" && validNext(value.next) ? (value as unknown as ApiError) : undefined;
    case "VoiceUnavailable":
      return validReason(value) && (value.settings === undefined || (VoiceFixValues as readonly unknown[]).includes(value.settings))
        ? (value as unknown as ApiError)
        : undefined;
    case "VoiceAgentFailed":
      return validReason(value) ? (value as unknown as ApiError) : undefined;
    default:
      return undefined;
  }
}

/** The server's HTTP API, one object per module and noun, a method per op: `api.issue.status.update({ id, status })`. */
export class VibeValleyApi {
  /** base: the server's address; empty is the page's own origin, which serves it. */
  constructor(
    readonly base = "",
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  readonly server = {
    health: {
      get: (): Promise<T.Health> => this.call("/api/v1/server/health/get", undefined) as Promise<T.Health>,
    },
  };

  readonly orchestrator = {
    open: (): Promise<void> => this.call("/api/v1/orchestrator/open", undefined) as Promise<void>,
    /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
    stop: (a: { agent?: string }): Promise<void> => this.call("/api/v1/orchestrator/stop", a) as Promise<void>,
    archive: {
      list: (a: { agent?: string; q?: string }): Promise<T.ArchiveListing> => this.call("/api/v1/orchestrator/archive/list", a) as Promise<T.ArchiveListing>,
      get: (a: { agent?: string; name: string }): Promise<string> => this.call("/api/v1/orchestrator/archive/get", a) as Promise<string>,
    },
    eval: {
      /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
      create: (a: T.OrchestratorEvalRequest): Promise<T.OrchestratorEval> => this.call("/api/v1/orchestrator/eval/create", a) as Promise<T.OrchestratorEval>,
    },
  };

  readonly setting = {
    get: (): Promise<T.SettingsStatus> => this.call("/api/v1/setting/get", undefined) as Promise<T.SettingsStatus>,
    /** The first thing Save would refuse in these settings, without saving them. */
    check: (a: T.SettingsUpdate): Promise<T.Check> => this.call("/api/v1/setting/check", a) as Promise<T.Check>,
    update: (a: T.SettingsUpdate): Promise<T.SettingsStatus> => this.call("/api/v1/setting/update", a) as Promise<T.SettingsStatus>,
  };

  readonly channel = {
    create: (a: T.ChannelRequest): Promise<string> => this.call("/api/v1/channel/create", a) as Promise<string>,
    update: (a: { id: string } & T.ChannelUpdate): Promise<void> => this.call("/api/v1/channel/update", a) as Promise<void>,
    markRead: (a: { id: string } & T.ChatReadRequest): Promise<void> => this.call("/api/v1/channel/markRead", a) as Promise<void>,
    /** A channel nothing points at any more, with its threads and messages. */
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/channel/delete", a) as Promise<void>,
    /** What channel.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/channel/previewDelete", a) as Promise<T.Preview>,
    /** The owner's read moved back to just before this message. */
    markUnread: (a: { id: string } & T.ChatReadRequest): Promise<void> => this.call("/api/v1/channel/markUnread", a) as Promise<void>,
    /** Every channel and direct channel, the default first. */
    list: (): Promise<T.Channel[]> => this.call("/api/v1/channel/list", undefined) as Promise<T.Channel[]>,
    message: {
      send: (a: T.SayRequest): Promise<void> => this.call("/api/v1/channel/message/send", a) as Promise<void>,
      list: (a: { id: string; before?: number; limit?: number }): Promise<T.ChatMessage[]> =>
        this.call("/api/v1/channel/message/list", a) as Promise<T.ChatMessage[]>,
      /** The owner's own words, changed; nobody is told again. */
      update: (a: T.MessageEdit): Promise<T.ChatMessage> => this.call("/api/v1/channel/message/update", a) as Promise<T.ChatMessage>,
      /** Any message: its words go, its number stays, and what it still had to hand is dropped. */
      delete: (a: { id: string }): Promise<void> => this.call("/api/v1/channel/message/delete", a) as Promise<void>,
      /** What channel.message.delete would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/channel/message/previewDelete", a) as Promise<T.Preview>,
      search: (a: T.MessageSearch): Promise<T.MessageHit[]> => this.call("/api/v1/channel/message/search", a) as Promise<T.MessageHit[]>,
    },
    default: {
      /** The channel what names none goes to from now on: a connector's, a call's. */
      set: (a: { id: string }): Promise<void> => this.call("/api/v1/channel/default/set", a) as Promise<void>,
    },
    reaction: {
      /** The owner's reaction added, or taken back when it is there. */
      toggle: (a: T.ReactionToggle): Promise<T.ChatMessage> => this.call("/api/v1/channel/reaction/toggle", a) as Promise<T.ChatMessage>,
    },
    pin: {
      toggle: (a: { id: string }): Promise<T.ChatMessage> => this.call("/api/v1/channel/pin/toggle", a) as Promise<T.ChatMessage>,
      /** A channel's pinned messages, newest pinned first. */
      list: (a: { id: string }): Promise<T.ChatMessage[]> => this.call("/api/v1/channel/pin/list", a) as Promise<T.ChatMessage[]>,
    },
    thread: {
      /** The thread under a message, made if it has none: its id. */
      create: (a: { id: string }): Promise<string> => this.call("/api/v1/channel/thread/create", a) as Promise<string>,
    },
    archive: {
      /** Out of the sidebar and the thread lists, or back; its messages and address stay. The default channel stays. */
      toggle: (a: { id: string }): Promise<void> => this.call("/api/v1/channel/archive/toggle", a) as Promise<void>,
    },
    direct: {
      /** The owner's direct channel with a helper profile (or the orchestrator), made if there is none: its id. */
      create: (a: { agent: string }): Promise<string> => this.call("/api/v1/channel/direct/create", a) as Promise<string>,
    },
    notify: {
      set: (a: T.NotifyRequest): Promise<void> => this.call("/api/v1/channel/notify/set", a) as Promise<void>,
    },
    unread: {
      /** The places the caller has not read all of, the newest first. */
      list: (): Promise<T.ChannelUnread[]> => this.call("/api/v1/channel/unread/list", undefined) as Promise<T.ChannelUnread[]>,
    },
    attachment: {
      create: (a: T.AttachmentUpload): Promise<T.Attachment> => this.call("/api/v1/channel/attachment/create", a) as Promise<T.Attachment>,
    },
  };

  readonly cron = {
    create: (a: T.CronRequest): Promise<T.Cron> => this.call("/api/v1/cron/create", a) as Promise<T.Cron>,
    list: (): Promise<T.Cron[]> => this.call("/api/v1/cron/list", undefined) as Promise<T.Cron[]>,
    /** Only what the body gives changes. */
    update: (a: { id: string } & T.CronUpdate): Promise<void> => this.call("/api/v1/cron/update", a) as Promise<void>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/cron/delete", a) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/cron/previewDelete", a) as Promise<T.Preview>,
  };

  readonly voice = {
    /** A line heard on the call that is on, without its id: refused unless one call is. */
    hear: (a: { text: string; agent?: string; sendKey?: string }): Promise<void> => this.call("/api/v1/voice/hear", a) as Promise<void>,
    dictate: (a: T.DictateRequest): Promise<T.Dictated> => this.call("/api/v1/voice/dictate", a) as Promise<T.Dictated>,
    moss: {
      /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
      check: (a: T.MossCheckRequest): Promise<T.Check> => this.call("/api/v1/voice/moss/check", a) as Promise<T.Check>,
    },
    session: {
      create: (): Promise<T.AgoraGrant> => this.call("/api/v1/voice/session/create", undefined) as Promise<T.AgoraGrant>,
      renew: (a: T.RenewRequest): Promise<T.AgoraGrant> => this.call("/api/v1/voice/session/renew", a) as Promise<T.AgoraGrant>,
    },
    agent: {
      start: (a: T.StartRequest): Promise<T.VoiceAgent> => this.call("/api/v1/voice/agent/start", a) as Promise<T.VoiceAgent>,
      stop: (a: T.VoiceAgent): Promise<void> => this.call("/api/v1/voice/agent/stop", a) as Promise<void>,
      hear: (a: T.VoiceHeard): Promise<void> => this.call("/api/v1/voice/agent/hear", a) as Promise<void>,
      say: (a: T.VoiceSaid): Promise<void> => this.call("/api/v1/voice/agent/say", a) as Promise<void>,
    },
  };

  readonly issue = {
    /** The open issues by default, the newest first; the filter narrows them. */
    list: (a: T.IssueFilter): Promise<T.Issue[]> => this.call("/api/v1/issue/list", a) as Promise<T.Issue[]>,
    /** A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done. */
    review: (a: { id: string } & T.IssueReviewRequest): Promise<T.Issue> => this.call("/api/v1/issue/review", a) as Promise<T.Issue>,
    /** The issue becomes a task graph's parent and its tasks the issues under it, started at once. */
    split: (a: { id: string } & T.IssueSplitRequest): Promise<string> => this.call("/api/v1/issue/split", a) as Promise<string>,
    get: (a: { id: string }): Promise<T.Issue> => this.call("/api/v1/issue/get", a) as Promise<T.Issue>,
    create: (a: T.IssueRequest): Promise<T.Issue> => this.call("/api/v1/issue/create", a) as Promise<T.Issue>,
    update: (a: { id: string } & T.IssueUpdate): Promise<T.Issue> => this.call("/api/v1/issue/update", a) as Promise<T.Issue>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/issue/delete", a) as Promise<void>,
    /** What issue.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/issue/previewDelete", a) as Promise<T.Preview>,
    /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
     * leaves; with questions open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
    refine: (a: { id: string } & T.IssueRefineRequest): Promise<T.Issue> => this.call("/api/v1/issue/refine", a) as Promise<T.Issue>,
    comment: {
      /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
      create: (a: { id: string } & T.CommentRequest): Promise<void> => this.call("/api/v1/issue/comment/create", a) as Promise<void>,
    },
    diff: {
      get: (a: { id: string }): Promise<T.Changes> => this.call("/api/v1/issue/diff/get", a) as Promise<T.Changes>,
    },
    history: {
      /** One joined read of issues and their real sessions, including explicit missing records. */
      list: (): Promise<T.IssueHistory[]> => this.call("/api/v1/issue/history/list", undefined) as Promise<T.IssueHistory[]>,
    },
    run: {
      list: (a: { id: string }): Promise<T.Run[]> => this.call("/api/v1/issue/run/list", a) as Promise<T.Run[]>,
    },
    timeline: {
      /** The issue's milestones, newest first, and what all its runs cost. */
      get: (a: { id: string }): Promise<T.IssueTimeline> => this.call("/api/v1/issue/timeline/get", a) as Promise<T.IssueTimeline>,
    },
    status: {
      /** Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is
       * another round (the words are the findings; stuck, none takes the server's own); done is accepted and delivered as the
       * issue says; canceled sends its session home. Issue.moves lists where it may go. */
      update: (a: { id: string } & T.IssueStatusRequest): Promise<T.Issue> => this.call("/api/v1/issue/status/update", a) as Promise<T.Issue>,
      /** What issue.status.update would do with the same body, refused as it would be; nothing changes. */
      previewUpdate: (a: { id: string } & T.IssueStatusRequest): Promise<T.Preview> => this.call("/api/v1/issue/status/previewUpdate", a) as Promise<T.Preview>,
    },
  };

  readonly session = {
    /** Stops a session's turn; it stays, and a comment starts the next. */
    stop: (a: { id: string }): Promise<void> => this.call("/api/v1/session/stop", a) as Promise<void>,
    list: (a: { agent?: string }): Promise<T.Session[]> => this.call("/api/v1/session/list", a) as Promise<T.Session[]>,
    get: (a: { id: string }): Promise<T.Session> => this.call("/api/v1/session/get", a) as Promise<T.Session>,
    event: {
      /** Its log, oldest first; run gives one run's only. The orchestrator's log is session orchestrator's. */
      list: (a: { id: string; run?: string }): Promise<T.SessionEvent[]> => this.call("/api/v1/session/event/list", a) as Promise<T.SessionEvent[]>,
    },
  };

  readonly graph = {
    split: (a: T.GraphSplitRequest): Promise<string> => this.call("/api/v1/graph/split", a) as Promise<string>,
    act: (a: { id: string } & T.GraphActRequest): Promise<string> => this.call("/api/v1/graph/act", a) as Promise<string>,
    /** Every task graph, as the board has them. */
    list: (): Promise<T.TaskGraph[]> => this.call("/api/v1/graph/list", undefined) as Promise<T.TaskGraph[]>,
    get: (a: { id: string }): Promise<T.TaskGraph> => this.call("/api/v1/graph/get", a) as Promise<T.TaskGraph>,
    task: {
      update: (a: { id: string; task: string } & T.TaskEdit): Promise<string> => this.call("/api/v1/graph/task/update", a) as Promise<string>,
      delete: (a: { id: string; task: string }): Promise<string> => this.call("/api/v1/graph/task/delete", a) as Promise<string>,
      /** What deleteTask would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string; task: string }): Promise<T.Preview> => this.call("/api/v1/graph/task/previewDelete", a) as Promise<T.Preview>,
      act: (a: { id: string; task: string } & T.TaskActRequest): Promise<string> => this.call("/api/v1/graph/task/act", a) as Promise<string>,
    },
    diff: {
      get: (a: { id: string }): Promise<T.Changes> => this.call("/api/v1/graph/diff/get", a) as Promise<T.Changes>,
    },
    event: {
      list: (a: { id: string }): Promise<T.GraphEvent[]> => this.call("/api/v1/graph/event/list", a) as Promise<T.GraphEvent[]>,
    },
  };

  readonly artifact = {
    /** The artifacts announced in a channel or made for an issue, newest change first; every one the farm has when neither is given. */
    list: (a: T.ArtifactListRequest): Promise<T.Artifact[]> => this.call("/api/v1/artifact/list", a) as Promise<T.Artifact[]>,
    get: (a: { id: string }): Promise<T.Artifact> => this.call("/api/v1/artifact/get", a) as Promise<T.Artifact>,
    /** Without content, an empty blocks one to write in; with content, a hand-in its maker announces with its card. */
    create: (a: T.ArtifactRequest): Promise<T.Artifact> => this.call("/api/v1/artifact/create", a) as Promise<T.Artifact>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/artifact/delete", a) as Promise<void>,
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/artifact/previewDelete", a) as Promise<T.Preview>,
    /** A batch of ops, as the owner: taken in order, in one transaction, one batch at a time. */
    submit: (a: { id: string } & T.BlockSubmit): Promise<T.BlockAck> => this.call("/api/v1/artifact/submit", a) as Promise<T.BlockAck>,
    /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
     * one already running is refused. */
    demo: (a: { id: string }): Promise<void> => this.call("/api/v1/artifact/demo", a) as Promise<void>,
    content: {
      /** Its words: an html one's version as made, a blocks one's Markdown now (its version is its seq). What an agent reads
       * to make the next one. */
      get: (a: T.ArtifactReadRequest): Promise<T.ArtifactContent> => this.call("/api/v1/artifact/content/get", a) as Promise<T.ArtifactContent>,
    },
    version: {
      /** An html one's new version over the latest; the old ones stay. Announced like the first. A blocks one is changed
       * block by block instead. */
      create: (a: T.ArtifactVersionRequest): Promise<T.Artifact> => this.call("/api/v1/artifact/version/create", a) as Promise<T.Artifact>,
    },
    blocks: {
      /** A blocks artifact and every live block (no tombstones), in order. */
      get: (a: { id: string }): Promise<T.BlockSnapshot> => this.call("/api/v1/artifact/blocks/get", a) as Promise<T.BlockSnapshot>,
    },
    block: {
      /** One block appended, as one batch of one op. */
      create: (a: { id: string } & T.BlockCreate): Promise<T.BlockOpResult> => this.call("/api/v1/artifact/block/create", a) as Promise<T.BlockOpResult>,
      update: (a: { id: string } & T.BlockUpdate): Promise<T.BlockOpResult> => this.call("/api/v1/artifact/block/update", a) as Promise<T.BlockOpResult>,
    },
    markdown: {
      /** A blocks artifact as Markdown: the format artifacts trade with agents and MEMORY.md in, not how they are stored. */
      get: (a: { id: string }): Promise<T.ArtifactMarkdown> => this.call("/api/v1/artifact/markdown/get", a) as Promise<T.ArtifactMarkdown>,
    },
  };

  readonly game = {
    achievement: {
      list: (): Promise<T.Achievement[]> => this.call("/api/v1/game/achievement/list", undefined) as Promise<T.Achievement[]>,
    },
    title: {
      set: (a: T.ChooseTitleRequest): Promise<void> => this.call("/api/v1/game/title/set", a) as Promise<void>,
    },
  };

  readonly runtime = {
    list: (): Promise<T.RuntimeInfo[]> => this.call("/api/v1/runtime/list", undefined) as Promise<T.RuntimeInfo[]>,
    refresh: (a: { id: string }): Promise<T.RuntimeInfo> => this.call("/api/v1/runtime/refresh", a) as Promise<T.RuntimeInfo>,
    setting: {
      update: (a: { id: string } & T.RuntimeSettings): Promise<T.RuntimeInfo> => this.call("/api/v1/runtime/setting/update", a) as Promise<T.RuntimeInfo>,
    },
  };

  readonly github = {
    get: (): Promise<T.GitHubStatus> => this.call("/api/v1/github/get", undefined) as Promise<T.GitHubStatus>,
    refresh: (): Promise<T.GitHubStatus> => this.call("/api/v1/github/refresh", undefined) as Promise<T.GitHubStatus>,
  };

  readonly agent = {
    list: (): Promise<T.Agent[]> => this.call("/api/v1/agent/list", undefined) as Promise<T.Agent[]>,
    /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
    check: (a: T.AgentCheckRequest): Promise<T.AgentCheck[]> => this.call("/api/v1/agent/check", a) as Promise<T.AgentCheck[]>,
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Agent): Promise<T.Agent> => this.call("/api/v1/agent/create", a) as Promise<T.Agent>,
    update: (a: T.Agent): Promise<T.Agent> => this.call("/api/v1/agent/update", a) as Promise<T.Agent>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/agent/delete", a) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/agent/previewDelete", a) as Promise<T.Preview>,
    template: {
      /** The templates a profile can be installed from: the built-in ones, then those added on this machine. */
      list: (): Promise<T.AgentTemplate[]> => this.call("/api/v1/agent/template/list", undefined) as Promise<T.AgentTemplate[]>,
      /** A new profile from a template; installing one again makes another. */
      install: (a: { id: string }): Promise<T.Agent> => this.call("/api/v1/agent/template/install", a) as Promise<T.Agent>,
      /** A profile made again from its template's version now: what came from the template is replaced, what is the
       * machine's (environment, default project, on or off) stays. */
      update: (a: { agent: string }): Promise<T.Agent> => this.call("/api/v1/agent/template/update", a) as Promise<T.Agent>,
      /** A template folder on this machine copied in beside the built-in ones; nothing is installed. */
      add: (a: { path: string }): Promise<T.AgentTemplate> => this.call("/api/v1/agent/template/add", a) as Promise<T.AgentTemplate>,
      /** An added template gone; the profiles installed from it stay. */
      delete: (a: { id: string }): Promise<void> => this.call("/api/v1/agent/template/delete", a) as Promise<void>,
      /** What deleting the template would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/agent/template/previewDelete", a) as Promise<T.Preview>,
    },
  };

  readonly memory = {
    /** An agent's memories: an orchestrator's are the lines of its MEMORY.md, with the file and how many of the newest
     * its prompt carries; every other agent's are rows. */
    list: (a: { agent: string }): Promise<T.MemoryList> => this.call("/api/v1/memory/list", a) as Promise<T.MemoryList>,
    /** What the agent would be reminded of on its next start; the orchestrator is not reminded, it carries its whole file. */
    recall: (a: { agent: string; project?: string; text?: string }): Promise<T.RecallPreview> =>
      this.call("/api/v1/memory/recall", a) as Promise<T.RecallPreview>,
    create: (a: { agent: string } & T.MemoryRequest): Promise<T.Memory> => this.call("/api/v1/memory/create", a) as Promise<T.Memory>,
    /** Memories whose words match, from every source the agent has; none named is every profile's. */
    search: (a: { agent?: string; project?: string; text?: string }): Promise<T.MemorySearch> =>
      this.call("/api/v1/memory/search", a) as Promise<T.MemorySearch>,
    delete: (a: { agent: string; memory: string }): Promise<void> => this.call("/api/v1/memory/delete", a) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { agent: string; memory: string }): Promise<T.Preview> => this.call("/api/v1/memory/previewDelete", a) as Promise<T.Preview>,
  };

  readonly skill = {
    list: (): Promise<T.Skill[]> => this.call("/api/v1/skill/list", undefined) as Promise<T.Skill[]>,
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: T.Skill): Promise<T.Skill> => this.call("/api/v1/skill/create", a) as Promise<T.Skill>,
    update: (a: T.Skill): Promise<T.Skill> => this.call("/api/v1/skill/update", a) as Promise<T.Skill>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/skill/delete", a) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/skill/previewDelete", a) as Promise<T.Preview>,
  };

  readonly project = {
    list: (): Promise<T.ProjectSummary[]> => this.call("/api/v1/project/list", undefined) as Promise<T.ProjectSummary[]>,
    /** The first thing Create would refuse in this project, without making it. */
    check: (a: T.NewProject): Promise<T.Check> => this.call("/api/v1/project/check", a) as Promise<T.Check>,
    create: (a: T.NewProject): Promise<T.ProjectSummary> => this.call("/api/v1/project/create", a) as Promise<T.ProjectSummary>,
    language: {
      list: (a: { id: string }): Promise<T.ProjectLanguages> => this.call("/api/v1/project/language/list", a) as Promise<T.ProjectLanguages>,
    },
    template: {
      /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
      list: (a: { id: string }): Promise<T.ProjectTemplates> => this.call("/api/v1/project/template/list", a) as Promise<T.ProjectTemplates>,
    },
    activity: {
      get: (a: { id: string }): Promise<T.ProjectActivity> => this.call("/api/v1/project/activity/get", a) as Promise<T.ProjectActivity>,
    },
  };

  readonly connector = {
    list: (): Promise<T.ConnectorStatus[]> => this.call("/api/v1/connector/list", undefined) as Promise<T.ConnectorStatus[]>,
    login: (a: { id: T.ConnectorID } & T.ConnectorLogin): Promise<T.ConnectorStatus> => this.call("/api/v1/connector/login", a) as Promise<T.ConnectorStatus>,
    verify: (a: { id: T.ConnectorID } & T.VerifyRequest): Promise<T.ConnectorStatus> => this.call("/api/v1/connector/verify", a) as Promise<T.ConnectorStatus>,
    logout: (a: { id: T.ConnectorID }): Promise<T.ConnectorStatus> => this.call("/api/v1/connector/logout", a) as Promise<T.ConnectorStatus>,
    channel: {
      set: (a: { id: T.ConnectorID } & T.ConnectorsChannelRequest): Promise<T.ConnectorStatus> =>
        this.call("/api/v1/connector/channel/set", a) as Promise<T.ConnectorStatus>,
    },
  };

  readonly lan = {
    get: (): Promise<T.LanStatus> => this.call("/api/v1/lan/get", undefined) as Promise<T.LanStatus>,
    update: (a: T.SetOpenRequest): Promise<T.LanStatus> => this.call("/api/v1/lan/update", a) as Promise<T.LanStatus>,
    pair: (a: T.LanPairRequest): Promise<T.LanPaired> => this.call("/api/v1/lan/pair", a) as Promise<T.LanPaired>,
    pairing: {
      start: (): Promise<T.LanStatus> => this.call("/api/v1/lan/pairing/start", undefined) as Promise<T.LanStatus>,
      stop: (): Promise<T.LanStatus> => this.call("/api/v1/lan/pairing/stop", undefined) as Promise<T.LanStatus>,
      /** What stopPairing would do, refused as it would be; nothing changes. */
      previewStop: (): Promise<T.Preview> => this.call("/api/v1/lan/pairing/previewStop", undefined) as Promise<T.Preview>,
      answer: (a: T.AnswerPairingRequest): Promise<T.LanStatus> => this.call("/api/v1/lan/pairing/answer", a) as Promise<T.LanStatus>,
    },
    device: {
      delete: (a: { id: string }): Promise<T.LanStatus> => this.call("/api/v1/lan/device/delete", a) as Promise<T.LanStatus>,
      /** What deleteDevice would do, refused as it would be; nothing changes. */
      previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/lan/device/previewDelete", a) as Promise<T.Preview>,
    },
    me: {
      get: (): Promise<T.LanDevice> => this.call("/api/v1/lan/me/get", undefined) as Promise<T.LanDevice>,
    },
  };

  private async call(path: string, input: unknown): Promise<unknown> {
    const res = await this.fetcher(this.base + path, {
      method: "POST",
      headers: input === undefined ? undefined : { "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const text = await res.text();
    if (!res.ok) {
      let decoded: unknown;
      try {
        decoded = text === "" ? undefined : JSON.parse(text);
      } catch {
        decoded = undefined;
      }
      const error = apiErrorOf(decoded);
      const j = record(decoded) ? decoded : {};
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
    return text === "" ? undefined : JSON.parse(text);
  }
}
