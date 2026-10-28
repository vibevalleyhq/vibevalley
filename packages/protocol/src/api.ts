// Each endpoint is a POST at its op's path (pathOf); the server routes and the clients call by this list
// (apps/server/src/http/api.ts, VibeValleyApi).

import { type Effect, Schema } from "effect";
import type * as T from "./shapes";
import { pathOf } from "./shapes";
import * as S from "./schema";

export type Caller = "owner" | "remote" | "orchestrator" | "session";

/** One thing to do next after a refusal: what to do, and, when it is a command, the command line's words for it (without
 * the program's name), runnable as they are. */
export interface Next {
  readonly say: string;
  readonly run?: readonly string[];
}

export interface Refused {
  readonly _tag: "Refused";
  readonly reason: string;
  /** What can be done instead, as the refusing service knows it (an issue's acts and moves now). */
  readonly next?: readonly Next[];
}

export interface Missing {
  readonly _tag: "Missing";
  readonly what: string;
  readonly next?: readonly Next[];
}

/** A 设置 section a voice problem is fixed in (the page's /settings/<section>). */
export type VoiceFix = "models" | "call";

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

const NextSchema: Schema.Codec<Next> = Schema.Struct({
  say: Schema.String,
  run: Schema.optionalKey(Schema.Array(Schema.String)),
});
const reasonOf = <Tag extends string>(tag: Tag) => Schema.Struct({ _tag: Schema.tag(tag), reason: Schema.String });

