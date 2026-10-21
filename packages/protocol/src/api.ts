// The farm's endpoints: each one's path, parameters, body, answer and who may call it. The server routes and the
// clients call by this list (apps/server/src/http/api.ts, VibeValleyApi).

import { type Effect, Schema } from "effect";
import type * as T from "./shapes";
import * as S from "./schema";

export type Caller = "owner" | "remote" | "manager" | "session";

export interface Refused {
  readonly _tag: "Refused";
  readonly reason: string;
}

export interface Missing {
  readonly _tag: "Missing";
  readonly what: string;
}

/** A 设置 section a voice problem is fixed in (the page's /settings/<section>). */
export type VoiceFix = "agora" | "deepseek" | "voice";

export interface VoiceUnavailable {
  readonly _tag: "VoiceUnavailable";
  readonly reason: string;
  /** Where in 设置 the owner fixes it, when a setting does. */
  readonly settings?: VoiceFix;
}

export interface VoiceAgentFailed {
  readonly _tag: "VoiceAgentFailed";
  readonly reason: string;
}

export interface ConnectorRefused {
  readonly _tag: "ConnectorRefused";
  readonly reason: string;
}

export interface LanRefused {
  readonly _tag: "LanRefused";
  readonly reason: string;
}

/** What a route may refuse with: written as JSON with its _tag, at its status. */
export type ApiError = Refused | Missing | VoiceUnavailable | VoiceAgentFailed | ConnectorRefused | LanRefused;

export const errorStatus: Readonly<Record<ApiError["_tag"], number>> = {
  Refused: 409,
  Missing: 404,
  VoiceUnavailable: 503,
  VoiceAgentFailed: 502,
  ConnectorRefused: 409,
  LanRefused: 403,
};

