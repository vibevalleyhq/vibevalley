// Written by scripts/api-client.ts from api.ts (Handlers and endpoints); do not edit: vp run api:client.

import type { ApiError } from "./api";
import type * as T from "./shapes";
import { wording } from "./words";

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
      return validReason(value) && (value.settings === undefined || ["agora", "deepseek", "voice"].includes(value.settings as string))
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
    stop: (): Promise<void> => this.call("/api/v1/orchestrator/stop", undefined) as Promise<void>,
    archive: {
      list: (a: { q?: string }): Promise<T.ArchiveListing> => this.call("/api/v1/orchestrator/archive/list", a) as Promise<T.ArchiveListing>,
      get: (a: { name: string }): Promise<string> => this.call("/api/v1/orchestrator/archive/get", a) as Promise<string>,
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
    message: {
      send: (a: T.SayRequest): Promise<void> => this.call("/api/v1/channel/message/send", a) as Promise<void>,
      list: (a: { id: string; before?: number; limit?: number }): Promise<T.ChatMessage[]> =>
        this.call("/api/v1/channel/message/list", a) as Promise<T.ChatMessage[]>,
    },
  };

  readonly recurrence = {
    create: (a: T.RecurrenceRequest): Promise<T.Recurrence> => this.call("/api/v1/recurrence/create", a) as Promise<T.Recurrence>,
    list: (): Promise<T.Recurrence[]> => this.call("/api/v1/recurrence/list", undefined) as Promise<T.Recurrence[]>,
    /** Only what the body gives changes. */
    update: (a: { id: string } & T.RecurrenceUpdate): Promise<void> => this.call("/api/v1/recurrence/update", a) as Promise<void>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/recurrence/delete", a) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/recurrence/previewDelete", a) as Promise<T.Preview>,
  };

  readonly voice = {
    /** The v1 caption relay without a call id is accepted only with one active call. */
    hear: (a: T.SayRequest): Promise<void> => this.call("/api/v1/voice/hear", a) as Promise<void>,
    dictate: (a: T.DictateRequest): Promise<T.Dictated> => this.call("/api/v1/voice/dictate", a) as Promise<T.Dictated>,
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
    list: (): Promise<T.Issue[]> => this.call("/api/v1/issue/list", undefined) as Promise<T.Issue[]>,
    get: (a: { id: string }): Promise<T.Issue> => this.call("/api/v1/issue/get", a) as Promise<T.Issue>,
    create: (a: T.IssueRequest): Promise<T.Issue> => this.call("/api/v1/issue/create", a) as Promise<T.Issue>,
    update: (a: { id: string } & T.IssueUpdate): Promise<T.Issue> => this.call("/api/v1/issue/update", a) as Promise<T.Issue>,
    delete: (a: { id: string }): Promise<void> => this.call("/api/v1/issue/delete", a) as Promise<void>,
    /** What issue.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> => this.call("/api/v1/issue/previewDelete", a) as Promise<T.Preview>,
    move: (a: { id: string } & T.MoveIssueRequest): Promise<T.Issue[]> => this.call("/api/v1/issue/move", a) as Promise<T.Issue[]>,
    /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
     * leaves; with questions open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
    refine: (a: { id: string } & T.IssueRefineRequest): Promise<T.Issue> => this.call("/api/v1/issue/refine", a) as Promise<T.Issue>,
    /** Starts a queued todo now, if its project and the farm have room; otherwise it keeps its place in the queue. */
    dispatch: (a: { id: string } & T.IssueDispatchRequest): Promise<T.Dispatched> => this.call("/api/v1/issue/dispatch", a) as Promise<T.Dispatched>,
    /** One of what the issue's attention offers the owner, done as the issue's page does it; any other is refused. */
    act: (a: { id: string } & T.IssueActRequest): Promise<T.Issue> => this.call("/api/v1/issue/act", a) as Promise<T.Issue>,
    /** What issue.act would do with the same body, refused as it would be; nothing changes. */
    previewAct: (a: { id: string } & T.IssueActRequest): Promise<T.Preview> => this.call("/api/v1/issue/previewAct", a) as Promise<T.Preview>,
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
      /** Moving an issue is what it does: todo sends it out (or waits for room), done merges, canceled sends its session home,
       * todo again after a round or a close is another round with text. Issue.moves lists where it may go. */
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
  };

  readonly memory = {
    /** An agent's memories: the orchestrator's (agent orchestrator) are the lines of its MEMORY.md, with the file and how many of the newest
     * its prompt carries; every other agent's are rows. */
    list: (a: { agent: string }): Promise<T.MemoryList> => this.call("/api/v1/memory/list", a) as Promise<T.MemoryList>,
    /** What the agent would be reminded of on its next start; the orchestrator is not reminded, it carries its whole file. */
    recall: (a: { agent: string; project?: string; text?: string }): Promise<T.RecallPreview> =>
      this.call("/api/v1/memory/recall", a) as Promise<T.RecallPreview>,
    create: (a: { agent: string } & T.MemoryRequest): Promise<T.Memory> => this.call("/api/v1/memory/create", a) as Promise<T.Memory>,
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

  readonly doc = {
    /** The documents, the newest change first; their blocks are in doc.get. */
    list: (): Promise<T.Document[]> => this.call("/api/v1/doc/list", undefined) as Promise<T.Document[]>,
    create: (a: T.DocRequest): Promise<T.DocSnapshot> => this.call("/api/v1/doc/create", a) as Promise<T.DocSnapshot>,
    /** A new document from Markdown: the format documents trade with agents and MEMORY.md in, not how they are stored. */
    import: (a: T.DocImport): Promise<T.DocSnapshot> => this.call("/api/v1/doc/import", a) as Promise<T.DocSnapshot>,
    /** The document and every live block (no tombstones), in order. */
    get: (a: { id: string }): Promise<T.DocSnapshot> => this.call("/api/v1/doc/get", a) as Promise<T.DocSnapshot>,
    /** A batch of ops, as the owner: taken in order, in one transaction, one batch of a document at a time. */
    submit: (a: { id: string } & T.DocSubmit): Promise<T.DocAck> => this.call("/api/v1/doc/submit", a) as Promise<T.DocAck>,
    /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
     * one already running is refused. */
    demo: (a: { id: string }): Promise<void> => this.call("/api/v1/doc/demo", a) as Promise<void>,
    markdown: {
      get: (a: { id: string }): Promise<T.DocMarkdown> => this.call("/api/v1/doc/markdown/get", a) as Promise<T.DocMarkdown>,
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
            : text.trim() || wording().serverAnswered(res.status);
      throw new VibeValleyApiError(res.status, typeof j._tag === "string" ? j._tag : undefined, reason, error, text);
    }
    return text === "" ? undefined : JSON.parse(text);
  }
}
