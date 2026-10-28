// The shapes the server and the page share: every type on the wire and on disk, and the closed sets' members. schema.ts
// holds a Schema for each, typed by it (Schema.Codec<T.X>), so the two cannot drift apart; api.ts the endpoints.

import type { Brand } from "effect";

/** An issue's id (not its number). */
export type IssueId = string & Brand.Brand<"IssueId">;
/** A session's id: w1, w2…, for the whole life of the farm. */
export type SessionId = string & Brand.Brand<"SessionId">;

/** The built-in orchestrator's profile id: it cannot be deleted or made a worker, so a farm always has an orchestrator, and
 * what names none goes to it (the phone, a task graph's news, a channel with no orchestrator of its own). */
export const defaultOrchestrator = "orchestrator";

/** The runtime of VibeValley's own agent: the only one an orchestrator runs on. */
export const orchestratorRuntime = "vibevalley";

/** The owner's participant id: who @主人 is. */
export const ownerId = "owner";

/** Who @所有人 is. */
export const everyone = "everyone";

/** The first channel, made default when the farm has none; then a name like any other, stored and in its address. */
export const firstChannelName = "general";

/** Sessions working at once; also the beds on the farm. */
export const maxRunning = 6;

/** Times are Unix milliseconds. */
export const dayMs = 86400000;

/** The voice line's first words when the settings have none of their own; the voice samples say it. */

/** An agent's memories past this go, the longest unused first. */
export const memoryKeep = 300;

/** Every endpoint is a POST at its op, named as in api.ts. */
export const pathOf = (op: string) => "/api/v1/" + op.replaceAll(".", "/");

/** The three long-lived streams; the client asks for them by path. */
export const statePath = "/api/v1/state";

export const eventsPath = "/api/v1/events";

export const livePath = "/api/v1/live";

/** A page's line to MOSS Live: a WebSocket the server relays to wss://api.mosi.cn/v1/realtime with the saved key. The
 * page speaks MOSS's protocol: JSON actions, and binary frames whose first byte is 0x00 for audio (16 kHz mono PCM up,
 * 48 kHz down). */
export const mossLinePath = "/api/v1/voice/moss/line";

/** The cookie a paired browser keeps its lan key in; the lan listener takes it as it takes the Bearer header. */
export const lanKeyCookie = "vibevalley_lan_key";

export const voiceSilenceMsMin = 200;

export const voiceSilenceMsMax = 2000;

export const voiceInterruptMsMin = 80;

export const voiceInterruptMsMax = 1000;

export const voiceIdleSecondsMin = 10;

export const voiceIdleSecondsMax = 600;

export const sessionSystemPrompt = "systemPrompt";

export const sessionAppendSystemPrompt = "appendSystemPrompt";

export const sessionEffort = "effort";

export const sessionEnv = "env";

export const sessionMcpServers = "mcpServers";

export const sessionDisallowedTools = "disallowedTools";

export const blockParagraph = "paragraph";

/** Attrs.Level 1 to 3. */
export const blockHeading = "heading";

export const blockBulleted = "bulleted";

/** Its number is not stored: the client counts the run of numbered siblings it is in. */
export const blockNumbered = "numbered";

/** Attrs.Checked. */
export const blockTodo = "todo";

export const blockQuote = "quote";

/** Attrs.Language; its text has no marks. */
export const blockCode = "code";

/** No text. */
export const blockDivider = "divider";

/** Attrs.Src, Width, Height, Alt; no text. */
export const blockImage = "image";

/** Attrs.IssueID; no text. */
export const blockIssueRef = "issue_ref";

/** Attrs.MemoryID, and text. */
export const blockMemoryItem = "memory_item";

/** Who wrote a block when the owner did; a helper's blocks carry its profile id. */
export const docOwner = "owner";

export interface ServerReady {
  url: string;
  pid: number;
}

/** What checking a form before saving it found: the first thing that would be refused, if any. */
export interface Check {
  problem?: string;
}

export interface RuntimeQuota {
  left?: number;
  text: string;
}

export const AgentIssueLevelValues = ["error", "warn"] as const;
export type AgentProblemLevel = (typeof AgentIssueLevelValues)[number];

export interface AgentProblem {
  field: string;
  level: AgentProblemLevel;
  text: string;
}

export interface AgentCheckRequest {
  agents: Agent[];
}

export interface AgentCheck {
  id: string;
  problems: AgentProblem[];
}

export interface RecallPreview {
  lines: string[];
  chars: number;
  limit: number;
}

export const AchievementCategoryValues = ["starter", "harvest", "craft", "thrift", "team", "secret"] as const;
export type AchievementCategory = (typeof AchievementCategoryValues)[number];

export interface AchievementDef {
  id: string;
  category: AchievementCategory;
  title: string;
  tierTitles?: string[];
  detail: string;
  tiers: number[];
  coins: number[];
  unit?: string;
}

export interface Achievement {
  id: string;
  category: AchievementCategory;
  title: string;
  detail: string;
  unit?: string;
  wearable: boolean;
  tiers: AchievementTier[];
}

export interface AchievementTier {
  need: number;
  title: string;
  coins: number;
  reached: string;
}

export interface AchievementStanding {
  id: string;
  tier: number;
  count: number;
  next?: number;
}

export interface RuntimePreset {
  id: string;
  label: string;
  blurb: string;
  look: Look;
}

export interface RuntimeFacts {
  steer: boolean;
  refused: Record<string, string>;
  capabilities: RuntimeCapability[];
  inProcess: boolean;
}

export const RuntimeCapabilityValues = ["listModels", "accountUsage", "checkUpdate", "upgrade", "skills", "mcpServers", "tools"] as const;
export type RuntimeCapability = (typeof RuntimeCapabilityValues)[number];

export const CallStateValues = ["idle", "connecting", "live", "ending", "error"] as const;
export type CallState = (typeof CallStateValues)[number];

export const OrchestratorStateValues = ["idle", "listening", "thinking", "speaking"] as const;
export type OrchestratorState = (typeof OrchestratorStateValues)[number];

/** Who did a thing, as it is kept: the owner, the orchestrator, a session (a helper at work), or the farm itself; also who said a message. */
export const ActorKindValues = ["owner", "orchestrator", "session", "system"] as const;
export type ActorKind = (typeof ActorKindValues)[number];

export const MessageKindValues = ["chat", "dispatch", "report", "notice"] as const;
export type MessageKind = (typeof MessageKindValues)[number];

export const OutcomeValues = ["completed", "failed", "interrupted"] as const;
export type Outcome = (typeof OutcomeValues)[number];

export interface Spent {
  tokens: number;
  cny?: number;
}

export interface ChatMessage {
  id: string;
  number: number;
  channel: string;
  from: string;
  fromKind: ActorKind;
  name: string;
  agent?: string;
  kind: MessageKind;
  text: string;
  mentions?: string[];
  session?: SessionId;
  run?: string;
  outcome?: Outcome;
  spent?: Spent;
  spoken?: boolean;
  /** The key the owner's send carried, on the owner's own messages: a page knows its line by it. */
  sendKey?: string;
  at: number;
  /** Its channel's revision when it was last written or changed: of two copies, the higher one is now. */
  revision: number;
  /** The number of the message in the same channel it answers. */
  replyTo?: number;
  /** When its words were last changed. */
  edited?: number;
  /** Deleted then: its words and attachments are gone, its number stays. */
  deleted?: number;
  pinned?: number;
  /** In the order they first came. */
  reactions?: Reaction[];
  attachments?: Attachment[];
  /** Previews of the links in its words, as the server read them. */
  embeds?: Embed[];
}

export interface Embed {
  url: string;
  title?: string;
  description?: string;
  site?: string;
  /** An image the page shows for it, at its own address on the web. */
  image?: string;
}