/** The error as a route writes it, for a client to read back (the command line's failures). */
export const ApiError: Schema.Codec<ApiError> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Refused"),
    reason: Schema.String,
    next: Schema.optionalKey(Schema.Array(NextSchema)),
  }),
  Schema.Struct({
    _tag: Schema.tag("Missing"),
    what: Schema.String,
    next: Schema.optionalKey(Schema.Array(NextSchema)),
  }),
  Schema.Struct({
    _tag: Schema.tag("VoiceUnavailable"),
    reason: Schema.String,
    settings: Schema.optionalKey(Schema.Literals(["models", "call"])),
  }),
  reasonOf("VoiceAgentFailed"),
  reasonOf("ConnectorRefused"),
  reasonOf("LanRefused"),
]);

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
  readonly "server.health.get": () => Effect.Effect<T.Health, ApiError, R>;
  readonly "orchestrator.open": () => Effect.Effect<void, ApiError, R>;
  /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
  readonly "orchestrator.stop": (a: { readonly agent?: string }) => Effect.Effect<void, ApiError, R>;
  readonly "setting.get": () => Effect.Effect<T.SettingsStatus, ApiError, R>;
  /** The first thing Save would refuse in these settings, without saving them. */
  readonly "setting.check": (a: T.SettingsUpdate) => Effect.Effect<T.Check, ApiError, R>;
  readonly "setting.update": (a: T.SettingsUpdate) => Effect.Effect<T.SettingsStatus, ApiError, R>;
  readonly "channel.message.send": (a: T.SayRequest) => Effect.Effect<void, ApiError, R>;
  readonly "channel.create": (a: T.ChannelRequest) => Effect.Effect<string, ApiError, R>;
  readonly "recurrence.create": (a: T.RecurrenceRequest) => Effect.Effect<T.Recurrence, ApiError, R>;
  readonly "recurrence.list": () => Effect.Effect<T.Recurrence[], ApiError, R>;
  /** Only what the body gives changes. */
  readonly "recurrence.update": (a: { readonly id: string } & T.RecurrenceUpdate) => Effect.Effect<void, ApiError, R>;
  readonly "recurrence.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "recurrence.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "channel.update": (a: { readonly id: string } & T.ChannelUpdate) => Effect.Effect<void, ApiError, R>;
  /** The channel what names none goes to from now on: a connector's, a call's. */
  readonly "channel.default.set": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** A line heard on the call that is on, without its id: refused unless one call is. */
  readonly "voice.hear": (a: { readonly text: string; readonly agent?: string; readonly sendKey?: string }) => Effect.Effect<void, ApiError, R>;
  /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
  readonly "issue.comment.create": (a: { readonly id: string } & T.CommentRequest) => Effect.Effect<void, ApiError, R>;
  readonly "issue.diff.get": (a: { readonly id: string }) => Effect.Effect<T.Changes, ApiError, R>;
  /** Stops a session's turn; it stays, and a comment starts the next. */
  readonly "session.stop": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  readonly "session.list": (a: { readonly agent?: string }) => Effect.Effect<T.Session[], ApiError, R>;
  readonly "session.get": (a: { readonly id: string }) => Effect.Effect<T.Session, ApiError, R>;
  /** Its log, oldest first; run gives one run's only. The orchestrator's log is session orchestrator's. */
  readonly "session.event.list": (a: { readonly id: string; readonly run?: string }) => Effect.Effect<T.SessionEvent[], ApiError, R>;
  /** One joined read of issues and their real sessions, including explicit missing records. */
  readonly "issue.history.list": () => Effect.Effect<T.IssueHistory[], ApiError, R>;
  /** The open issues by default, the newest first; the filter narrows them. */
  readonly "issue.list": (a: T.IssueFilter) => Effect.Effect<T.Issue[], ApiError, R>;
  /** A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done. */
  readonly "issue.review": (a: { readonly id: string } & T.IssueReviewRequest) => Effect.Effect<T.Issue, ApiError, R>;
  /** The issue becomes a task graph's parent and its tasks the issues under it, started at once. */
  readonly "issue.split": (a: { readonly id: string } & T.IssueSplitRequest) => Effect.Effect<string, ApiError, R>;
  readonly "issue.get": (a: { readonly id: string }) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.run.list": (a: { readonly id: string }) => Effect.Effect<T.Run[], ApiError, R>;
  /** The issue's milestones, newest first, and what all its runs cost. */
  readonly "issue.timeline.get": (a: { readonly id: string }) => Effect.Effect<T.IssueTimeline, ApiError, R>;
  readonly "issue.create": (a: T.IssueRequest) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.update": (a: { readonly id: string } & T.IssueUpdate) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What issue.delete would do, refused as it would be; nothing changes. */
  readonly "issue.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  /** Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is
   * another round (the words are the findings; stuck, none takes the server's own); done is accepted and delivered as the
   * issue says; canceled sends its session home. Issue.moves lists where it may go. */
  readonly "issue.status.update": (a: { readonly id: string } & T.IssueStatusRequest) => Effect.Effect<T.Issue, ApiError, R>;
  /** What issue.status.update would do with the same body, refused as it would be; nothing changes. */
  readonly "issue.status.previewUpdate": (a: { readonly id: string } & T.IssueStatusRequest) => Effect.Effect<T.Preview, ApiError, R>;
  /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
   * leaves; with questions open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
  readonly "issue.refine": (a: { readonly id: string } & T.IssueRefineRequest) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "graph.split": (a: T.GraphSplitRequest) => Effect.Effect<string, ApiError, R>;
  readonly "graph.task.update": (a: { readonly id: string; readonly task: string } & T.TaskEdit) => Effect.Effect<string, ApiError, R>;
  readonly "graph.task.delete": (a: { readonly id: string; readonly task: string }) => Effect.Effect<string, ApiError, R>;
  /** What deleteTask would do, refused as it would be; nothing changes. */
  readonly "graph.task.previewDelete": (a: { readonly id: string; readonly task: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "graph.act": (a: { readonly id: string } & T.GraphActRequest) => Effect.Effect<string, ApiError, R>;
  readonly "graph.task.act": (a: { readonly id: string; readonly task: string } & T.TaskActRequest) => Effect.Effect<string, ApiError, R>;
  readonly "channel.message.list": (a: {
    readonly id: string;
    readonly before?: number;
    readonly limit?: number;
  }) => Effect.Effect<T.ChatMessage[], ApiError, R>;
  readonly "channel.markRead": (a: { readonly id: string } & T.ChatReadRequest) => Effect.Effect<void, ApiError, R>;
  /** The owner's own words, changed; nobody is told again. */
  readonly "channel.message.update": (a: T.MessageEdit) => Effect.Effect<T.ChatMessage, ApiError, R>;
  /** Any message: its words go, its number stays, and what it still had to hand is dropped. */
  readonly "channel.message.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What channel.message.delete would do, refused as it would be; nothing changes. */
  readonly "channel.message.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "channel.message.search": (a: T.MessageSearch) => Effect.Effect<T.MessageHit[], ApiError, R>;
  /** The owner's reaction added, or taken back when it is there. */
  readonly "channel.reaction.toggle": (a: T.ReactionToggle) => Effect.Effect<T.ChatMessage, ApiError, R>;
  readonly "channel.pin.toggle": (a: { readonly id: string }) => Effect.Effect<T.ChatMessage, ApiError, R>;
  /** A channel's pinned messages, newest pinned first. */
  readonly "channel.pin.list": (a: { readonly id: string }) => Effect.Effect<T.ChatMessage[], ApiError, R>;
  /** The thread under a message, made if it has none: its id. */
  readonly "channel.thread.create": (a: { readonly id: string }) => Effect.Effect<string, ApiError, R>;
  readonly "channel.attachment.create": (a: T.AttachmentUpload) => Effect.Effect<T.Attachment, ApiError, R>;
  /** Out of the sidebar and the thread lists, or back; its messages and address stay. The default channel stays. */
  readonly "channel.archive.toggle": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** A channel nothing points at any more, with its threads and messages. */
  readonly "channel.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What channel.delete would do, refused as it would be; nothing changes. */
  readonly "channel.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "channel.notify.set": (a: T.NotifyRequest) => Effect.Effect<void, ApiError, R>;
  /** The owner's direct channel with a helper profile (or the orchestrator), made if there is none: its id. */
  readonly "channel.direct.create": (a: { readonly agent: string }) => Effect.Effect<string, ApiError, R>;
  /** The owner's read moved back to just before this message. */
  readonly "channel.markUnread": (a: { readonly id: string } & T.ChatReadRequest) => Effect.Effect<void, ApiError, R>;
  /** Every channel and direct channel, the default first. */
  readonly "channel.list": () => Effect.Effect<T.Channel[], ApiError, R>;
  /** The places the caller has not read all of, the newest first. */
  readonly "channel.unread.list": () => Effect.Effect<T.ChannelUnread[], ApiError, R>;
  readonly "graph.diff.get": (a: { readonly id: string }) => Effect.Effect<T.Changes, ApiError, R>;
  readonly "graph.event.list": (a: { readonly id: string }) => Effect.Effect<T.GraphEvent[], ApiError, R>;
  /** Every task graph, as the board has them. */
  readonly "graph.list": () => Effect.Effect<T.TaskGraph[], ApiError, R>;
  readonly "graph.get": (a: { readonly id: string }) => Effect.Effect<T.TaskGraph, ApiError, R>;
  readonly "game.achievement.list": () => Effect.Effect<T.Achievement[], ApiError, R>;
  readonly "game.title.set": (a: T.ChooseTitleRequest) => Effect.Effect<void, ApiError, R>;
  readonly "runtime.list": () => Effect.Effect<T.RuntimeInfo[], ApiError, R>;
  readonly "github.get": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "github.refresh": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "runtime.refresh": (a: { readonly id: string }) => Effect.Effect<T.RuntimeInfo, ApiError, R>;
  readonly "runtime.setting.update": (a: { readonly id: string } & T.RuntimeSettings) => Effect.Effect<T.RuntimeInfo, ApiError, R>;
  readonly "agent.list": () => Effect.Effect<T.Agent[], ApiError, R>;
  /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
  readonly "agent.check": (a: T.AgentCheckRequest) => Effect.Effect<T.AgentCheck[], ApiError, R>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "agent.create": (a: T.Agent) => Effect.Effect<T.Agent, ApiError, R>;
  readonly "agent.update": (a: T.Agent) => Effect.Effect<T.Agent, ApiError, R>;
  readonly "agent.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "agent.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  /** The templates a profile can be installed from: the built-in ones, then those added on this machine. */
  readonly "agent.template.list": () => Effect.Effect<T.AgentTemplate[], ApiError, R>;
  /** A new profile from a template; installing one again makes another. */
  readonly "agent.template.install": (a: { readonly id: string }) => Effect.Effect<T.Agent, ApiError, R>;
  /** A profile made again from its template's version now: what came from the template is replaced, what is the
   * machine's (environment, default project, on or off) stays. */
  readonly "agent.template.update": (a: { readonly agent: string }) => Effect.Effect<T.Agent, ApiError, R>;
  /** A template folder on this machine copied in beside the built-in ones; nothing is installed. */
  readonly "agent.template.add": (a: { readonly path: string }) => Effect.Effect<T.AgentTemplate, ApiError, R>;
  /** An added template gone; the profiles installed from it stay. */
  readonly "agent.template.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What deleting the template would do, refused as it would be; nothing changes. */
  readonly "agent.template.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  /** An agent's memories: an orchestrator's are the lines of its MEMORY.md, with the file and how many of the newest
   * its prompt carries; every other agent's are rows. */
  readonly "memory.list": (a: { readonly agent: string }) => Effect.Effect<T.MemoryList, ApiError, R>;
  /** What the agent would be reminded of on its next start; the orchestrator is not reminded, it carries its whole file. */
  readonly "memory.recall": (a: { readonly agent: string; readonly project?: string; readonly text?: string }) => Effect.Effect<T.RecallPreview, ApiError, R>;
  readonly "memory.create": (a: { readonly agent: string } & T.MemoryRequest) => Effect.Effect<T.Memory, ApiError, R>;
  /** Memories whose words match, from every source the agent has; none named is every profile's. */
  readonly "memory.search": (a: { readonly agent?: string; readonly project?: string; readonly text?: string }) => Effect.Effect<T.MemorySearch, ApiError, R>;
  readonly "memory.delete": (a: { readonly agent: string; readonly memory: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "memory.previewDelete": (a: { readonly agent: string; readonly memory: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "orchestrator.archive.list": (a: { readonly agent?: string; readonly q?: string }) => Effect.Effect<T.ArchiveListing, ApiError, R>;
  readonly "orchestrator.archive.get": (a: { readonly agent?: string; readonly name: string }) => Effect.Effect<string, ApiError, R>;
  /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
  readonly "orchestrator.eval.create": (a: T.OrchestratorEvalRequest) => Effect.Effect<T.OrchestratorEval, ApiError, R>;
  readonly "skill.list": () => Effect.Effect<T.Skill[], ApiError, R>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "skill.create": (a: T.Skill) => Effect.Effect<T.Skill, ApiError, R>;
  readonly "skill.update": (a: T.Skill) => Effect.Effect<T.Skill, ApiError, R>;
  readonly "skill.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "skill.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "project.list": () => Effect.Effect<T.ProjectSummary[], ApiError, R>;
  /** The first thing Create would refuse in this project, without making it. */
  readonly "project.check": (a: T.NewProject) => Effect.Effect<T.Check, ApiError, R>;
  readonly "project.create": (a: T.NewProject) => Effect.Effect<T.ProjectSummary, ApiError, R>;
  readonly "project.language.list": (a: { readonly id: string }) => Effect.Effect<T.ProjectLanguages, ApiError, R>;
  /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
  readonly "project.template.list": (a: { readonly id: string }) => Effect.Effect<T.ProjectTemplates, ApiError, R>;
  readonly "project.activity.get": (a: { readonly id: string }) => Effect.Effect<T.ProjectActivity, ApiError, R>;
  readonly "voice.session.create": () => Effect.Effect<T.AgoraGrant, ApiError, R>;
  readonly "voice.session.renew": (a: T.RenewRequest) => Effect.Effect<T.AgoraGrant, ApiError, R>;
  readonly "voice.agent.start": (a: T.StartRequest) => Effect.Effect<T.VoiceAgent, ApiError, R>;
  readonly "voice.agent.stop": (a: T.VoiceAgent) => Effect.Effect<void, ApiError, R>;
  readonly "voice.agent.hear": (a: T.VoiceHeard) => Effect.Effect<void, ApiError, R>;
  readonly "voice.agent.say": (a: T.VoiceSaid) => Effect.Effect<void, ApiError, R>;
  readonly "voice.dictate": (a: T.DictateRequest) => Effect.Effect<T.Dictated, ApiError, R>;
  /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
  readonly "voice.moss.check": (a: T.MossCheckRequest) => Effect.Effect<T.Check, ApiError, R>;
  readonly "connector.list": () => Effect.Effect<T.ConnectorStatus[], ApiError, R>;
  readonly "connector.login": (a: { readonly id: T.ConnectorID } & T.ConnectorLogin) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.verify": (a: { readonly id: T.ConnectorID } & T.VerifyRequest) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.logout": (a: { readonly id: T.ConnectorID }) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.channel.set": (a: { readonly id: T.ConnectorID } & T.ConnectorsChannelRequest) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "lan.get": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.update": (a: T.SetOpenRequest) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.pairing.start": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.pairing.stop": () => Effect.Effect<T.LanStatus, ApiError, R>;
  /** What stopPairing would do, refused as it would be; nothing changes. */
  readonly "lan.pairing.previewStop": () => Effect.Effect<T.Preview, ApiError, R>;
  readonly "lan.pairing.answer": (a: T.AnswerPairingRequest) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.device.delete": (a: { readonly id: string }) => Effect.Effect<T.LanStatus, ApiError, R>;
  /** What deleteDevice would do, refused as it would be; nothing changes. */
  readonly "lan.device.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "lan.pair": (a: T.LanPairRequest) => Effect.Effect<T.LanPaired, ApiError, R>;
  readonly "lan.me.get": () => Effect.Effect<T.LanDevice, ApiError, R>;
  /** The documents, the newest change first; their blocks are in doc.get. */
  readonly "doc.list": () => Effect.Effect<T.Document[], ApiError, R>;
  readonly "doc.create": (a: T.DocRequest) => Effect.Effect<T.DocSnapshot, ApiError, R>;
  /** A new document from Markdown: the format documents trade with agents and MEMORY.md in, not how they are stored. */
  readonly "doc.import": (a: T.DocImport) => Effect.Effect<T.DocSnapshot, ApiError, R>;
  /** The document and every live block (no tombstones), in order. */
  readonly "doc.get": (a: { readonly id: string }) => Effect.Effect<T.DocSnapshot, ApiError, R>;
  /** A batch of ops, as the owner: taken in order, in one transaction, one batch of a document at a time. */
  readonly "doc.submit": (a: { readonly id: string } & T.DocSubmit) => Effect.Effect<T.DocAck, ApiError, R>;
  /** One block appended, as one batch of one op. */
  readonly "doc.block.create": (a: { readonly id: string } & T.DocBlockCreate) => Effect.Effect<T.DocOpResult, ApiError, R>;
  readonly "doc.block.update": (a: { readonly id: string } & T.DocBlockUpdate) => Effect.Effect<T.DocOpResult, ApiError, R>;
  readonly "doc.markdown.get": (a: { readonly id: string }) => Effect.Effect<T.DocMarkdown, ApiError, R>;
  /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
   * one already running is refused. */
  readonly "doc.demo": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
}

export interface Endpoint {
  readonly op: keyof Handlers;
  /** The input's fields that say what it is about (the issue's id…): the command line takes them as its arguments. */
  readonly about: readonly string[];
  /** The one argument, ids and all, sent as the POST's JSON body; none when it takes nothing. */
  readonly input: Schema.Codec<unknown> | undefined;
  readonly result: Schema.Codec<unknown> | undefined;
  readonly can: readonly Caller[];
  /** It changes what cannot be taken back (deletes, merges, closes, sends helpers home): its dry run is this endpoint,
   * which takes the same input and answers a Preview without changing anything (the command line's --dry-run). */
  readonly dryRun?: keyof Handlers;
}

export { pathOf };

/** How the command line writes a word of an op: previewDelete is preview-delete. */
export const kebab = (word: string) => word.replace(/[A-Z]/g, (c, i: number) => (i > 0 ? "-" : "") + c.toLowerCase());

export const commandOf = (op: keyof Handlers, about: readonly string[] = [], input?: unknown): string[] => [
  ...op.split(".").map(kebab),
  ...about,
  ...(input === undefined ? [] : ["--json", JSON.stringify(input)]),
];

/** Only get, list, check, recall and preview read; every other verb may change something. */
export const readsOnly = (op: string) => /^(get|list|check|recall|search|preview[A-Z]\w*)$/.test(op.split(".").at(-1) ?? "");

/** The fields an endpoint's input takes, what it is about among them; none when it takes nothing. */
export const fieldsOf = (e: Endpoint): readonly string[] => Object.keys((e.input as unknown as { fields?: object } | undefined)?.fields ?? {});

const input = (ids: Schema.Struct.Fields, body?: Schema.Codec<unknown>): Schema.Codec<unknown> =>
  Schema.Struct({ ...ids, ...(body ? (body as unknown as Schema.Struct<Schema.Struct.Fields>).fields : {}) }) as unknown as Schema.Codec<unknown>;

/** The inputs an op and its dry run share: the dry run takes exactly what the op takes. */
const recurrenceDeleteInput = input({ id: Schema.String });
const issueDeleteInput = input({ id: Schema.String });
/** A message, or a channel, by its id. */
const messageInput = input({ id: Schema.String });
const issueStatusUpdateInput = input({ id: Schema.String }, S.IssueStatusRequest);
const graphTaskDeleteInput = input({ id: Schema.String, task: Schema.String });
const agentDeleteInput = input({ id: Schema.String });
const memoryDeleteInput = input({ agent: Schema.String, memory: Schema.String });
const skillDeleteInput = input({ id: Schema.String });
const lanDeviceDeleteInput = input({ id: Schema.String });

export const endpoints: readonly Endpoint[] = [
  {
    op: "server.health.get",
    about: [],
    input: undefined,
    result: S.Health,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.open",
    about: [],
    input: undefined,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.stop",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String) }),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "setting.get",
    about: [],
    input: undefined,
    result: S.SettingsStatus,
    can: ["owner", "remote"],
  },
  {
    op: "setting.check",
    about: [],
    input: S.SettingsUpdate,
    result: S.Check,
    can: ["owner", "remote"],
  },
  {
    op: "setting.update",
    about: [],
    input: S.SettingsUpdate,
    result: S.SettingsStatus,
    can: ["owner"],
  },
  {
    op: "channel.message.send",
    about: ["id"],
    input: S.SayRequest,
    result: undefined,
    can: ["owner", "remote", "session"],
  },
  {
    op: "channel.create",
    about: [],
    input: S.ChannelRequest,
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "recurrence.create",
    about: [],
    input: S.RecurrenceRequest,
    result: S.Recurrence,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "recurrence.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Recurrence)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "recurrence.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.RecurrenceUpdate),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "recurrence.delete",
    about: ["id"],
    input: recurrenceDeleteInput,
    result: undefined,
    can: ["owner", "remote", "orchestrator"],
    dryRun: "recurrence.previewDelete",
  },
  {
    op: "recurrence.previewDelete",
    about: ["id"],
    input: recurrenceDeleteInput,
    result: S.Preview,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.ChannelUpdate),
    result: undefined,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.default.set",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.hear",
    about: [],
    input: input({ text: Schema.String, agent: Schema.optionalKey(Schema.String), sendKey: Schema.optionalKey(Schema.String) }),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "issue.comment.create",
    about: ["id"],
    input: input({ id: Schema.String }, S.CommentRequest),
    result: undefined,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.diff.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Changes,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "session.stop",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: undefined,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "session.list",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String) }),
    result: Schema.mutable(Schema.Array(S.Session)),
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "session.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Session,
    can: ["owner", "remote"],
  },
  {
    op: "session.event.list",
    about: ["id"],
    input: input({ id: Schema.String, run: Schema.optionalKey(Schema.String) }),
    result: Schema.mutable(Schema.Array(S.SessionEvent)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.history.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.IssueHistory)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.list",
    about: [],
    input: S.IssueFilter,
    result: Schema.mutable(Schema.Array(S.Issue)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.review",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueReviewRequest),
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.split",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueSplitRequest),
    result: Schema.String,
    can: ["owner", "remote", "session"],
  },
  {
    op: "issue.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.run.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: Schema.mutable(Schema.Array(S.Run)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.timeline.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.IssueTimeline,
    can: ["owner", "remote"],
  },
  {
    op: "issue.create",
    about: [],
    input: S.IssueRequest,
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueUpdate),
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.delete",
    about: ["id"],
    input: issueDeleteInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "issue.previewDelete",
  },
  {
    op: "issue.previewDelete",
    about: ["id"],
    input: issueDeleteInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "issue.status.update",
    about: ["id"],
    input: issueStatusUpdateInput,
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
    dryRun: "issue.status.previewUpdate",
  },
  {
    op: "issue.status.previewUpdate",
    about: ["id"],
    input: issueStatusUpdateInput,
    result: S.Preview,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.refine",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueRefineRequest),
    result: S.Issue,
    can: ["owner", "remote"],
  },
  {
    op: "graph.split",
    about: [],
    input: S.GraphSplitRequest,
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "graph.task.update",
    about: ["id", "task"],
    input: input({ id: Schema.String, task: Schema.String }, S.TaskEdit),
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "graph.task.delete",
    about: ["id", "task"],
    input: graphTaskDeleteInput,
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
    dryRun: "graph.task.previewDelete",
  },
  {
    op: "graph.task.previewDelete",
    about: ["id", "task"],
    input: graphTaskDeleteInput,
    result: S.Preview,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "graph.act",
    about: ["id"],
    input: input({ id: Schema.String }, S.GraphActRequest),
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "graph.task.act",
    about: ["id", "task"],
    input: input({ id: Schema.String, task: Schema.String }, S.TaskActRequest),
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.message.list",
    about: ["id"],
    input: input({ id: Schema.String, before: Schema.optionalKey(Schema.Number), limit: Schema.optionalKey(Schema.Number) }),
    result: Schema.mutable(Schema.Array(S.ChatMessage)),
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "channel.markRead",
    about: ["id"],
    input: input({ id: Schema.String }, S.ChatReadRequest),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.update",
    about: ["id"],
    input: S.MessageEdit,
    result: S.ChatMessage,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.delete",
    about: ["id"],
    input: messageInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "channel.message.previewDelete",
  },
  {
    op: "channel.message.previewDelete",
    about: ["id"],
    input: messageInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.search",
    about: [],
    input: S.MessageSearch,
    result: Schema.mutable(Schema.Array(S.MessageHit)),
    can: ["owner", "remote"],
  },
  {
    op: "channel.reaction.toggle",
    about: ["id"],
    input: S.ReactionToggle,
    result: S.ChatMessage,
    can: ["owner", "remote"],
  },
  {
    op: "channel.pin.toggle",
    about: ["id"],
    input: messageInput,
    result: S.ChatMessage,
    can: ["owner", "remote"],
  },
  {
    op: "channel.pin.list",
    about: ["id"],
    input: messageInput,
    result: Schema.mutable(Schema.Array(S.ChatMessage)),
    can: ["owner", "remote"],
  },
  {
    op: "channel.thread.create",
    about: ["id"],
    input: messageInput,
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "channel.archive.toggle",
    about: ["id"],
    input: messageInput,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.delete",
    about: ["id"],
    input: messageInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "channel.previewDelete",
  },
  {
    op: "channel.previewDelete",
    about: ["id"],
    input: messageInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "channel.direct.create",
    about: ["agent"],
    input: input({ agent: Schema.String }),
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "channel.notify.set",
    about: ["id"],
    input: S.NotifyRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.markUnread",
    about: ["id"],
    input: input({ id: Schema.String }, S.ChatReadRequest),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Channel)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.unread.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.ChannelUnread)),
    can: ["owner", "remote", "session"],
  },
  {
    op: "channel.attachment.create",
    about: [],
    input: S.AttachmentUpload,
    result: S.Attachment,
    can: ["owner", "remote"],
  },
  {
    op: "graph.diff.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Changes,
    can: ["owner", "remote"],
  },
  {
    op: "graph.event.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: Schema.mutable(Schema.Array(S.GraphEvent)),
    can: ["owner", "remote"],
  },
  {
    op: "graph.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.TaskGraph)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "graph.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.TaskGraph,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "game.achievement.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Achievement)),
    can: ["owner", "remote"],
  },
  {
    op: "game.title.set",
    about: [],
    input: S.ChooseTitleRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.RuntimeInfo)),
    can: ["owner", "remote"],
  },
  {
    op: "github.get",
    about: [],
    input: undefined,
    result: S.GitHubStatus,
    can: ["owner", "remote"],
  },
  {
    op: "github.refresh",
    about: [],
    input: undefined,
    result: S.GitHubStatus,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.refresh",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.RuntimeInfo,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.setting.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.RuntimeSettings),
    result: S.RuntimeInfo,
    can: ["owner"],
  },
  {
    op: "agent.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Agent)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.check",
    about: [],
    input: S.AgentCheckRequest,
    result: Schema.mutable(Schema.Array(S.AgentCheck)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.create",
    about: [],
    input: S.Agent,
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.update",
    about: ["id"],
    input: S.Agent,
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.delete",
    about: ["id"],
    input: agentDeleteInput,
    result: undefined,
    can: ["owner"],
    dryRun: "agent.previewDelete",
  },
  {
    op: "agent.previewDelete",
    about: ["id"],
    input: agentDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "agent.template.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.AgentTemplate)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.template.install",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.template.update",
    about: ["agent"],
    input: input({ agent: Schema.String }),
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.template.add",
    about: ["path"],
    input: input({ path: Schema.String }),
    result: S.AgentTemplate,
    can: ["owner"],
  },
  {
    op: "agent.template.delete",
    about: ["id"],
    input: agentDeleteInput,
    result: undefined,
    can: ["owner"],
    dryRun: "agent.template.previewDelete",
  },
  {
    op: "agent.template.previewDelete",
    about: ["id"],
    input: agentDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "memory.list",
    about: ["agent"],
    input: input({ agent: Schema.String }),
    result: S.MemoryList,
    can: ["owner", "remote"],
  },
  {
    op: "memory.recall",
    about: ["agent"],
    input: input({ agent: Schema.String, project: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }),
    result: S.RecallPreview,
    can: ["owner", "remote"],
  },
  {
    op: "memory.create",
    about: ["agent"],
    input: input({ agent: Schema.String }, S.MemoryRequest),
    result: S.Memory,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "memory.search",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String), project: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }),
    result: S.MemorySearch,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "memory.delete",
    about: ["agent", "memory"],
    input: memoryDeleteInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "memory.previewDelete",
  },
  {
    op: "memory.previewDelete",
    about: ["agent", "memory"],
    input: memoryDeleteInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.archive.list",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String), q: Schema.optionalKey(Schema.String) }),
    result: S.ArchiveListing,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.archive.get",
    about: ["name"],
    input: input({ agent: Schema.optionalKey(Schema.String), name: Schema.String }),
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.eval.create",
    about: [],
    input: S.OrchestratorEvalRequest,
    result: S.OrchestratorEval,
    can: ["owner", "remote"],
  },
  {
    op: "skill.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Skill)),
    can: ["owner", "remote"],
  },
  {
    op: "skill.create",
    about: [],
    input: S.Skill,
    result: S.Skill,
    can: ["owner"],
  },
  {
    op: "skill.update",
    about: ["id"],
    input: S.Skill,
    result: S.Skill,
    can: ["owner"],
  },
  {
    op: "skill.delete",
    about: ["id"],
    input: skillDeleteInput,
    result: undefined,
    can: ["owner"],
    dryRun: "skill.previewDelete",
  },
  {
    op: "skill.previewDelete",
    about: ["id"],
    input: skillDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "project.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.ProjectSummary)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "project.check",
    about: [],
    input: S.NewProject,
    result: S.Check,
    can: ["owner", "remote"],
  },
  {
    op: "project.create",
    about: [],
    input: S.NewProject,
    result: S.ProjectSummary,
    can: ["owner", "remote"],
  },
  {
    op: "project.language.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ProjectLanguages,
    can: ["owner", "remote"],
  },
  {
    op: "project.template.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ProjectTemplates,
    can: ["owner", "remote"],
  },
  {
    op: "project.activity.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ProjectActivity,
    can: ["owner", "remote"],
  },
  {
    op: "voice.moss.check",
    about: [],
    input: S.MossCheckRequest,
    result: S.Check,
    can: ["owner", "remote"],
  },
  {
    op: "voice.session.create",
    about: [],
    input: undefined,
    result: S.AgoraGrant,
    can: ["owner", "remote"],
  },
  {
    op: "voice.session.renew",
    about: [],
    input: S.RenewRequest,
    result: S.AgoraGrant,
    can: ["owner", "remote"],
  },
  {
    op: "voice.agent.start",
    about: [],
    input: S.StartRequest,
    result: S.VoiceAgent,
    can: ["owner", "remote"],
  },
  {
    op: "voice.agent.stop",
    about: [],
    input: S.VoiceAgent,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.agent.hear",
    about: [],
    input: S.VoiceHeard,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.agent.say",
    about: [],
    input: S.VoiceSaid,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.dictate",
    about: [],
    input: S.DictateRequest,
    result: S.Dictated,
    can: ["owner", "remote"],
  },
  {
    op: "connector.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.ConnectorStatus)),
    can: ["owner", "remote"],
  },
  {
    op: "connector.login",
    about: ["id"],
    input: input({ id: Schema.String }, S.ConnectorLogin),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.verify",
    about: ["id"],
    input: input({ id: Schema.String }, S.VerifyRequest),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.logout",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.channel.set",
    about: ["id"],
    input: input({ id: Schema.String }, S.ConnectorsChannelRequest),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "lan.get",
    about: [],
    input: undefined,
    result: S.LanStatus,
    can: ["owner"],
  },
  {
    op: "lan.update",
    about: [],
    input: S.SetOpenRequest,
    result: S.LanStatus,
    can: ["owner"],
  },
  {
    op: "lan.pairing.start",
    about: [],
    input: undefined,
    result: S.LanStatus,
    can: ["owner"],
  },
  {
    op: "lan.pairing.stop",
    about: [],
    input: undefined,
    result: S.LanStatus,
    can: ["owner"],
    dryRun: "lan.pairing.previewStop",
  },
  {
    op: "lan.pairing.previewStop",
    about: [],
    input: undefined,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "lan.pairing.answer",
    about: [],
    input: S.AnswerPairingRequest,
    result: S.LanStatus,
    can: ["owner"],
  },
  {
    op: "lan.device.delete",
    about: ["id"],
    input: lanDeviceDeleteInput,
    result: S.LanStatus,
    can: ["owner"],
    dryRun: "lan.device.previewDelete",
  },
  {
    op: "lan.device.previewDelete",
    about: ["id"],
    input: lanDeviceDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "lan.pair",
    about: [],
    input: S.LanPairRequest,
    result: S.LanPaired,
    can: ["owner", "remote"],
  },
  {
    op: "lan.me.get",
    about: [],
    input: undefined,
    result: S.LanDevice,
    can: ["owner", "remote"],
  },
  {
    op: "doc.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Document)),
    can: ["owner", "remote"],
  },
  {
    op: "doc.create",
    about: [],
    input: S.DocRequest,
    result: S.DocSnapshot,
    can: ["owner", "remote"],
  },
  {
    op: "doc.import",
    about: [],
    input: S.DocImport,
    result: S.DocSnapshot,
    can: ["owner", "remote"],
  },
  {
    op: "doc.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.DocSnapshot,
    can: ["owner", "remote", "session"],
  },
  {
    op: "doc.submit",
    about: ["id"],
    input: input({ id: Schema.String }, S.DocSubmit),
    result: S.DocAck,
    can: ["owner", "remote"],
  },
  {
    op: "doc.block.create",
    about: ["id"],
    input: input({ id: Schema.String }, S.DocBlockCreate),
    result: S.DocOpResult,
    can: ["owner", "remote", "session"],
  },
  {
    op: "doc.block.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.DocBlockUpdate),
    result: S.DocOpResult,
    can: ["owner", "remote", "session"],
  },
  {
    op: "doc.markdown.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.DocMarkdown,
    can: ["owner", "remote"],
  },
  {
    op: "doc.demo",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: undefined,
    can: ["owner"],
  },
];
