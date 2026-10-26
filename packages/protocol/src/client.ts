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

/** The server's HTTP API, one object per group: `api.issue.create({ body })`. */
export class VibeValleyApi {
  /** base: the server's address; empty is the page's own origin, which serves it. */
  constructor(
    readonly base = "",
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  readonly server = {
    health: (): Promise<T.Health> => this.call("GET", "/api/v1/health", undefined, undefined) as Promise<T.Health>,
  };

  readonly orchestrator = {
    open: (): Promise<void> => this.call("POST", "/api/v1/orchestrator/open", undefined, undefined) as Promise<void>,
    /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
    stop: (): Promise<void> => this.call("POST", "/api/v1/orchestrator/stop", undefined, undefined) as Promise<void>,
    /** The v1 caption relay without a call id is accepted only with one active call. */
    hear: (a: { body: T.SayRequest }): Promise<void> => this.call("POST", "/api/v1/orchestrator/hear", undefined, a.body) as Promise<void>,
    listArchive: (a: { q?: string }): Promise<T.ArchiveListing> =>
      this.call("GET", "/api/v1/orchestrator/archive", { q: a.q }, undefined) as Promise<T.ArchiveListing>,
    getArchive: (a: { name: string }): Promise<string> =>
      this.call("GET", "/api/v1/orchestrator/archive/" + encodeURIComponent(String(a.name)), undefined, undefined) as Promise<string>,
    /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
    markWrong: (a: { body: T.OrchestratorEvalRequest }): Promise<T.OrchestratorEval> =>
      this.call("POST", "/api/v1/orchestrator/evals", undefined, a.body) as Promise<T.OrchestratorEval>,
  };

  readonly setting = {
    load: (): Promise<T.SettingsStatus> => this.call("GET", "/api/v1/settings", undefined, undefined) as Promise<T.SettingsStatus>,
    /** The first thing Save would refuse in these settings, without saving them. */
    check: (a: { body: T.SettingsUpdate }): Promise<T.Check> => this.call("POST", "/api/v1/settings/check", undefined, a.body) as Promise<T.Check>,
    save: (a: { body: T.SettingsUpdate }): Promise<T.SettingsStatus> => this.call("PUT", "/api/v1/settings", undefined, a.body) as Promise<T.SettingsStatus>,
  };

  readonly channel = {
    say: (a: { body: T.SayRequest }): Promise<void> => this.call("POST", "/api/v1/say", undefined, a.body) as Promise<void>,
    create: (a: { body: T.ChannelRequest }): Promise<string> => this.call("POST", "/api/v1/channels", undefined, a.body) as Promise<string>,
    update: (a: { id: string; body: T.ChannelUpdate }): Promise<void> =>
      this.call("PUT", "/api/v1/channels/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<void>,
    history: (a: { id: string; before?: number; limit?: number }): Promise<T.ChatMessage[]> =>
      this.call("GET", "/api/v1/channels/" + encodeURIComponent(String(a.id)) + "/messages", { before: a.before, limit: a.limit }, undefined) as Promise<
        T.ChatMessage[]
      >,
    markRead: (a: { id: string; body: T.ChatReadRequest }): Promise<void> =>
      this.call("POST", "/api/v1/channels/" + encodeURIComponent(String(a.id)) + "/read", undefined, a.body) as Promise<void>,
  };

  readonly recurrence = {
    create: (a: { body: T.RecurrenceRequest }): Promise<T.Recurrence> => this.call("POST", "/api/v1/recurrences", undefined, a.body) as Promise<T.Recurrence>,
    list: (): Promise<T.Recurrence[]> => this.call("GET", "/api/v1/recurrences", undefined, undefined) as Promise<T.Recurrence[]>,
    /** Only what the body gives changes. */
    update: (a: { id: string; body: T.RecurrenceUpdate }): Promise<void> =>
      this.call("PUT", "/api/v1/recurrences/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<void>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/recurrences/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/recurrences/" + encodeURIComponent(String(a.id)) + "/delete/preview", undefined, undefined) as Promise<T.Preview>,
  };

  readonly issue = {
    /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
    comment: (a: { id: string; body: T.CommentRequest }): Promise<void> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/comment", undefined, a.body) as Promise<void>,
    changes: (a: { id: string }): Promise<T.Changes> =>
      this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/changes", undefined, undefined) as Promise<T.Changes>,
    /** One joined read of issues and their real sessions, including explicit missing records. */
    history: (): Promise<T.IssueHistory[]> => this.call("GET", "/api/v1/issues/history", undefined, undefined) as Promise<T.IssueHistory[]>,
    list: (): Promise<T.Issue[]> => this.call("GET", "/api/v1/issues", undefined, undefined) as Promise<T.Issue[]>,
    get: (a: { id: string }): Promise<T.Issue> =>
      this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<T.Issue>,
    runs: (a: { id: string }): Promise<T.Run[]> =>
      this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/runs", undefined, undefined) as Promise<T.Run[]>,
    /** The issue's milestones, newest first, and what all its runs cost. */
    timeline: (a: { id: string }): Promise<T.IssueTimeline> =>
      this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/timeline", undefined, undefined) as Promise<T.IssueTimeline>,
    create: (a: { body: T.IssueRequest }): Promise<T.Issue> => this.call("POST", "/api/v1/issues", undefined, a.body) as Promise<T.Issue>,
    update: (a: { id: string; body: T.IssueUpdate }): Promise<T.Issue> =>
      this.call("PUT", "/api/v1/issues/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<T.Issue>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/issues/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
    /** What issue.delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/delete/preview", undefined, undefined) as Promise<T.Preview>,
    move: (a: { id: string; body: T.MoveIssueRequest }): Promise<T.Issue[]> =>
      this.call("PUT", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/move", undefined, a.body) as Promise<T.Issue[]>,
    /** Moving an issue is what it does: todo sends it out (or waits for room), done merges, canceled sends its session home,
     * todo again after a round or a close is another round with text. Issue.moves lists where it may go. */
    status: (a: { id: string; body: T.IssueStatusRequest }): Promise<T.Issue> =>
      this.call("PUT", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/status", undefined, a.body) as Promise<T.Issue>,
    /** What issue.status would do with the same body, refused as it would be; nothing changes. */
    previewStatus: (a: { id: string; body: T.IssueStatusRequest }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/status/preview", undefined, a.body) as Promise<T.Preview>,
    /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
     * leaves; with questions open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
    refine: (a: { id: string; body: T.IssueRefineRequest }): Promise<T.Issue> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/refine", undefined, a.body) as Promise<T.Issue>,
    /** Starts a queued todo now, if its project and the farm have room; otherwise it keeps its place in the queue. */
    dispatch: (a: { id: string; body: T.IssueDispatchRequest }): Promise<T.Dispatched> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/dispatch", undefined, a.body) as Promise<T.Dispatched>,
    /** One of what the issue's attention offers the owner, done as the issue's page does it; any other is refused. */
    act: (a: { id: string; body: T.IssueActRequest }): Promise<T.Issue> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/act", undefined, a.body) as Promise<T.Issue>,
    /** What issue.act would do with the same body, refused as it would be; nothing changes. */
    previewAct: (a: { id: string; body: T.IssueActRequest }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/act/preview", undefined, a.body) as Promise<T.Preview>,
  };

  readonly session = {
    /** Stops a session's turn; it stays, and a comment starts the next. */
    stop: (a: { id: string }): Promise<void> =>
      this.call("POST", "/api/v1/sessions/" + encodeURIComponent(String(a.id)) + "/stop", undefined, undefined) as Promise<void>,
    list: (a: { agent?: string }): Promise<T.Session[]> => this.call("GET", "/api/v1/sessions", { agent: a.agent }, undefined) as Promise<T.Session[]>,
    get: (a: { id: string }): Promise<T.Session> =>
      this.call("GET", "/api/v1/sessions/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<T.Session>,
    /** Its log, oldest first; run gives one run's only. The orchestrator's log is session orchestrator's. */
    events: (a: { id: string; run?: string }): Promise<T.SessionEvent[]> =>
      this.call("GET", "/api/v1/sessions/" + encodeURIComponent(String(a.id)) + "/events", { run: a.run }, undefined) as Promise<T.SessionEvent[]>,
  };

  readonly graph = {
    split: (a: { body: T.GraphSplitRequest }): Promise<string> => this.call("POST", "/api/v1/graphs", undefined, a.body) as Promise<string>,
    updateTask: (a: { id: string; task: string; body: T.TaskEdit }): Promise<string> =>
      this.call(
        "PUT",
        "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/tasks/" + encodeURIComponent(String(a.task)),
        undefined,
        a.body,
      ) as Promise<string>,
    deleteTask: (a: { id: string; task: string }): Promise<string> =>
      this.call(
        "DELETE",
        "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/tasks/" + encodeURIComponent(String(a.task)),
        undefined,
        undefined,
      ) as Promise<string>,
    /** What deleteTask would do, refused as it would be; nothing changes. */
    previewDeleteTask: (a: { id: string; task: string }): Promise<T.Preview> =>
      this.call(
        "POST",
        "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/tasks/" + encodeURIComponent(String(a.task)) + "/delete/preview",
        undefined,
        undefined,
      ) as Promise<T.Preview>,
    act: (a: { id: string; body: T.GraphActRequest }): Promise<string> =>
      this.call("POST", "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/act", undefined, a.body) as Promise<string>,
    taskAct: (a: { id: string; task: string; body: T.TaskActRequest }): Promise<string> =>
      this.call(
        "POST",
        "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/tasks/" + encodeURIComponent(String(a.task)) + "/act",
        undefined,
        a.body,
      ) as Promise<string>,
    changes: (a: { id: string }): Promise<T.Changes> =>
      this.call("GET", "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/changes", undefined, undefined) as Promise<T.Changes>,
    events: (a: { id: string }): Promise<T.GraphEvent[]> =>
      this.call("GET", "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/events", undefined, undefined) as Promise<T.GraphEvent[]>,
  };

  readonly game = {
    achievements: (): Promise<T.Achievement[]> => this.call("GET", "/api/v1/game/achievements", undefined, undefined) as Promise<T.Achievement[]>,
    chooseTitle: (a: { body: T.ChooseTitleRequest }): Promise<void> => this.call("POST", "/api/v1/game/title", undefined, a.body) as Promise<void>,
  };

  readonly runtime = {
    list: (): Promise<T.RuntimeInfo[]> => this.call("GET", "/api/v1/runtimes", undefined, undefined) as Promise<T.RuntimeInfo[]>,
    refresh: (a: { id: string }): Promise<T.RuntimeInfo> =>
      this.call("POST", "/api/v1/runtimes/" + encodeURIComponent(String(a.id)) + "/refresh", undefined, undefined) as Promise<T.RuntimeInfo>,
    update: (a: { id: string; body: T.RuntimeSettings }): Promise<T.RuntimeInfo> =>
      this.call("PUT", "/api/v1/runtimes/" + encodeURIComponent(String(a.id)) + "/settings", undefined, a.body) as Promise<T.RuntimeInfo>,
  };

  readonly github = {
    status: (): Promise<T.GitHubStatus> => this.call("GET", "/api/v1/github", undefined, undefined) as Promise<T.GitHubStatus>,
    refresh: (): Promise<T.GitHubStatus> => this.call("POST", "/api/v1/github/refresh", undefined, undefined) as Promise<T.GitHubStatus>,
  };

  readonly agent = {
    list: (): Promise<T.Agent[]> => this.call("GET", "/api/v1/agents", undefined, undefined) as Promise<T.Agent[]>,
    /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
    check: (a: { body: T.AgentCheckRequest }): Promise<T.AgentCheck[]> =>
      this.call("POST", "/api/v1/agents/check", undefined, a.body) as Promise<T.AgentCheck[]>,
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: { body: T.Agent }): Promise<T.Agent> => this.call("POST", "/api/v1/agents", undefined, a.body) as Promise<T.Agent>,
    save: (a: { id: string; body: T.Agent }): Promise<T.Agent> =>
      this.call("PUT", "/api/v1/agents/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<T.Agent>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/agents/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/agents/" + encodeURIComponent(String(a.id)) + "/delete/preview", undefined, undefined) as Promise<T.Preview>,
  };

  readonly memory = {
    /** An agent's memories: the orchestrator's (agent orchestrator) are the lines of its MEMORY.md, with the file and how many of the newest
     * its prompt carries; every other agent's are rows. */
    list: (a: { agent: string }): Promise<T.MemoryList> =>
      this.call("GET", "/api/v1/memories/" + encodeURIComponent(String(a.agent)), undefined, undefined) as Promise<T.MemoryList>,
    /** What the agent would be reminded of on its next start; the orchestrator is not reminded, it carries its whole file. */
    recall: (a: { agent: string; project?: string; text?: string }): Promise<T.RecallPreview> =>
      this.call(
        "GET",
        "/api/v1/memories/" + encodeURIComponent(String(a.agent)) + "/recall",
        { project: a.project, text: a.text },
        undefined,
      ) as Promise<T.RecallPreview>,
    create: (a: { agent: string; body: T.MemoryRequest }): Promise<T.Memory> =>
      this.call("POST", "/api/v1/memories/" + encodeURIComponent(String(a.agent)), undefined, a.body) as Promise<T.Memory>,
    delete: (a: { agent: string; memory: string }): Promise<void> =>
      this.call(
        "DELETE",
        "/api/v1/memories/" + encodeURIComponent(String(a.agent)) + "/" + encodeURIComponent(String(a.memory)),
        undefined,
        undefined,
      ) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { agent: string; memory: string }): Promise<T.Preview> =>
      this.call(
        "POST",
        "/api/v1/memories/" + encodeURIComponent(String(a.agent)) + "/" + encodeURIComponent(String(a.memory)) + "/delete/preview",
        undefined,
        undefined,
      ) as Promise<T.Preview>,
  };

  readonly skill = {
    list: (): Promise<T.Skill[]> => this.call("GET", "/api/v1/skills", undefined, undefined) as Promise<T.Skill[]>,
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: { body: T.Skill }): Promise<T.Skill> => this.call("POST", "/api/v1/skills", undefined, a.body) as Promise<T.Skill>,
    save: (a: { id: string; body: T.Skill }): Promise<T.Skill> =>
      this.call("PUT", "/api/v1/skills/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<T.Skill>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/skills/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
    /** What delete would do, refused as it would be; nothing changes. */
    previewDelete: (a: { id: string }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/skills/" + encodeURIComponent(String(a.id)) + "/delete/preview", undefined, undefined) as Promise<T.Preview>,
  };

  readonly project = {
    list: (): Promise<T.ProjectSummary[]> => this.call("GET", "/api/v1/projects", undefined, undefined) as Promise<T.ProjectSummary[]>,
    /** The first thing Create would refuse in this project, without making it. */
    check: (a: { body: T.NewProject }): Promise<T.Check> => this.call("POST", "/api/v1/projects/check", undefined, a.body) as Promise<T.Check>,
    create: (a: { body: T.NewProject }): Promise<T.ProjectSummary> => this.call("POST", "/api/v1/projects", undefined, a.body) as Promise<T.ProjectSummary>,
    languages: (a: { id: string }): Promise<T.ProjectLanguages> =>
      this.call("GET", "/api/v1/projects/" + encodeURIComponent(String(a.id)) + "/languages", undefined, undefined) as Promise<T.ProjectLanguages>,
    /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
    templates: (a: { id: string }): Promise<T.ProjectTemplates> =>
      this.call("GET", "/api/v1/projects/" + encodeURIComponent(String(a.id)) + "/templates", undefined, undefined) as Promise<T.ProjectTemplates>,
    activity: (a: { id: string }): Promise<T.ProjectActivity> =>
      this.call("GET", "/api/v1/projects/" + encodeURIComponent(String(a.id)) + "/activity", undefined, undefined) as Promise<T.ProjectActivity>,
  };

  readonly voice = {
    session: (): Promise<T.AgoraGrant> => this.call("POST", "/api/v1/voice/session", undefined, undefined) as Promise<T.AgoraGrant>,
    renew: (a: { body: T.RenewRequest }): Promise<T.AgoraGrant> => this.call("POST", "/api/v1/voice/renew", undefined, a.body) as Promise<T.AgoraGrant>,
    start: (a: { body: T.StartRequest }): Promise<T.VoiceAgent> => this.call("POST", "/api/v1/voice/agent", undefined, a.body) as Promise<T.VoiceAgent>,
    stop: (a: { body: T.VoiceAgent }): Promise<void> => this.call("POST", "/api/v1/voice/agent/stop", undefined, a.body) as Promise<void>,
    heard: (a: { body: T.VoiceHeard }): Promise<void> => this.call("POST", "/api/v1/voice/agent/heard", undefined, a.body) as Promise<void>,
    said: (a: { body: T.VoiceSaid }): Promise<void> => this.call("POST", "/api/v1/voice/agent/said", undefined, a.body) as Promise<void>,
    dictate: (a: { body: T.DictateRequest }): Promise<T.Dictated> => this.call("POST", "/api/v1/voice/dictate", undefined, a.body) as Promise<T.Dictated>,
  };

  readonly connector = {
    list: (): Promise<T.ConnectorStatus[]> => this.call("GET", "/api/v1/connectors", undefined, undefined) as Promise<T.ConnectorStatus[]>,
    login: (a: { id: T.ConnectorID; body: T.ConnectorLogin }): Promise<T.ConnectorStatus> =>
      this.call("POST", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/login", undefined, a.body) as Promise<T.ConnectorStatus>,
    verify: (a: { id: T.ConnectorID; body: T.VerifyRequest }): Promise<T.ConnectorStatus> =>
      this.call("POST", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/verify", undefined, a.body) as Promise<T.ConnectorStatus>,
    logout: (a: { id: T.ConnectorID }): Promise<T.ConnectorStatus> =>
      this.call("POST", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/logout", undefined, undefined) as Promise<T.ConnectorStatus>,
    channel: (a: { id: T.ConnectorID; body: T.ConnectorsChannelRequest }): Promise<T.ConnectorStatus> =>
      this.call("PUT", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/channel", undefined, a.body) as Promise<T.ConnectorStatus>,
  };

  readonly lan = {
    status: (): Promise<T.LanStatus> => this.call("GET", "/api/v1/lan", undefined, undefined) as Promise<T.LanStatus>,
    update: (a: { body: T.SetOpenRequest }): Promise<T.LanStatus> => this.call("PUT", "/api/v1/lan", undefined, a.body) as Promise<T.LanStatus>,
    startPairing: (): Promise<T.LanStatus> => this.call("POST", "/api/v1/lan/pairing", undefined, undefined) as Promise<T.LanStatus>,
    stopPairing: (): Promise<T.LanStatus> => this.call("DELETE", "/api/v1/lan/pairing", undefined, undefined) as Promise<T.LanStatus>,
    /** What stopPairing would do, refused as it would be; nothing changes. */
    previewStopPairing: (): Promise<T.Preview> => this.call("POST", "/api/v1/lan/pairing/stop/preview", undefined, undefined) as Promise<T.Preview>,
    answerPairing: (a: { body: T.AnswerPairingRequest }): Promise<T.LanStatus> =>
      this.call("POST", "/api/v1/lan/pairing/answer", undefined, a.body) as Promise<T.LanStatus>,
    deleteDevice: (a: { id: string }): Promise<T.LanStatus> =>
      this.call("DELETE", "/api/v1/lan/devices/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<T.LanStatus>,
    /** What deleteDevice would do, refused as it would be; nothing changes. */
    previewDeleteDevice: (a: { id: string }): Promise<T.Preview> =>
      this.call("POST", "/api/v1/lan/devices/" + encodeURIComponent(String(a.id)) + "/delete/preview", undefined, undefined) as Promise<T.Preview>,
    pair: (a: { body: T.LanPairRequest }): Promise<T.LanPaired> => this.call("POST", "/api/v1/lan/pair", undefined, a.body) as Promise<T.LanPaired>,
    me: (): Promise<T.LanDevice> => this.call("GET", "/api/v1/lan/me", undefined, undefined) as Promise<T.LanDevice>,
  };

  readonly doc = {
    /** The documents, the newest change first; their blocks are in doc.get. */
    list: (): Promise<T.Document[]> => this.call("GET", "/api/v1/docs", undefined, undefined) as Promise<T.Document[]>,
    create: (a: { body: T.DocRequest }): Promise<T.DocSnapshot> => this.call("POST", "/api/v1/docs", undefined, a.body) as Promise<T.DocSnapshot>,
    /** A new document from Markdown: the format documents trade with agents and MEMORY.md in, not how they are stored. */
    import: (a: { body: T.DocImport }): Promise<T.DocSnapshot> => this.call("POST", "/api/v1/docs/import", undefined, a.body) as Promise<T.DocSnapshot>,
    /** The document and every live block (no tombstones), in order. */
    get: (a: { id: string }): Promise<T.DocSnapshot> =>
      this.call("GET", "/api/v1/docs/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<T.DocSnapshot>,
    /** A batch of ops, as the owner: taken in order, in one transaction, one batch of a document at a time. */
    submit: (a: { id: string; body: T.DocSubmit }): Promise<T.DocAck> =>
      this.call("POST", "/api/v1/docs/" + encodeURIComponent(String(a.id)) + "/submit", undefined, a.body) as Promise<T.DocAck>,
    markdown: (a: { id: string }): Promise<T.DocMarkdown> =>
      this.call("GET", "/api/v1/docs/" + encodeURIComponent(String(a.id)) + "/markdown", undefined, undefined) as Promise<T.DocMarkdown>,
    /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
     * one already running is refused. */
    demo: (a: { id: string }): Promise<void> =>
      this.call("POST", "/api/v1/docs/" + encodeURIComponent(String(a.id)) + "/demo", undefined, undefined) as Promise<void>,
  };

  private async call(method: string, path: string, query: Record<string, string | number | boolean | undefined> | undefined, body: unknown): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
    const url = this.base + path + (params.size > 0 ? "?" + params.toString() : "");
    const res = await this.fetcher(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
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