export const NotifyValues = ["all", "mentions", "none"] as const;
export type Notify = (typeof NotifyValues)[number];

export interface Reaction {
  emoji: string;
  /** Participants, in the order they reacted. */
  by: string[];
}

/** id is the sha256 of its bytes, served at attachmentPath. */
export interface Attachment {
  id: string;
  name: string;
  /** A media type: image/png, application/pdf… */
  type: string;
  size: number;
}

/** The one read that is not a POST, since an <img src> can only GET. */
export const attachmentPath = (id: string) => `/api/v1/attachment/${id}`;

export const ChannelTypeValues = ["channel", "direct", "thread"] as const;
export type ChannelType = (typeof ChannelTypeValues)[number];

export const SubjectKindValues = ["issue", "graph", "talk"] as const;
export type SubjectKind = (typeof SubjectKindValues)[number];

export interface Channel {
  id: string;
  type: ChannelType;
  /** The farm's default channel: what names no channel goes there (a connector's, a call's). One channel is. */
  default?: boolean;
  /** A direct channel's other participant: an orchestrator, or a helper profile. The owner talks with it there alone. */
  peer?: string;
  /** The orchestrator that looks after the place, by its profile id, as the server resolves it: a channel's own (the
   * default one when it has none), a thread's channel's, a direct channel's peer when that is an orchestrator. The
   * owner's words there go to it. */
  orchestrator?: string;
  /** A thread's channel. */
  parent?: string;
  /** A channel's group in the sidebar. */
  category?: string;
  /** Its place in the sidebar, lowest first; none comes after the placed. */
  position?: number;
  archived?: number;
  /** What of it counts for the owner; absent is all. */
  notify?: Notify;
  /** The message a thread hangs under, and its number there. */
  root?: string;
  rootNumber?: number;
  name?: string;
  description?: string;
  project?: string;
  subjectKind?: SubjectKind;
  subjectId?: string;
  lastNumber?: number;
  replies: number;
  read?: number;
  /** What the owner has not read here: others' messages past read, notices left out; absent when none. */
  unread?: number;
  /** A thread not on an issue or a task graph, by the server: a talk thread's session, else the head of the message it hangs under. */
  title?: string;
  /** The newest message, as a list shows it under the channel. */
  last?: ChannelLast;
  at: number;
}

/** A place a participant has not read all of, as channel.unread.list gives it to its caller. */
export interface ChannelUnread {
  /** Its address: #channel, #channel:n for a thread, @owner for the orchestrator's direct channel. */
  channel: string;
  unread: number;
  /** Something there names the caller. */
  mentionsYou: boolean;
  /** Who said the newest message there. */
  latest?: string;
}

export interface ChannelLast {
  from: string;
  name: string;
  /** Its head, on one line. */
  text: string;
  at: number;
}

export interface Conflict {
  base: string;
  files: string[];
}

export const SessionActionValues = [
  "run_command",
  "read_file",
  "edit_file",
  "search",
  "web",
  "mcp",
  "wait",
  "other",
  "thinking",
  "speaking_text",
  "none",
] as const;
export type SessionAction = (typeof SessionActionValues)[number];

export interface Doing {
  action: SessionAction;
  label: string;
  actionText?: string;
}

/** Told apart by `_tag`. */
export type Phase = PhaseArriving | PhaseWorking | PhaseDone | PhaseFailed | PhaseResting | PhaseClosed;

export interface LastRun {
  outcome: Outcome;
  summary: string;
  at: number;
  spent?: Spent;
  /** The conclusion it handed back in the block an answer issue asks for, when one could be read. */
  answer?: IssueAnswer;
}

export interface SessionGraph {
  id: string;
  task?: string;
}

export interface ActionStep {
  at: number;
  action: SessionAction;
  label: string;
  actionText?: string;
}

export interface SessionPlay {
  station: number;
  history: ActionStep[];
  toolsThisRun: number;
  counts: Record<string, number>;
  files: string[];
  commands: string[];
  runStartedAt?: number;
}

export interface Session {
  id: SessionId;
  name: string;
  agent: string;
  runtime: string;
  brief: string;
  project?: string;
  branch?: string;
  worktree?: string;
  conflict?: Conflict;
  hiredAt: number;
  runs: number;
  phase: Phase;
  lastRun?: LastRun;
  spent?: Spent;
  graph?: SessionGraph;
  channel?: string;
  play?: SessionPlay;
  issue?: IssueId;
  refining?: boolean;
  phaseText?: string;
}

export interface CommitCount {
  total: number;
  repos: Repo[];
}

export const GraphStateValues = ["splitting", "draft", "running", "paused", "ready", "done", "abandoned"] as const;
export type GraphState = (typeof GraphStateValues)[number];

export const TaskStateValues = ["waiting", "working", "merged", "failed", "skipped"] as const;
export type TaskState = (typeof TaskStateValues)[number];

export interface Task {
  id: string;
  title: string;
  brief: string;
  needs: string[];
  agent?: string;
  check?: string;
  scope?: string[];
  acceptance?: boolean;
  frozen?: string[];
  state: TaskState;
  session?: SessionId;
  conclusion?: string;
  commits?: string[];
  spent?: Spent;
  tries: number;
  failures?: number;
  blockedBy?: string[];
  stateText?: string;
  actions?: TaskAction[];
  actionText?: Record<string, string>;
  canEdit?: boolean;
  canRemove?: boolean;
}

export interface TaskGraph {
  id: string;
  title: string;
  goal: string;
  project: string;
  branch?: string;
  state: GraphState;
  stateTag?: string;
  actionText?: Record<string, string>;
  actions?: GraphAction[];
  tasks: Task[];
  parallel: number;
  note?: string;
  createdAt: number;
  layers?: string[][];
  asksForYou?: boolean;
  spent?: Spent;
  settled?: number;
}

export interface Unlock {
  id: string;
  tier: number;
  at: number;
}

export interface AgentTally {
  hired: number;
  harvested: number;
  failed: number;
}

export interface Progress {
  coins: number;
  streak: number;
  bestStreak: number;
  counts: Record<string, number>;
  unlocked: Unlock[];
  title?: ProgressTitle;
  agents?: Record<string, AgentTally>;
  multiplier?: number;
}

export interface ProgressNews {
  coins?: number;
  session?: SessionId;
  unlocked?: Unlock[];
}

/** Told apart by `kind`. */
export type RecurrenceWhen = RecurrenceWhenOnce | RecurrenceWhenEvery | RecurrenceWhenDaily | RecurrenceWhenWeekly | RecurrenceWhenCron;

export interface Recurrence {
  id: string;
  name: string;
  text: string;
  channel: string;
  agent?: string;
  project?: string;
  when: RecurrenceWhen;
  tz: string;
  enabled: boolean;
  created: number;
  lastRun?: number;
  by: ActorKind;
  pending?: boolean;
  whenText?: string;
  nextText?: string;
}

export interface OwnerMention {
  message: ChatMessage;
  channel: string;
  address: string;
}

/** The channels, not what is said in them: a page follows a channel for that (rpc.ts). */
export interface Chat {
  channels: Channel[];
  ownerMentions?: OwnerMention[];
}

/** What a channel's follower gets: each message said there, by its number; Reset when it is too far behind to catch up. */
export type ChannelEvent = ChannelMessage | ChannelReset;

export interface ChannelMessage {
  _tag: "Message";
  message: ChatMessage;
}

export interface ChannelReset {
  _tag: "Reset";
}