/** One answer per route: the server's Handlers. */
export interface Handlers<R = never> {
  readonly "server.health": () => Effect.Effect<T.Health, ApiError, R>;
  readonly "manager.open": () => Effect.Effect<void, ApiError, R>;
  /** Ends the manager's run under way and drops what waits for it; the sessions it sent keep working. */
  readonly "manager.stop": () => Effect.Effect<void, ApiError, R>;
  readonly "setting.load": () => Effect.Effect<T.SettingsStatus, ApiError, R>;
  /** The first thing Save would refuse in these settings, without saving them. */
  readonly "setting.check": (a: { readonly body: T.SettingsUpdate }) => Effect.Effect<T.SettingsCheck, ApiError, R>;
  readonly "setting.save": (a: { readonly body: T.SettingsUpdate }) => Effect.Effect<T.SettingsStatus, ApiError, R>;
  readonly "channel.say": (a: { readonly body: T.SayRequest }) => Effect.Effect<void, ApiError, R>;
  readonly "channel.create": (a: { readonly body: T.ChannelRequest }) => Effect.Effect<string, ApiError, R>;
  readonly "schedule.create": (a: { readonly body: T.ScheduleRequest }) => Effect.Effect<T.Schedule, ApiError, R>;
  readonly "schedule.list": () => Effect.Effect<T.Schedule[], ApiError, R>;
  /** Only what the body gives changes. */
  readonly "schedule.update": (a: { readonly id: string; readonly body: T.ScheduleUpdate }) => Effect.Effect<void, ApiError, R>;
  readonly "schedule.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  readonly "channel.update": (a: { readonly id: string; readonly body: T.ChannelUpdate }) => Effect.Effect<void, ApiError, R>;
  /** The v1 caption relay without a call id is accepted only with one active call. */
  readonly "manager.hear": (a: { readonly body: T.SayRequest }) => Effect.Effect<void, ApiError, R>;
  /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
  readonly "issue.comment": (a: { readonly id: string; readonly body: T.CommentRequest }) => Effect.Effect<void, ApiError, R>;
  readonly "issue.changes": (a: { readonly id: string }) => Effect.Effect<T.Changes, ApiError, R>;
  /** Tells the newest session to merge its base in and settle the conflicts, in the owner's words (ConflictTask). */
  readonly "issue.resolve": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** Stops a session's turn; it stays, and a comment starts the next. */
  readonly "session.stop": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  readonly "session.list": (a: { readonly agent?: string }) => Effect.Effect<T.Session[], ApiError, R>;
  readonly "session.get": (a: { readonly id: string }) => Effect.Effect<T.Session, ApiError, R>;
  /** Its log, oldest first; run gives one run's only. The manager's log is session manager's. */
  readonly "session.events": (a: { readonly id: string; readonly run?: string }) => Effect.Effect<T.SessionEvent[], ApiError, R>;
  /** One joined read of issues and their real sessions, including explicit missing records. */
  readonly "issue.history": () => Effect.Effect<T.IssueHistory[], ApiError, R>;
  readonly "issue.list": () => Effect.Effect<T.Issue[], ApiError, R>;
  readonly "issue.get": (a: { readonly id: string }) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.runs": (a: { readonly id: string }) => Effect.Effect<T.Run[], ApiError, R>;
  /** The issue's milestones, newest first, and what all its runs cost. */
  readonly "issue.timeline": (a: { readonly id: string }) => Effect.Effect<T.IssueTimeline, ApiError, R>;
  readonly "issue.create": (a: { readonly body: T.IssueRequest }) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.update": (a: { readonly id: string; readonly body: T.IssueUpdate }) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  readonly "issue.move": (a: { readonly id: string; readonly body: T.MoveIssueRequest }) => Effect.Effect<T.Issue[], ApiError, R>;
  /** Moving an issue is what it does: todo sends it out (or waits for room), done merges, canceled sends its session home,
   * todo again after a round or a close is another round with text. Issue.moves lists where it may go. */
  readonly "issue.status": (a: { readonly id: string; readonly body: T.IssueStatusRequest }) => Effect.Effect<T.Issue, ApiError, R>;
  /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
   * leaves; with asks open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
  readonly "issue.draft": (a: { readonly id: string; readonly body: T.IssueDraftRequest }) => Effect.Effect<T.Issue, ApiError, R>;
  /** Starts a queued todo now, if its project and the farm have room; otherwise it keeps its place in the queue. */
  readonly "issue.dispatch": (a: { readonly id: string; readonly body: T.IssueDispatchRequest }) => Effect.Effect<T.Dispatched, ApiError, R>;
  /** The acceptance of what was handed back (in review): a pass makes it ready to harvest, a fail adds weeds and sends
   * another round. */
  readonly "issue.accept": (a: { readonly id: string; readonly body: T.IssueAcceptRequest }) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "graph.split": (a: { readonly body: T.GraphSplitRequest }) => Effect.Effect<string, ApiError, R>;
  readonly "graph.updateTask": (a: { readonly id: string; readonly task: string; readonly body: T.TaskEdit }) => Effect.Effect<string, ApiError, R>;
  readonly "graph.deleteTask": (a: { readonly id: string; readonly task: string }) => Effect.Effect<string, ApiError, R>;
  readonly "graph.act": (a: { readonly id: string; readonly body: T.GraphActRequest }) => Effect.Effect<string, ApiError, R>;
  readonly "graph.taskAct": (a: { readonly id: string; readonly task: string; readonly body: T.TaskActRequest }) => Effect.Effect<string, ApiError, R>;
  readonly "channel.history": (a: { readonly id: string; readonly before?: number; readonly limit?: number }) => Effect.Effect<T.ChatMessage[], ApiError, R>;
  readonly "channel.markRead": (a: { readonly id: string; readonly body: T.ChatReadRequest }) => Effect.Effect<void, ApiError, R>;
  readonly "graph.changes": (a: { readonly id: string }) => Effect.Effect<T.Changes, ApiError, R>;
  readonly "graph.events": (a: { readonly id: string }) => Effect.Effect<T.GraphEvent[], ApiError, R>;
  readonly "game.achievements": () => Effect.Effect<T.Achievement[], ApiError, R>;
  readonly "game.chooseTitle": (a: { readonly body: T.ChooseTitleRequest }) => Effect.Effect<void, ApiError, R>;
  readonly "runtime.list": () => Effect.Effect<T.RuntimeInfo[], ApiError, R>;
  readonly "github.status": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "github.refresh": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "runtime.refresh": (a: { readonly id: string }) => Effect.Effect<T.RuntimeInfo, ApiError, R>;
  readonly "runtime.update": (a: { readonly id: string; readonly body: T.RuntimeSettings }) => Effect.Effect<T.RuntimeInfo, ApiError, R>;
  readonly "agent.list": () => Effect.Effect<T.Agent[], ApiError, R>;
  /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
  readonly "agent.check": (a: { readonly body: T.AgentCheckRequest }) => Effect.Effect<T.AgentCheck[], ApiError, R>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "agent.create": (a: { readonly body: T.Agent }) => Effect.Effect<T.Agent, ApiError, R>;
  readonly "agent.save": (a: { readonly id: string; readonly body: T.Agent }) => Effect.Effect<T.Agent, ApiError, R>;
  readonly "agent.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** An agent's memories: the manager's (agent manager) are the lines of its MEMORY.md, with the file and how many of the newest
   * its prompt carries; every other agent's are rows. */
  readonly "memory.list": (a: { readonly agent: string }) => Effect.Effect<T.MemoryList, ApiError, R>;
  /** What the agent would be reminded of on its next start; the manager is not reminded, it carries its whole file. */
  readonly "memory.recall": (a: { readonly agent: string; readonly project?: string; readonly text?: string }) => Effect.Effect<T.RecallPreview, ApiError, R>;
  readonly "memory.create": (a: { readonly agent: string; readonly body: T.MemoryRequest }) => Effect.Effect<T.Memory, ApiError, R>;
  readonly "memory.delete": (a: { readonly agent: string; readonly memory: string }) => Effect.Effect<void, ApiError, R>;
  readonly "manager.listArchive": (a: { readonly q?: string }) => Effect.Effect<T.ArchiveListing, ApiError, R>;
  readonly "manager.getArchive": (a: { readonly name: string }) => Effect.Effect<string, ApiError, R>;
  /** Saves the turn begun at a step of the manager's log as a case for its evals, with what it should have done. */
  readonly "manager.markWrong": (a: { readonly body: T.ManagerEvalRequest }) => Effect.Effect<T.ManagerEval, ApiError, R>;
  readonly "skill.list": () => Effect.Effect<T.Skill[], ApiError, R>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "skill.create": (a: { readonly body: T.Skill }) => Effect.Effect<T.Skill, ApiError, R>;
  readonly "skill.save": (a: { readonly id: string; readonly body: T.Skill }) => Effect.Effect<T.Skill, ApiError, R>;
  readonly "skill.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  readonly "project.list": () => Effect.Effect<T.ProjectSummary[], ApiError, R>;
  /** The first thing Create would refuse in this project, without making it. */
  readonly "project.check": (a: { readonly body: T.NewProject }) => Effect.Effect<T.ProjectCheck, ApiError, R>;
  readonly "project.create": (a: { readonly body: T.NewProject }) => Effect.Effect<T.ProjectSummary, ApiError, R>;
  readonly "project.languages": (a: { readonly id: string }) => Effect.Effect<T.ProjectLanguages, ApiError, R>;
  /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
  readonly "project.templates": (a: { readonly id: string }) => Effect.Effect<T.ProjectTemplates, ApiError, R>;
  readonly "project.activity": (a: { readonly id: string }) => Effect.Effect<T.ProjectActivity, ApiError, R>;
  readonly "voice.session": () => Effect.Effect<T.AgoraGrant, ApiError, R>;
  readonly "voice.renew": (a: { readonly body: T.RenewRequest }) => Effect.Effect<T.AgoraGrant, ApiError, R>;
  readonly "voice.start": (a: { readonly body: T.StartRequest }) => Effect.Effect<T.VoiceAgent, ApiError, R>;
  readonly "voice.stop": (a: { readonly body: T.VoiceAgent }) => Effect.Effect<void, ApiError, R>;
  readonly "voice.heard": (a: { readonly body: T.VoiceHeard }) => Effect.Effect<void, ApiError, R>;
  readonly "voice.said": (a: { readonly body: T.VoiceSaid }) => Effect.Effect<void, ApiError, R>;
  readonly "voice.dictate": (a: { readonly body: T.DictateRequest }) => Effect.Effect<T.Dictated, ApiError, R>;
  readonly "connector.list": () => Effect.Effect<T.ConnectorStatus[], ApiError, R>;
  readonly "connector.login": (a: { readonly id: T.ConnectorID; readonly body: T.ConnectorLogin }) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.verify": (a: { readonly id: T.ConnectorID; readonly body: T.VerifyRequest }) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.logout": (a: { readonly id: T.ConnectorID }) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.channel": (a: { readonly id: T.ConnectorID; readonly body: T.ConnectorsChannelRequest }) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "lan.status": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.update": (a: { readonly body: T.SetOpenRequest }) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.startPairing": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.stopPairing": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.answerPairing": (a: { readonly body: T.AnswerPairingRequest }) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.deleteDevice": (a: { readonly id: string }) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.pair": (a: { readonly body: T.LanPairRequest }) => Effect.Effect<T.LanPaired, ApiError, R>;
  readonly "lan.me": () => Effect.Effect<T.LanDevice, ApiError, R>;
  /** The documents, the newest change first; their blocks are in doc.get. */
  readonly "doc.list": () => Effect.Effect<T.Document[], ApiError, R>;
  readonly "doc.create": (a: { readonly body: T.DocRequest }) => Effect.Effect<T.DocSnapshot, ApiError, R>;
  /** A new document from Markdown: the format documents trade with agents and MEMORY.md in, not how they are stored. */
  readonly "doc.import": (a: { readonly body: T.DocImport }) => Effect.Effect<T.DocSnapshot, ApiError, R>;
  /** The document and every live block (no tombstones), in order. */
  readonly "doc.get": (a: { readonly id: string }) => Effect.Effect<T.DocSnapshot, ApiError, R>;
  /** A batch of ops, as the owner: taken in order, in one transaction, one batch of a document at a time. */
  readonly "doc.submit": (a: { readonly id: string; readonly body: T.DocSubmit }) => Effect.Effect<T.DocAck, ApiError, R>;
  readonly "doc.markdown": (a: { readonly id: string }) => Effect.Effect<T.DocMarkdown, ApiError, R>;
  /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
   * one already running is refused. */
  readonly "doc.demo": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
}