export interface WorkspaceState {
  call: CallState;
  callReason?: string;
  /** Each orchestrator not at rest, by its profile id, as its last orchestrator fact says; one not here is idle. */
  orchestrators?: Record<string, OrchestratorNow>;
  sessions: Session[];
  chat?: Chat;
  commits?: CommitCount;
  progress?: Progress;
  recurrences?: Recurrence[];
  issues?: Issue[];
  /** Each chat app's status, as the connectors say it whenever it changes; their home is the connectors, not state.json. */
  connectors?: ConnectorStatus[];
}

export const SessionEventTypeValues = [
  "run/start",
  "user/message",
  "memory/recalled",
  "assistant/thinking",
  "assistant/message",
  "tool/call",
  "tool/result",
  "llm/retry",
  "llm/usage",
  "run/error",
  "run/end",
] as const;
export type SessionEventType = (typeof SessionEventTypeValues)[number];

export const ToolActionValues = ["run_command", "read_file", "edit_file", "search", "web", "mcp", "wait", "other"] as const;
export type ToolAction = (typeof ToolActionValues)[number];

export interface SessionEvent {
  seq: number;
  /** Increases when this step's streaming text or input changes; independent of transport delivery order. */
  revision: number;
  time: number;
  type: SessionEventType;
  run?: string;
  call?: number;
  under?: number;
  text: string;
  action?: ToolAction;
  actionText?: string;
  tool?: string;
  input?: string;
  output?: string;
  ok?: boolean;
  tokens?: EventTokens;
}

export interface EventTokens {
  input: number;
  cacheRead: number;
  output: number;
}

export const NoticeLevelValues = ["info", "warn", "error"] as const;
export type NoticeLevel = (typeof NoticeLevelValues)[number];

/** Told apart by `status`. */
export type Installation = InstallationAvailable | InstallationNotFound | InstallationChecking | InstallationUnsupported;

export interface ModelEntry {
  id: string;
  name: string;
  effortLevels: string[];
  isDefault: boolean;
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface Balance {
  currency: string;
  amount: number;
}

/** Told apart by `status`. */
export type AccountUsage = AccountUsageOk | AccountUsageBalance | AccountUsageLoginRequired | AccountUsageUnavailable;

export interface InventoryEntry {
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
}

export interface RuntimeSettings {
  enabled: boolean;
  binPath: string;
  defaultModel: string;
  defaultEffort: string;
  env: Record<string, string>;
  dailyBudget?: number;
  maxWorking?: number;
}

export interface RuntimeInfo {
  id: string;
  preset: RuntimePreset;
  facts: RuntimeFacts;
  installation: Installation;
  models: ModelEntry[] | null;
  usage: AccountUsage | null;
  skills: InventoryEntry[] | null;
  mcpServers: InventoryEntry[] | null;
  tools: InventoryEntry[] | null;
  settings: RuntimeSettings;
  spentToday?: number;
  quota?: RuntimeQuota;
  stop?: string;
  checkedAt: number;
}

export interface FarmLevel {
  level: number;
  xp: number;
  need: number;
}

export const InboxKindValues = [
  "review",
  "ask",
  "fix",
  "interrupted",
  "conflict",
  "quiet",
  "graph-draft",
  "graph-ready",
  "task-failed",
  "mention",
  "recurrence-ask",
] as const;
export type InboxKind = (typeof InboxKindValues)[number];

/** Told apart by `kind`. */
export type InboxFrom = InboxFromSession | InboxFromOrchestrator;

/** Told apart by `kind`. */
export type InboxTarget = InboxTargetSession | InboxTargetGraph | InboxTargetChat;

/** What an item says on each route the owner hears it on: the phone's label after who, the system notice, the tray's
 * line (none for a mention: it is counted with the unread). */
export interface InboxWords {
  label: string;
  title: string;
  body: string;
  tray?: string;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  from: InboxFrom;
  /** Who it is from, as the routes say it: the helper's name, or 管家. */
  who: string;
  text: string;
  at: number;
  target: InboxTarget;
  words: InboxWords;
}

export const CropValues = ["empty", "seeded", "sprout", "leafy", "flowering", "wheat", "carrot", "withered", "weeds", "dry", "harvested", "locked"] as const;
export type Crop = (typeof CropValues)[number];

export const BadgeToneValues = ["ripe", "bug", "stuck", "rest", "wait"] as const;
export type BadgeTone = (typeof BadgeToneValues)[number];

export interface PlotView {
  crop: Crop;
  badge?: Badge;
}

export interface FarmView {
  level: FarmLevel;
  /** Each session's plot, by the session's id. */
  plots: Record<string, PlotView>;
  achievements: AchievementStanding[];
}

/** Told apart by `kind`. */
export type GameEffect = GameEffectReward | GameEffectPenalty | GameEffectLevelUp | GameEffectAchievement;

export interface StateFrame {
  state: WorkspaceState;
  inbox: InboxItem[];
  graphs: TaskGraph[];
  view: FarmView;
  effects: GameEffect[];
}

/** Told apart by `kind`. */
export type LedgerEntry =
  | LedgerEntryHarvested
  | LedgerEntryFailed
  | LedgerEntryConflicted
  | LedgerEntryTold
  | LedgerEntryReviewed
  | LedgerEntryGraph
  | LedgerEntryHandoff
  | LedgerEntryCalled
  | LedgerEntryHired
  | LedgerEntryMoment
  | LedgerEntryLevel
  | LedgerEntryTitled;

export const GraphEventKindValues = [
  "splitting",
  "drafted",
  "started",
  "paused",
  "resumed",
  "ready",
  "merged",
  "abandoned",
  "noted",
  "task_started",
  "task_sent_back",
  "task_merged",
  "task_failed",
  "task_retried",
  "task_requeued",
  "task_skipped",
  "task_edited",
  "task_added",
  "task_removed",
] as const;
export type GraphEventKind = (typeof GraphEventKindValues)[number];

export interface TaskFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface GraphEvent {
  id: string;
  graph: string;
  task?: string;
  kind: GraphEventKind;
  actor: ActorKind;
  session?: SessionId;
  detail?: string;
  changes?: TaskFieldChange[];
  commits?: string[];
  at: number;
  text?: string;
  actorText?: string;
}

export interface LanDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen?: number;
}

export interface LanPaired {
  device: string;
  key: string;
  hostName: string;
}

export interface LanPairRequest {
  code: string;
  name: string;
}

export interface LanStatus {
  open: boolean;
  hostName: string;
  url?: string;
  problem?: string;
  pairing?: LanPairing;
  devices: LanDevice[];
}

export interface LanPairing {
  code: string;
  link: string;
  expiresAt: number;
  asking?: string;
}

export interface ConnectorStatus {
  id: ConnectorID;
  state: ConnectorState;
  qr?: string;
  pairCode?: string;
  channel?: string;
  owner?: string;
  since?: number;
  lastInbound?: number;
  pausedUntil?: number;
  pending: number;
  error?: string;
}

export const ConnectorStateValues = ["off", "waiting", "scanned", "verify", "pairing", "connected", "paused"] as const;
export type ConnectorState = (typeof ConnectorStateValues)[number];

export interface ConnectorLogin {
  force?: boolean;
  appId?: string;
  secret?: string;
}

export interface VoiceAgent {
  agentId: string;
}

export interface AgoraGrant {
  appId: string;
  channel: string;
  uid: string;
  token: string;
}

export interface ProjectActivity {
  project: string;
  at: number;
  days: DayCount[];
  authors: Author[];
  total: number;
  first?: number;
  last?: number;
}

export interface DayCount {
  day: string;
  commits: number;
}

export interface ProjectLanguages {
  project: string;
  at: number;
  languages: LanguageCount[];
}

export interface ProjectTemplates {
  project: string;
  stack: ProjectStack;
  recent: string[];
  kinds: TemplateKind[];
}

export interface ProjectStack {
  name: string;
  label: string;
  test?: string;
  lint?: string;
  build?: string;
}

export interface TemplateKind {
  id: string;
  name: string;
  icon: string;
  templates: IssueTemplate[];
}

export interface IssueTemplate {
  id: string;
  title: string;
  done: string;
  text: string;
  blank?: TemplateBlank;
}

export interface TemplateBlank {
  start: number;
  end: number;
}

export interface LanguageCount {
  name: string;
  files: number;
  code: number;
  comments: number;
  blanks: number;
}

export interface GitHubStatus {
  installed: boolean;
  /** gh's version, when it says one. */
  version?: string;
  loggedIn: boolean;
  /** The logged-in account, when logged in. */
  account?: string;
  /** Why it is not usable, when it is not. */
  reason?: string;
  checkedAt: number;
}

export interface PullRequestCapability {
  available: boolean;
  reason: string;
}

export interface ProjectSummary {
  name: string;
  path: string;
  git: boolean;
  last?: number;
  maxSessions: number;
  pullRequest: PullRequestCapability;
}

export interface NewProject {
  name: string;
  github?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
}

export interface OrchestratorEvalRequest {
  /** The orchestrator whose log it is, by its profile id; the default one when none is given. */
  agent?: string;
  on: number;
  want: string;
}

export interface OrchestratorEval {
  id: string;
  file: string;
}

export interface ArchiveListing {
  files: ArchiveFile[];
  hits: ArchiveHit[];
}

export interface ArchiveHit {
  file: string;
  line: number;
  text: string;
}

export interface ArchiveFile {
  name: string;
  at: number;
  chars: number;
}

export interface Memory {
  id: string;
  agent: string;
  kind: MemoryKind;
  text: string;
  author?: ActorKind;
  project?: string;
  session?: SessionId;
  at: number;
  recalled: number;
  recalledAt?: number;
  fading?: boolean;
  source?: string;
}

export const MemoryKindValues = ["note", "issue"] as const;
export type MemoryKind = (typeof MemoryKindValues)[number];

export interface MemoryRequest {
  text: string;
  project?: string;
}

/** Where a memory holds: for every project, one project, or a source that does not say. */
export type MemoryScope = { kind: "global" } | { kind: "project"; project: string } | { kind: "unknown" };

/** A memory a search found, with the source it came from and how well it matched. */
export interface MemoryFound extends Memory {
  source: string;
  score: number;
  scope: MemoryScope;
}

export interface MemorySearch {
  found: MemoryFound[];
  /** The sources asked, as each says it covered the search. */
  coverage: string[];
}

export interface MemoryList {
  memories: Memory[];
  sources: MemorySourceInfo[];
  file?: string;
  carried?: number;
}

export interface MemorySourceInfo {
  name: string;
  label: string;
  on: boolean;
  off?: string;
  canList: boolean;
  canForget: boolean;
  transcripts: boolean;
}

/** What a profile is: an orchestrator (管家) stays, leads and does no work itself; a worker (帮工) is sent on an issue. */
export const AgentRoleValues = ["orchestrator", "worker"] as const;
export type AgentRole = (typeof AgentRoleValues)[number];

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  /** What it does, in a sentence (职责): orchestrators read it to pick who takes a job. */
  duty: string;
  enabled: boolean;
  runtime: string;
  model: string;
  effort: string;
  persona: string;
  personaMode: PersonaMode;
  skills: string[];
  mcpServers: MCPServer[];
  disallowedTools: string[];
  env: Record<string, string>;
  workdir: string;
  worktree: boolean;
  tags: string[];
  look: Look;
  /** The template it was installed from, at that template's version; none for one made by hand. */
  from?: AgentFrom;
}

/** Where a profile came from: a template's id and the version it had then. */
export interface AgentFrom {
  template: string;
  version: number;
}

/** Built in: shipped with VibeValley; added: copied in from a folder on this machine. */
export const AgentTemplateSourceValues = ["builtIn", "added"] as const;
export type AgentTemplateSource = (typeof AgentTemplateSourceValues)[number];

/** A recipe for a profile (agent.json and persona.md in a folder), in the farm's language: installing it makes a profile.
 * An orchestrator's always runs on VibeValley's own agent. */
export interface AgentTemplate {
  id: string;
  /** Raised when the template changes: a profile installed at a lower one has an update. */
  version: number;
  role: AgentRole;
  name: string;
  duty: string;
  tags: string[];
  /** The runtime it is written for. */
  runtime: string;
  model: string;
  effort: string;
  personaMode: PersonaMode;
  worktree: boolean;
  look: Look;
  persona: string;
  source: AgentTemplateSource;
  /** The profiles installed from it, by id. */
  installed: string[];
}

export interface Look {
  species?: Species;
  outfit?: Outfit;
  /** An orchestrator's look: its sprites are manager-<look>, the plain one is farmer. A worker has none. */
  orchestrator?: OrchestratorLook;
  build: Build;
  head: Head;
  body: string;
  trim: string;
  hat: string;
  eye: string;
}

export const HeadValues = ["rounded", "terminal", "dome", "orb", "saucer"] as const;
export type Head = (typeof HeadValues)[number];

export const BuildValues = ["biped", "treads", "wheel", "hopper", "hover"] as const;
export type Build = (typeof BuildValues)[number];

export const OrchestratorLookValues = ["farmer", "foreman", "auntie", "grandpa", "gardener", "robot"] as const;
export type OrchestratorLook = (typeof OrchestratorLookValues)[number];

export const OutfitValues = ["farmer", "gardener", "rain", "winter"] as const;
export type Outfit = (typeof OutfitValues)[number];

export const SpeciesValues = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"] as const;
export type Species = (typeof SpeciesValues)[number];

export const PersonaModeValues = ["append", "replace", "prompt"] as const;
export type PersonaMode = (typeof PersonaModeValues)[number];

export interface Changes {
  project: string;
  base: string;
  branch?: string;
  commits: Commit[];
  files: ChangedFile[];
  uncommitted: UncommittedItem[];
  conflicts: string[];
  behind: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  patch?: string;
}

export const TaskActionValues = ["retry", "skip"] as const;
export type TaskAction = (typeof TaskActionValues)[number];

export const GraphActionValues = ["start", "pause", "resume", "abandon", "merge"] as const;
export type GraphAction = (typeof GraphActionValues)[number];

export interface TaskEdit {
  title?: string;
  brief?: string;
  needs?: string[];
  agent?: string;
  check?: string;
  scope?: string[];
}

export interface GraphSplitRequest {
  goal: string;
  project: string;
  agent?: string;
}

export interface Dispatched {
  session?: SessionId;
  queued?: string;
}

export interface IssueHistory {
  issue: Issue;
  sessions: Session[];
  missingSessions: SessionId[];
}

export const PullRequestStateValues = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PullRequestStateValues)[number];

export interface PullRequest {
  url: string;
  number: number;
  state: PullRequestState;
}

export interface Issue {
  id: IssueId;
  number: number;
  title: string;
  description?: string;
  project?: string;
  assignee?: string;
  priority: Priority;
  rank?: number;
  createdAt: number;
  queuedAt?: number;
  sessions: SessionId[];
  closedAt?: number;
  /** Done: what it delivered. Its verdict is the status; how its work went in is this. */
  delivered?: Delivery;
  /** Canceled: why. */
  canceled?: IssueCanceled;
  parent?: IssueId;
  blockedBy?: string[];
  graph?: IssueGraph;
  task?: IssueTask;
  recurrence?: string;
  status: IssueStatus;
  moves: IssueStatus[];
  pullRequest?: PullRequest;
  deliver: Deliverable;
  /** A helper profile's talk with the owner: the direct channel it is said in. It is kept off the board. */
  talk?: string;
  reviewedAt?: number;
  findings: Finding[];
  questions: Question[];
  criteria?: string[];
  checks?: CriterionCheck[];
  refining?: IssueRefining;
  /** Its latest run as the issue keeps it, for a run no session on the farm carries (an in-process agent's, the
   * orchestrator's): going on while it has no end; ended, the issue waits on the owner. */
  lastRun?: IssueRun;
  /** An answer issue's conclusion, read from what its latest round handed back; none when that round gave none it could read. */
  answer?: IssueAnswer;
  attention: IssueAttention;
}