export interface Param {
  readonly name: string;
  /** Parsed as a number: one that is not a number is a 404 in the path, none in the query. */
  readonly number: boolean;
}

export interface Endpoint {
  readonly op: keyof Handlers;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly path: string;
  readonly pathParams: readonly Param[];
  readonly query: readonly Param[];
  readonly body: Schema.Codec<unknown> | undefined;
  readonly result: Schema.Codec<unknown> | undefined;
  readonly can: readonly Caller[];
}

export const endpoints: readonly Endpoint[] = [
  { op: "server.health", method: "GET", path: "/api/v1/health", pathParams: [], query: [], body: undefined, result: S.Health, can: ["owner", "remote"] },
  { op: "manager.open", method: "POST", path: "/api/v1/manager/open", pathParams: [], query: [], body: undefined, result: undefined, can: ["owner", "remote"] },
  { op: "manager.stop", method: "POST", path: "/api/v1/manager/stop", pathParams: [], query: [], body: undefined, result: undefined, can: ["owner", "remote"] },
  {
    op: "setting.load",
    method: "GET",
    path: "/api/v1/settings",
    pathParams: [],
    query: [],
    body: undefined,
    result: S.SettingsStatus,
    can: ["owner", "remote"],
  },
  {
    op: "setting.check",
    method: "POST",
    path: "/api/v1/settings/check",
    pathParams: [],
    query: [],
    body: S.SettingsUpdate,
    result: S.SettingsCheck,
    can: ["owner", "remote"],
  },
  { op: "setting.save", method: "PUT", path: "/api/v1/settings", pathParams: [], query: [], body: S.SettingsUpdate, result: S.SettingsStatus, can: ["owner"] },
  { op: "channel.say", method: "POST", path: "/api/v1/say", pathParams: [], query: [], body: S.SayRequest, result: undefined, can: ["owner", "remote"] },
  {
    op: "channel.create",
    method: "POST",
    path: "/api/v1/channels",
    pathParams: [],
    query: [],
    body: S.ChannelRequest,
    result: Schema.String,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "schedule.create",
    method: "POST",
    path: "/api/v1/schedules",
    pathParams: [],
    query: [],
    body: S.ScheduleRequest,
    result: S.Schedule,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "schedule.list",
    method: "GET",
    path: "/api/v1/schedules",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Schedule)),
    can: ["owner", "remote", "manager"],
  },
  {
    op: "schedule.update",
    method: "PUT",
    path: "/api/v1/schedules/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.ScheduleUpdate,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "schedule.delete",
    method: "DELETE",
    path: "/api/v1/schedules/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "channel.update",
    method: "PUT",
    path: "/api/v1/channels/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.ChannelUpdate,
    result: undefined,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "manager.hear",
    method: "POST",
    path: "/api/v1/manager/hear",
    pathParams: [],
    query: [],
    body: S.SayRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "issue.comment",
    method: "POST",
    path: "/api/v1/issues/{id}/comment",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.CommentRequest,
    result: undefined,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "issue.changes",
    method: "GET",
    path: "/api/v1/issues/{id}/changes",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.Changes,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "issue.resolve",
    method: "POST",
    path: "/api/v1/issues/{id}/resolve",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "session.stop",
    method: "POST",
    path: "/api/v1/sessions/{id}/stop",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "session.list",
    method: "GET",
    path: "/api/v1/sessions",
    pathParams: [],
    query: [{ name: "agent", number: false }],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Session)),
    can: ["owner", "remote"],
  },
  {
    op: "session.get",
    method: "GET",
    path: "/api/v1/sessions/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.Session,
    can: ["owner", "remote"],
  },
  {
    op: "session.events",
    method: "GET",
    path: "/api/v1/sessions/{id}/events",
    pathParams: [{ name: "id", number: false }],
    query: [{ name: "run", number: false }],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.SessionEvent)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.history",
    method: "GET",
    path: "/api/v1/issues/history",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.IssueHistory)),
    can: ["owner", "remote", "manager"],
  },
  {
    op: "issue.list",
    method: "GET",
    path: "/api/v1/issues",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Issue)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.get",
    method: "GET",
    path: "/api/v1/issues/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.Issue,
    can: ["owner", "remote"],
  },
  {
    op: "issue.runs",
    method: "GET",
    path: "/api/v1/issues/{id}/runs",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Run)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.timeline",
    method: "GET",
    path: "/api/v1/issues/{id}/timeline",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.IssueTimeline,
    can: ["owner", "remote"],
  },
  { op: "issue.create", method: "POST", path: "/api/v1/issues", pathParams: [], query: [], body: S.IssueRequest, result: S.Issue, can: ["owner", "remote"] },
  {
    op: "issue.update",
    method: "PUT",
    path: "/api/v1/issues/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.IssueUpdate,
    result: S.Issue,
    can: ["owner", "remote"],
  },
  {
    op: "issue.delete",
    method: "DELETE",
    path: "/api/v1/issues/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "issue.move",
    method: "PUT",
    path: "/api/v1/issues/{id}/move",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.MoveIssueRequest,
    result: Schema.mutable(Schema.Array(S.Issue)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.status",
    method: "PUT",
    path: "/api/v1/issues/{id}/status",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.IssueStatusRequest,
    result: S.Issue,
    can: ["owner", "remote"],
  },
  {
    op: "issue.draft",
    method: "POST",
    path: "/api/v1/issues/{id}/draft",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.IssueDraftRequest,
    result: S.Issue,
    can: ["owner", "remote"],
  },
  {
    op: "issue.dispatch",
    method: "POST",
    path: "/api/v1/issues/{id}/dispatch",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.IssueDispatchRequest,
    result: S.Dispatched,
    can: ["owner", "remote"],
  },
  {
    op: "issue.accept",
    method: "POST",
    path: "/api/v1/issues/{id}/accept",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.IssueAcceptRequest,
    result: S.Issue,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "graph.split",
    method: "POST",
    path: "/api/v1/graphs",
    pathParams: [],
    query: [],
    body: S.GraphSplitRequest,
    result: Schema.String,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "graph.updateTask",
    method: "PUT",
    path: "/api/v1/graphs/{id}/tasks/{task}",
    pathParams: [
      { name: "id", number: false },
      { name: "task", number: false },
    ],
    query: [],
    body: S.TaskEdit,
    result: Schema.String,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "graph.deleteTask",
    method: "DELETE",
    path: "/api/v1/graphs/{id}/tasks/{task}",
    pathParams: [
      { name: "id", number: false },
      { name: "task", number: false },
    ],
    query: [],
    body: undefined,
    result: Schema.String,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "graph.act",
    method: "POST",
    path: "/api/v1/graphs/{id}/act",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.GraphActRequest,
    result: Schema.String,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "graph.taskAct",
    method: "POST",
    path: "/api/v1/graphs/{id}/tasks/{task}/act",
    pathParams: [
      { name: "id", number: false },
      { name: "task", number: false },
    ],
    query: [],
    body: S.TaskActRequest,
    result: Schema.String,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "channel.history",
    method: "GET",
    path: "/api/v1/channels/{id}/messages",
    pathParams: [{ name: "id", number: false }],
    query: [
      { name: "before", number: true },
      { name: "limit", number: true },
    ],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.ChatMessage)),
    can: ["owner", "remote", "manager"],
  },
  {
    op: "channel.markRead",
    method: "POST",
    path: "/api/v1/channels/{id}/read",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.ChatReadRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "graph.changes",
    method: "GET",
    path: "/api/v1/graphs/{id}/changes",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.Changes,
    can: ["owner", "remote"],
  },
  {
    op: "graph.events",
    method: "GET",
    path: "/api/v1/graphs/{id}/events",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.GraphEvent)),
    can: ["owner", "remote"],
  },
  {
    op: "game.achievements",
    method: "GET",
    path: "/api/v1/game/achievements",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Achievement)),
    can: ["owner", "remote"],
  },
  {
    op: "game.chooseTitle",
    method: "POST",
    path: "/api/v1/game/title",
    pathParams: [],
    query: [],
    body: S.ChooseTitleRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.list",
    method: "GET",
    path: "/api/v1/runtimes",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.RuntimeInfo)),
    can: ["owner", "remote"],
  },
  { op: "github.status", method: "GET", path: "/api/v1/github", pathParams: [], query: [], body: undefined, result: S.GitHubStatus, can: ["owner", "remote"] },
  {
    op: "github.refresh",
    method: "POST",
    path: "/api/v1/github/refresh",
    pathParams: [],
    query: [],
    body: undefined,
    result: S.GitHubStatus,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.refresh",
    method: "POST",
    path: "/api/v1/runtimes/{id}/refresh",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.RuntimeInfo,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.update",
    method: "PUT",
    path: "/api/v1/runtimes/{id}/settings",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.RuntimeSettings,
    result: S.RuntimeInfo,
    can: ["owner"],
  },
  {
    op: "agent.list",
    method: "GET",
    path: "/api/v1/agents",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Agent)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.check",
    method: "POST",
    path: "/api/v1/agents/check",
    pathParams: [],
    query: [],
    body: S.AgentCheckRequest,
    result: Schema.mutable(Schema.Array(S.AgentCheck)),
    can: ["owner", "remote"],
  },
  { op: "agent.create", method: "POST", path: "/api/v1/agents", pathParams: [], query: [], body: S.Agent, result: S.Agent, can: ["owner", "manager"] },
  {
    op: "agent.save",
    method: "PUT",
    path: "/api/v1/agents/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.Agent,
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.delete",
    method: "DELETE",
    path: "/api/v1/agents/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner"],
  },
  {
    op: "memory.list",
    method: "GET",
    path: "/api/v1/memories/{agent}",
    pathParams: [{ name: "agent", number: false }],
    query: [],
    body: undefined,
    result: S.MemoryList,
    can: ["owner", "remote"],
  },
  {
    op: "memory.recall",
    method: "GET",
    path: "/api/v1/memories/{agent}/recall",
    pathParams: [{ name: "agent", number: false }],
    query: [
      { name: "project", number: false },
      { name: "text", number: false },
    ],
    body: undefined,
    result: S.RecallPreview,
    can: ["owner", "remote"],
  },
  {
    op: "memory.create",
    method: "POST",
    path: "/api/v1/memories/{agent}",
    pathParams: [{ name: "agent", number: false }],
    query: [],
    body: S.MemoryRequest,
    result: S.Memory,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "memory.delete",
    method: "DELETE",
    path: "/api/v1/memories/{agent}/{memory}",
    pathParams: [
      { name: "agent", number: false },
      { name: "memory", number: false },
    ],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "manager.listArchive",
    method: "GET",
    path: "/api/v1/manager/archive",
    pathParams: [],
    query: [{ name: "q", number: false }],
    body: undefined,
    result: S.ArchiveListing,
    can: ["owner", "remote", "manager"],
  },
  {
    op: "manager.getArchive",
    method: "GET",
    path: "/api/v1/manager/archive/{name}",
    pathParams: [{ name: "name", number: false }],
    query: [],
    body: undefined,
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "manager.markWrong",
    method: "POST",
    path: "/api/v1/manager/evals",
    pathParams: [],
    query: [],
    body: S.ManagerEvalRequest,
    result: S.ManagerEval,
    can: ["owner", "remote"],
  },
  {
    op: "skill.list",
    method: "GET",
    path: "/api/v1/skills",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Skill)),
    can: ["owner", "remote"],
  },
  { op: "skill.create", method: "POST", path: "/api/v1/skills", pathParams: [], query: [], body: S.Skill, result: S.Skill, can: ["owner", "manager"] },
  {
    op: "skill.save",
    method: "PUT",
    path: "/api/v1/skills/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.Skill,
    result: S.Skill,
    can: ["owner"],
  },
  {
    op: "skill.delete",
    method: "DELETE",
    path: "/api/v1/skills/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner"],
  },
  {
    op: "project.list",
    method: "GET",
    path: "/api/v1/projects",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.ProjectSummary)),
    can: ["owner", "remote", "manager"],
  },
  {
    op: "project.check",
    method: "POST",
    path: "/api/v1/projects/check",
    pathParams: [],
    query: [],
    body: S.NewProject,
    result: S.ProjectCheck,
    can: ["owner", "remote"],
  },
  {
    op: "project.create",
    method: "POST",
    path: "/api/v1/projects",
    pathParams: [],
    query: [],
    body: S.NewProject,
    result: S.ProjectSummary,
    can: ["owner", "remote"],
  },
  {
    op: "project.languages",
    method: "GET",
    path: "/api/v1/projects/{id}/languages",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.ProjectLanguages,
    can: ["owner", "remote"],
  },
  {
    op: "project.templates",
    method: "GET",
    path: "/api/v1/projects/{id}/templates",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.ProjectTemplates,
    can: ["owner", "remote"],
  },
  {
    op: "project.activity",
    method: "GET",
    path: "/api/v1/projects/{id}/activity",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.ProjectActivity,
    can: ["owner", "remote"],
  },
  {
    op: "voice.session",
    method: "POST",
    path: "/api/v1/voice/session",
    pathParams: [],
    query: [],
    body: undefined,
    result: S.AgoraGrant,
    can: ["owner", "remote"],
  },
  {
    op: "voice.renew",
    method: "POST",
    path: "/api/v1/voice/renew",
    pathParams: [],
    query: [],
    body: S.RenewRequest,
    result: S.AgoraGrant,
    can: ["owner", "remote"],
  },
  {
    op: "voice.start",
    method: "POST",
    path: "/api/v1/voice/agent",
    pathParams: [],
    query: [],
    body: S.StartRequest,
    result: S.VoiceAgent,
    can: ["owner", "remote"],
  },
  {
    op: "voice.stop",
    method: "POST",
    path: "/api/v1/voice/agent/stop",
    pathParams: [],
    query: [],
    body: S.VoiceAgent,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.heard",
    method: "POST",
    path: "/api/v1/voice/agent/heard",
    pathParams: [],
    query: [],
    body: S.VoiceHeard,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.said",
    method: "POST",
    path: "/api/v1/voice/agent/said",
    pathParams: [],
    query: [],
    body: S.VoiceSaid,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.dictate",
    method: "POST",
    path: "/api/v1/voice/dictate",
    pathParams: [],
    query: [],
    body: S.DictateRequest,
    result: S.Dictated,
    can: ["owner", "remote"],
  },
  {
    op: "connector.list",
    method: "GET",
    path: "/api/v1/connectors",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.ConnectorStatus)),
    can: ["owner", "remote"],
  },
  {
    op: "connector.login",
    method: "POST",
    path: "/api/v1/connectors/{id}/login",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.ConnectorLogin,
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.verify",
    method: "POST",
    path: "/api/v1/connectors/{id}/verify",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.VerifyRequest,
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.logout",
    method: "POST",
    path: "/api/v1/connectors/{id}/logout",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.channel",
    method: "PUT",
    path: "/api/v1/connectors/{id}/channel",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.ConnectorsChannelRequest,
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  { op: "lan.status", method: "GET", path: "/api/v1/lan", pathParams: [], query: [], body: undefined, result: S.LanStatus, can: ["owner"] },
  { op: "lan.update", method: "PUT", path: "/api/v1/lan", pathParams: [], query: [], body: S.SetOpenRequest, result: S.LanStatus, can: ["owner"] },
  { op: "lan.startPairing", method: "POST", path: "/api/v1/lan/pairing", pathParams: [], query: [], body: undefined, result: S.LanStatus, can: ["owner"] },
  { op: "lan.stopPairing", method: "DELETE", path: "/api/v1/lan/pairing", pathParams: [], query: [], body: undefined, result: S.LanStatus, can: ["owner"] },
  {
    op: "lan.answerPairing",
    method: "POST",
    path: "/api/v1/lan/pairing/answer",
    pathParams: [],
    query: [],
    body: S.AnswerPairingRequest,
    result: S.LanStatus,
    can: ["owner"],
  },
  {
    op: "lan.deleteDevice",
    method: "DELETE",
    path: "/api/v1/lan/devices/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.LanStatus,
    can: ["owner"],
  },
  {
    op: "lan.pair",
    method: "POST",
    path: "/api/v1/lan/pair",
    pathParams: [],
    query: [],
    body: S.LanPairRequest,
    result: S.LanPaired,
    can: ["owner", "remote"],
  },
  { op: "lan.me", method: "GET", path: "/api/v1/lan/me", pathParams: [], query: [], body: undefined, result: S.LanDevice, can: ["owner", "remote"] },
  {
    op: "doc.list",
    method: "GET",
    path: "/api/v1/docs",
    pathParams: [],
    query: [],
    body: undefined,
    result: Schema.mutable(Schema.Array(S.Document)),
    can: ["owner", "remote"],
  },
  { op: "doc.create", method: "POST", path: "/api/v1/docs", pathParams: [], query: [], body: S.DocRequest, result: S.DocSnapshot, can: ["owner", "remote"] },
  {
    op: "doc.import",
    method: "POST",
    path: "/api/v1/docs/import",
    pathParams: [],
    query: [],
    body: S.DocImport,
    result: S.DocSnapshot,
    can: ["owner", "remote"],
  },
  {
    op: "doc.get",
    method: "GET",
    path: "/api/v1/docs/{id}",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.DocSnapshot,
    can: ["owner", "remote"],
  },
  {
    op: "doc.submit",
    method: "POST",
    path: "/api/v1/docs/{id}/submit",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: S.DocSubmit,
    result: S.DocAck,
    can: ["owner", "remote"],
  },
  {
    op: "doc.markdown",
    method: "GET",
    path: "/api/v1/docs/{id}/markdown",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: S.DocMarkdown,
    can: ["owner", "remote"],
  },
  {
    op: "doc.demo",
    method: "POST",
    path: "/api/v1/docs/{id}/demo",
    pathParams: [{ name: "id", number: false }],
    query: [],
    body: undefined,
    result: undefined,
    can: ["owner"],
  },
];