/** What an answer issue concludes, as its helper hands it back: the conclusion, what it rests on (files and lines, commands
 * and what they printed), what it is unsure of, and what to do next. */
export interface IssueAnswer {
  conclusion: string;
  evidence: string[];
  unsure: string[];
  next: string[];
}

/** What a command that changes things would do, as its dry run answers it (an endpoint's `dryRun`): nothing was changed. */
export interface Preview {
  /** What it would do, in order, one step a line. */
  does: string[];
}

export interface IssueRun {
  startedAt: number;
  endedAt?: number;
  outcome?: Outcome;
}

/** A question the helper is waiting on the owner for; options are the answers it thought of, each one a reply as it is. */
export interface Question {
  question: string;
  options?: string[];
}

export const CheckResultValues = ["met", "unmet", "unsure"] as const;
export type CheckResult = (typeof CheckResultValues)[number];

/** The helper's own word on one of the criteria, as it handed the work back: criterion is its index in Issue.criteria. */
export interface CriterionCheck {
  criterion: number;
  result: CheckResult;
  proof?: string;
}

/** Where an issue stands for the owner, the one set of states the board, the farm and the page all say. */
export const AttentionValues = ["draft", "queued", "working", "asking", "reviewing", "stuck", "done", "canceled"] as const;
export type Attention = (typeof AttentionValues)[number];

export const StuckReasonValues = ["failed", "conflict", "interrupted", "quiet"] as const;
export type StuckReason = (typeof StuckReasonValues)[number];

/** A button on an issue's page, by what it says. tell is a word to the helper, answer the same to its question; reject
 * sends it back with findings; acknowledge takes what an answer issue found as done; cure, resolve and resume send it
 * back with the server's own words for why it stopped. */
export const IssueActValues = ["start", "answer", "reject", "complete", "acknowledge", "resolve", "resume", "cure", "tell", "stop", "close", "reopen"] as const;
export type IssueAct = (typeof IssueActValues)[number];

/** since: when it came to stand so, when known. lead is the one thing the owner is asked to do, if any; acts are all
 * it can do, lead first. */
export interface IssueAttention {
  state: Attention;
  since?: number;
  stuck?: StuckReason;
  lead?: IssueAct;
  acts: IssueAction[];
}

/** What pressing an issue's button sends: move is issue.status.update, say issue.comment.create, stop session.stop. */
export type IssueAction =
  | { readonly act: IssueAct; readonly does: "move"; readonly status: IssueStatus; readonly words: ActWords }
  | { readonly act: IssueAct; readonly does: "say" }
  | { readonly act: IssueAct; readonly does: "stop" };

export const ActWordsValues = ["none", "optional", "required"] as const;
export type ActWords = (typeof ActWordsValues)[number];

export const MilestoneKindValues = [
  "opened",
  "refined",
  "started",
  "reported",
  "asked",
  "told",
  "failed",
  "stopped",
  "rejected",
  "accepted",
  "closed",
] as const;
export type MilestoneKind = (typeof MilestoneKindValues)[number];

/** One line of an issue's story; who is the session's name, or absent for the owner and the farm. */
export interface Milestone {
  at: number;
  kind: MilestoneKind;
  who?: string;
  text: string;
}

/** An issue's story newest first, and what all its runs cost. */
export interface IssueTimeline {
  milestones: Milestone[];
  spent?: Spent;
}

export interface IssueRefining {
  session: SessionId;
  name: string;
}

export interface IssueRefineRequest {
  text?: string;
  /** Fields the owner changed and has not saved: saved first, so the act sees them. */
  edit?: IssueUpdate;
}

export interface IssueGraph {
  state: GraphState;
  branch?: string;
  parallel: number;
  note?: string;
}

export interface IssueTask {
  key: string;
  state: TaskState;
  check?: string;
  scope?: string[];
  acceptance?: boolean;
  frozen?: string[];
  session?: SessionId;
  conclusion?: string;
  commits?: string[];
  spent?: Spent;
  tries: number;
  failures?: number;
}

export const IssueStatusValues = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type IssueStatus = (typeof IssueStatusValues)[number];

export const PriorityValues = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PriorityValues)[number];

export interface IssueUpdate {
  title?: string;
  description?: string;
  project?: string;
  assignee?: string;
  priority?: Priority;
  criteria?: string[];
  deliver?: Deliverable;
  /** Its place on the board: before this issue, or last when empty. Only while it is not sent. */
  before?: string;
}

export interface Finding {
  id: string;
  text: string;
  at: number;
  /** Settled: the next acceptance that passed after it was written. */
  resolved?: boolean;
}

export interface IssueRequest {
  title: string;
  description?: string;
  project?: string;
  assignee?: string;
  priority?: Priority;
  deliver?: Deliverable;
}

/** What an issue delivers: a change (its branch, merged into the project or by a pull request), a change kept on its
 * branch for the owner to take in, or an answer (on the issue). Its helper does the same work for change and branch. */
export const DeliverableValues = ["change", "branch", "answer"] as const;
export type Deliverable = (typeof DeliverableValues)[number];

/** What a completed issue delivered: its branch merged into the project's main branch, into its parent's branch (a step of
 * a task graph), by a pull request, its branch kept unmerged, or nothing (no change, or an answer). */
export const DeliveryValues = ["merged", "merged_into_parent", "pull_request", "kept", "none"] as const;
export type Delivery = (typeof DeliveryValues)[number];

/** Why an issue is not done: the owner closed it, or its workplace was lost. */
export const IssueCanceledValues = ["dismissed", "lost"] as const;
export type IssueCanceled = (typeof IssueCanceledValues)[number];

/** How a session left: its work merged into the main branch, its issue completed otherwise (what it delivered is the
 * issue's: a kept branch, nothing, a task graph's branch), sent home, or its workplace lost. */
export const SessionCloseValues = ["merged", "completed", "dismissed", "lost"] as const;
export type SessionClose = (typeof SessionCloseValues)[number];

export const RunTriggerKindValues = ["issue", "comment", "task", "recurrence", "refine", "runtime"] as const;
export type RunTriggerKind = (typeof RunTriggerKindValues)[number];

export interface RunTrigger {
  kind: RunTriggerKind;
  message?: string;
  recurrence?: string;
  missed?: boolean;
}

export interface Run {
  id: string;
  session: SessionId;
  issue?: IssueId;
  triggeredBy: RunTrigger;
  heard: string[];
  startedAt: number;
  endedAt?: number;
  outcome?: Outcome;
  summary?: string;
  spent?: Spent;
}

export interface CommentRequest {
  text: string;
  sendKey?: string;
}

export interface SayRequest {
  /** The channel it is said in. */
  id: string;
  text: string;
  /** The number of the message there it answers. */
  replyTo?: number;
  /** Ids from channel.attachment.create. */
  attachments?: string[];
  station?: number;
  agent?: string;
  project?: string;
  sendKey?: string;
}

export interface ChannelUpdate {
  description?: string;
  project?: string;
  /** A channel's name (unique, written in its address), or a thread's title. */
  name?: string;
  /** A channel's group; empty takes it out of one. */
  category?: string;
  /** Placed before this channel in the sidebar; empty is last. */
  before?: string;
  /** The orchestrator that looks after the channel, by its profile id; empty is the default one. */
  orchestrator?: string;
}

export interface RecurrenceRequest {
  name: string;
  text: string;
  channel?: string;
  agent?: string;
  project?: string;
  when: RecurrenceWhen;
  tz?: string;
}

export interface ChannelRequest {
  name: string;
  description?: string;
  project?: string;
}

/** The language the farm speaks to the owner in (words/locale.ts). */
import { type Locale } from "@vibevalley/i18n";

export { LocaleValues, type Locale } from "@vibevalley/i18n";

export interface SettingsStatus {
  file: string;
  /** The farm's home ($VIBEVALLEY_HOME) and the server's version, for 关于. */
  home: string;
  version: string;
  locale: Locale;
  deepseekApiKey: KeyStatus;
  agoraAppId: AgoraAppID;
  agoraAppCertificate: KeyStatus;
  voice: VoiceSettings;
  voiceDefaults: VoiceSettings;
  asrKey: KeyStatus;
  llmKey: KeyStatus;
  ttsKey: KeyStatus;
  dictation: Dictation;
  dictationKey: KeyStatus;
  /** MOSS Live (wss://api.mosi.cn/v1/realtime): a realtime voice model the server connects to. */
  mossKey: KeyStatus;
  memorySources: MemorySource[];
}

export interface MemorySource {
  kind: MemorySourceKind;
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  everything?: boolean;
  user?: string;
  key: KeyStatus;
}

export const MemorySourceKindValues = ["nowledge", "everos"] as const;
export type MemorySourceKind = (typeof MemorySourceKindValues)[number];

export interface MemorySourceUpdate {
  kind: MemorySourceKind;
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  everything?: boolean;
  user?: string;
  key?: string;
}

export interface Dictation {
  url: string;
  model: string;
}

export interface KeyStatus {
  source?: KeySource;
  hint?: string;
}

export const KeySourceValues = ["settings", "config"] as const;
export type KeySource = (typeof KeySourceValues)[number];

export interface VoiceSettings {
  area: Area;
  language: Language;
  asr: VoiceASR;
  answer: VoiceAnswer;
  tts: VoiceTTS;
  persona: string;
  greeting: string;
  failureMessage: string;
  silenceMs: number;
  interruptMs: number;
  idleSeconds: number;
}

export interface SettingsUpdate {
  locale?: Locale;
  deepseekApiKey?: string;
  agoraAppId?: string;
  agoraAppCertificate?: string;
  voice?: SettingsUpdateVoice;
  asrKey?: string;
  llmKey?: string;
  ttsKey?: string;
  dictation?: Dictation;
  dictationKey?: string;
  mossKey?: string;
  memorySources?: MemorySourceUpdate[];
}

/** A MOSS Live key to try; the saved one when absent. */
export interface MossCheckRequest {
  key?: string;
}

export interface Health {
  ok: boolean;
  version: string;
}

export interface PhaseArriving {
  _tag: "arriving";
}

export interface Retry {
  attempt: number;
  of?: number;
}

export interface PhaseWorking {
  _tag: "working";
  since: number;
  doing: Doing;
  quietSince?: number;
  retry?: Retry;
}

export interface PhaseDone {
  _tag: "done";
}

export interface PhaseFailed {
  _tag: "failed";
}

export interface PhaseResting {
  _tag: "resting";
}

export interface PhaseClosed {
  _tag: "closed";
  at: number;
  closed: SessionClose;
}

export interface Repo {
  path: string;
  commits: number;
}

export interface ProgressTitle {
  id: string;
  tier: number;
}

export interface RecurrenceWhenOnce {
  kind: "once";
  at: number;
}

export interface RecurrenceWhenEvery {
  kind: "every";
  minutes: number;
}

export interface RecurrenceWhenDaily {
  kind: "daily";
  time: string;
}

export interface RecurrenceWhenWeekly {
  kind: "weekly";
  days: number[];
  time: string;
}

export interface RecurrenceWhenCron {
  kind: "cron";
  expr: string;
}

export const ViaValues = ["executable", "bundled"] as const;
export type Via = (typeof ViaValues)[number];

export interface InstallationAvailable {
  status: "available";
  via: Via;
  command: string;
  version: string | null;
}

export interface InstallationNotFound {
  status: "not_found";
}

export interface InstallationChecking {
  status: "checking";
}

export interface InstallationUnsupported {
  status: "unsupported";
  reason: string;
}

export interface AccountUsageOk {
  status: "ok";
  subscription: string | null;
  windows: UsageWindow[];
}

export interface AccountUsageBalance {
  status: "balance";
  provider: string;
  available: boolean;
  balances: Balance[];
}

export interface AccountUsageLoginRequired {
  status: "login_required";
}

export interface AccountUsageUnavailable {
  status: "unavailable";
  reason: string;
}

export interface InboxFromSession {
  kind: "session";
  id: string;
  name: string;
  agent: string;
}

export interface InboxFromOrchestrator {
  kind: "orchestrator";
}

export interface InboxTargetSession {
  kind: "session";
  id: string;
}

export interface InboxTargetGraph {
  kind: "graph";
  graph: string;
}

export interface InboxTargetChat {
  kind: "chat";
  channel: string;
}

export interface Badge {
  text: string;
  tone: BadgeTone;
}

export interface GameEffectReward {
  kind: "reward";
  /** The session whose work paid; none for a reward of the farm as a whole. */
  sessionId?: SessionId;
  coins: number;
  streak: number;
}

export interface GameEffectPenalty {
  kind: "penalty";
  sessionId: SessionId;
}

export interface GameEffectLevelUp {
  kind: "levelUp";
  level: number;
}

export interface GameEffectAchievement {
  kind: "achievement";
  achievement: string;
  tier: number;
  title: string;
  reached: string;
  detail: string;
  coins: number;
  oneOff?: boolean;
}

export interface LedgerEntryHarvested {
  kind: "harvested";
  at: number;
  session: SessionId;
  agent?: string;
  project: string;
  runtime: string;
  commits: number;
  cny?: number;
  runs: number;
}

export interface LedgerEntryFailed {
  kind: "failed";
  at: number;
  session: SessionId;
  agent?: string;
}

export interface LedgerEntryConflicted {
  kind: "conflicted";
  at: number;
  session: SessionId;
}

export interface LedgerEntryTold {
  kind: "told";
  at: number;
  session: SessionId;
}

export interface LedgerEntryReviewed {
  kind: "reviewed";
  at: number;
  session: SessionId;
}

export interface LedgerEntryGraph {
  kind: "graph";
  at: number;
  graph: string;
  merged: number;
  parallel: boolean;
}

export interface LedgerEntryHandoff {
  kind: "handoff";
  at: number;
  session: SessionId;
  to: string;
}

export interface LedgerEntryCalled {
  kind: "called";
  at: number;
  session: SessionId;
}

export interface LedgerEntryHired {
  kind: "hired";
  at: number;
  session: SessionId;
  agent?: string;
}

export const LedgerEntryMomentKindValues = ["opened", "split", "voice", "busy6"] as const;
export type LedgerEntryMomentKind = (typeof LedgerEntryMomentKindValues)[number];

export interface LedgerEntryMoment {
  kind: LedgerEntryMomentKind;
  at: number;
}

export interface LedgerEntryLevel {
  kind: "level";
  at: number;
  level: number;
}

export interface LedgerEntryTitled {
  kind: "titled";
  at: number;
  achievement?: string;
  tier?: number;
}

export const ConnectorIDValues = ["weixin", "feishu", "qq"] as const;
export type ConnectorID = (typeof ConnectorIDValues)[number];

export interface Author {
  name: string;
  commits: number;
}

/** Told apart by `type`. */
export type MCPServer = MCPServerStdio | MCPServerHTTP;

export interface MCPServerStdio {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface MCPServerHTTP {
  type: "http";
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface Commit {
  hash: string;
  subject: string;
  at: number;
}

export interface UncommittedItem {
  path: string;
  status: string;
}

export interface AgoraAppID {
  source?: KeySource;
  value?: string;
}

export const AreaValues = ["US", "EU", "AP", "CN"] as const;
export type Area = (typeof AreaValues)[number];

export const LanguageValues = ["zh-CN", "zh-HK", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
export type Language = (typeof LanguageValues)[number];

/** Told apart by `vendor`. */
export type VoiceASR = VoiceASRAres | VoiceASRDeepgram | VoiceASRMicrosoft;

export interface VoiceASRAres {
  vendor: "ares";
}

export const ModelValues = ["nova-2", "nova-3"] as const;
export type Model = (typeof ModelValues)[number];

export interface VoiceASRDeepgram {
  vendor: "deepgram";
  model: Model;
}

export interface VoiceASRMicrosoft {
  vendor: "microsoft";
  region: string;
}

/** Told apart by `vendor`. */
export type VoiceAnswer = VoiceAnswerOrchestrator | VoiceAnswerAgora | VoiceAnswerDeepseek | VoiceAnswerOpenai;

export interface VoiceAnswerOrchestrator {
  vendor: "orchestrator";
}

export const VoiceAnswerAgoraModelValues = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-nano", "gpt-5-mini"] as const;
export type VoiceAnswerAgoraModel = (typeof VoiceAnswerAgoraModelValues)[number];

export interface VoiceAnswerAgora {
  vendor: "agora";
  model: VoiceAnswerAgoraModel;
}

export interface VoiceAnswerDeepseek {
  vendor: "deepseek";
  model: string;
}

export interface VoiceAnswerOpenai {
  vendor: "openai";
  url: string;
  model: string;
}

/** Told apart by `vendor`. */
export type VoiceTTS = VoiceTTSMinimax | VoiceTTSOpenai | VoiceTTSMicrosoft;

export const VoiceTTSMinimaxModelValues = ["speech_2_6_turbo", "speech_2_8_turbo"] as const;
export type VoiceTTSMinimaxModel = (typeof VoiceTTSMinimaxModelValues)[number];

export interface VoiceTTSMinimax {
  vendor: "minimax";
  model: VoiceTTSMinimaxModel;
  voiceId: string;
}

export const VoiceValues = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type Voice = (typeof VoiceValues)[number];

export interface VoiceTTSOpenai {
  vendor: "openai";
  voice: Voice;
}

export interface VoiceTTSMicrosoft {
  vendor: "microsoft";
  region: string;
  voiceName: string;
}

export interface SettingsUpdateVoice {
  area?: Area;
  language?: Language;
  asr?: VoiceASR;
  answer?: VoiceAnswer;
  tts?: VoiceTTS;
  persona?: string;
  greeting?: string;
  failureMessage?: string;
  silenceMs?: number;
  interruptMs?: number;
  idleSeconds?: number;
}

export interface Roots {
  fact: Fact;
  event: SideEvent;
  frame: StateFrame;
  ledger: LedgerEntry;
  taskEvent: GraphEvent;
}

/** Told apart by `type`. */
export type Fact =
  | FactCall
  | FactOrchestrator
  | FactMessage
  | FactChannel
  | FactChannelGone
  | FactOwnerMentions
  | FactHired
  | FactStation
  | FactRun
  | FactDoing
  | FactQuiet
  | FactRetry
  | FactSpent
  | FactReport
  | FactConflict
  | FactLeft
  | FactCommits
  | FactIssue
  | FactIssueGone
  | FactProgress
  | FactRecurrence
  | FactRecurrenceGone
  | FactConnector;

export interface FactCall {
  type: "call";
  at: number;
  state: CallState;
  reason?: string;
}

/** What an orchestrator is doing now. */
export interface OrchestratorNow {
  state: OrchestratorState;
  /** The channel it is thinking or writing in; absent while it listens, or works for what is not said in the chat. */
  channel?: string;
}

export interface FactOrchestrator {
  type: "orchestrator";
  at: number;
  /** Its profile id. */
  agent: string;
  state: OrchestratorState;
  /** The channel it is thinking or writing in; absent while it listens, or works for what is not said in the chat. */
  channel?: string;
}

export interface FactMessage {
  type: "message";
  at: number;
  message: ChatMessage;
  thread?: string;
  answers?: SessionId;
}

export interface FactChannel {
  type: "channel";
  at: number;
  channel: Channel;
}

/** A channel deleted, and its threads with it. */
export interface FactChannelGone {
  type: "channelGone";
  at: number;
  id: string;
}

export interface FactOwnerMentions {
  type: "ownerMentions";
  at: number;
  mentions: OwnerMention[];
}

export interface FactHired {
  type: "hired";
  at: number;
  session: Session;
}

export interface FactStation {
  type: "station";
  at: number;
  id: SessionId;
  station: number;
}

export interface FactRun {
  type: "run";
  at: number;
  id: SessionId;
  brief?: string;
}

export interface FactDoing {
  type: "doing";
  at: number;
  id: SessionId;
  action: SessionAction;
  label: string;
}

export interface FactQuiet {
  type: "quiet";
  at: number;
  id: SessionId;
  since: number;
}

export interface FactRetry {
  type: "retry";
  at: number;
  id: SessionId;
  attempt: number;
  of?: number;
}

export interface FactSpent {
  type: "spent";
  at: number;
  id: SessionId;
  spent: Spent;
}

export interface FactReport {
  type: "report";
  at: number;
  id: SessionId;
  run?: string;
  outcome: Outcome;
  summary: string;
  runs: number;
  spent?: Spent;
  questions?: Question[];
  checks?: CriterionCheck[];
  answer?: IssueAnswer;
}

export interface FactConflict {
  type: "conflict";
  at: number;
  id: SessionId;
  conflict?: Conflict;
}

export interface FactLeft {
  type: "left";
  at: number;
  id: SessionId;
  closed?: SessionClose;
  merged?: number;
}

export interface FactCommits {
  type: "commits";
  at: number;
  commits: CommitCount;
}

export interface FactIssue {
  type: "issue";
  at: number;
  issue: Issue;
}

export interface FactIssueGone {
  type: "issueGone";
  at: number;
  id: IssueId;
}

export interface FactProgress {
  type: "progress";
  at: number;
  progress: Progress;
  news?: ProgressNews;
}

export interface FactConnector {
  type: "connector";
  at: number;
  status: ConnectorStatus;
}

export interface FactRecurrence {
  type: "recurrence";
  at: number;
  recurrence: Recurrence;
}

export interface FactRecurrenceGone {
  type: "recurrenceGone";
  at: number;
  id: string;
}

/** Told apart by `type`. */
export type SideEvent =
  | FactCall
  | FactOrchestrator
  | FactMessage
  | FactChannel
  | FactChannelGone
  | FactOwnerMentions
  | FactHired
  | FactStation
  | FactRun
  | FactDoing
  | FactQuiet
  | FactRetry
  | FactSpent
  | FactReport
  | FactConflict
  | FactLeft
  | FactCommits
  | FactIssue
  | FactIssueGone
  | FactProgress
  | FactRecurrence
  | FactRecurrenceGone
  | FactConnector
  | SideEventSnapshot
  | SideEventSessionEvent
  | SideEventNotice
  | SideEventRuntime;

export interface SideEventSnapshot {
  type: "snapshot";
  at: number;
  state: WorkspaceState;
}

export interface SideEventSessionEvent {
  type: "event";
  at: number;
  id: string;
  activity: SessionEvent;
}

export interface SideEventNotice {
  type: "notice";
  at: number;
  level: NoticeLevel;
  text: string;
}

export interface SideEventRuntime {
  type: "runtime";
  at: number;
  info: RuntimeInfo;
}

export interface RecurrenceUpdate {
  enabled?: boolean;
}

/** A verdict on what was handed back: passed, or not, with the findings (or words) it is mended by. */
export interface IssueReviewRequest {
  pass: boolean;
  findings?: string[];
  text?: string;
}

/** Which issues issue.list gives: the open ones by default, the newest first. */
export interface IssueFilter {
  /** Only those in this status (closed ones included when it is done or canceled). */
  status?: IssueStatus;
  /** Words that the title or description all contain. */
  text?: string;
  project?: string;
  /** At most this many; none is all. */
  limit?: number;
  closed?: boolean;
  /** Only those waiting on the owner, the longest waiting first. */
  wantsOwner?: boolean;
}

/** One task of an issue split into several people's work: an issue under the graph the issue becomes. */
export interface TaskDraft {
  id: string;
  title?: string;
  brief: string;
  needs?: string[];
  /** A profile's id or name; empty is the farm's choice. */
  agent?: string;
  check?: string;
  scope?: string[];
  /** The task that checks the others' work against the whole. */
  acceptance?: boolean;
}

export interface IssueSplitRequest {
  title?: string;
  tasks: TaskDraft[];
}

export interface IssueStatusRequest {
  status: IssueStatus;
  /** Moving back to todo: another round with these words (findings, while it waits for acceptance), or, while it is
   * stuck, none for the server's own; reopening: what to do this time. */
  text?: string;
  /** Moving to todo: the profile that takes it on. Another than its own hands it over: the last session leaves, its branch
   * kept, and this one goes on in the same issue. */
  assignee?: string;
  /** Fields the owner changed and has not saved: saved first, so the act sees them. */
  edit?: IssueUpdate;
}

export interface GraphActRequest {
  action: GraphAction;
}

export interface TaskActRequest {
  action: TaskAction;
}

export interface ChatReadRequest {
  number: number;
}

export interface ChooseTitleRequest {
  achievement?: string;
  tier?: number;
}

export interface RenewRequest {
  channel: string;
  uid: string;
}

export interface DictateRequest {
  audio: string;
  format: string;
}

export interface Dictated {
  text: string;
}

export interface VoiceSaid {
  agentId: string;
  text: string;
}

export interface VoiceHeard {
  agentId: string;
  text: string;
  agent: string | null;
  sendKey?: string;
}

export interface StartRequest {
  channel: string;
  uid: string;
  /** The call answers a ring: what rang, which the orchestrator says first instead of the greeting. */
  about?: string;
}

export interface VerifyRequest {
  code: string;
}

export interface ConnectorsChannelRequest {
  channel: string;
}

export interface SetOpenRequest {
  open: boolean;
}

export interface AnswerPairingRequest {
  allow: boolean;
}

/** Told apart by `type`. */
export type LiveEvent = LiveEventSession | LiveEventNotice | LiveEventRuntime;

export interface LiveEventSession {
  type: "event";
  at: number;
  id: string;
  activity: SessionEvent;
}

export interface LiveEventNotice {
  type: "notice";
  at: number;
  level: NoticeLevel;
  text: string;
}

export interface LiveEventRuntime {
  type: "runtime";
  at: number;
  info: RuntimeInfo;
}

export interface Document {
  id: string;
  title: string;
  seq: number;
  created: number;
  updated: number;
}

export interface DocMarks {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

export interface DocSpan {
  t: string;
  marks: DocMarks;
}

export interface BlockAttrs {
  level?: number;
  checked?: boolean;
  language?: string;
  src?: string;
  width?: number;
  height?: number;
  alt?: string;
  issueId?: IssueId;
  memoryId?: string;
}

/** The content and position decided by the author of a new block. */
export interface BlockInput {
  id: string;
  parentId?: string;
  orderKey: string;
  type: string;
  attrs: BlockAttrs;
  text: DocSpan[];
}

export interface Block extends BlockInput {
  docId: string;
  rev: number;
  deleted?: boolean;
  updatedBy: string;
  updated: number;
}

export interface DocSnapshot {
  doc: Document;
  blocks: Block[];
}

export interface DocRequest {
  title: string;
}

export interface DocImport {
  title: string;
  markdown: string;
}

export interface DocMarkdown {
  markdown: string;
}

/** Told apart by `op`. */
export type DocOp =
  | DocOpInsertBlock
  | DocOpUpdateText
  | DocOpSetAttrs
  | DocOpSetType
  | DocOpMoveBlock
  | DocOpDeleteBlock
  | DocOpRestoreBlock
  | DocOpSplitBlock
  | DocOpMergeBlocks;

export interface DocOpInsertBlock {
  op: "insert_block";
  block: BlockInput;
}

export interface DocOpUpdateText {
  op: "update_text";
  blockId: string;
  baseRev: number;
  text: DocSpan[];
}

export interface DocOpSetAttrs {
  op: "set_attrs";
  blockId: string;
  attrs: BlockAttrs;
  unset?: string[];
}

export interface DocOpSetType {
  op: "set_type";
  blockId: string;
  type: string;
  attrs: BlockAttrs;
}

export interface DocOpMoveBlock {
  op: "move_block";
  blockId: string;
  parentId?: string;
  orderKey: string;
}

export interface DocOpDeleteBlock {
  op: "delete_block";
  blockId: string;
}

export interface DocOpRestoreBlock {
  op: "restore_block";
  blockId: string;
}

export interface DocOpSplitBlock {
  op: "split_block";
  blockId: string;
  baseRev: number;
  offset: number;
  newBlock: BlockInput;
}

export interface DocOpMergeBlocks {
  op: "merge_blocks";
  targetId: string;
  sourceId: string;
}

export interface DocSubmit {
  batchId: string;
  lastSeq: number;
  ops: DocOp[];
}

export const DocOpStatusValues = ["applied", "merged", "conflict", "noop", "rejected"] as const;
export type DocOpStatus = (typeof DocOpStatusValues)[number];

/** A block appended at a document's end. */
export interface DocBlockCreate {
  /** paragraph (the default), heading, bulleted, numbered, todo, quote or code. */
  type?: string;
  /** A heading's: 1 to 3, 2 when none. */
  level?: number;
  text: string;
}

/** A block's text rewritten against the rev it was read at: a newer rev is a conflict, not an overwrite. */
export interface DocBlockUpdate {
  block: string;
  baseRev: number;
  text: string;
}

export interface DocOpResult {
  status: DocOpStatus;
  blockId: string;
  rev?: number;
  text?: DocSpan[];
  yours?: DocSpan[];
  reason?: string;
}

export interface DocAck {
  batchId: string;
  seq: number;
  results: DocOpResult[];
  blocks: Block[];
}

export interface MessageEdit {
  id: string;
  text: string;
  /** The files it keeps: absent keeps them all, a shorter list takes the others off. */
  attachments?: string[];
}

export interface NotifyRequest {
  id: string;
  notify: Notify;
}

export interface ReactionToggle {
  id: string;
  emoji: string;
}

/** At most attachmentMax bytes, as base64. */
export interface AttachmentUpload {
  name: string;
  type: string;
  data: string;
}

export const attachmentMax = 25 * 1024 * 1024;

export interface MessageSearch {
  text: string;
  /** A channel: it and its threads; none is the whole farm. */
  channel?: string;
}

/** A message found, with where it is: the channel it is in (or a thread's channel) and its address there. */
export interface MessageHit {
  message: ChatMessage;
  channel: string;
  address: string;
}
