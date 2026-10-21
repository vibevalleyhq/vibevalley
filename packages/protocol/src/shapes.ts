// The shapes the server and the page share: every type on the wire and on disk, and the closed sets' members. schema.ts
// holds a Schema for each, typed by it (Schema.Codec<T.X>), so the two cannot drift apart; api.ts the endpoints.

import type { ApiError } from "./api";

/** The manager's participant id, and the agent of an issue for it. No agent profile has this id. */
export const managerAgent = "manager";

/** Who @所有人 is. */
export const everyone = "everyone";

/** The channel everyone is in. */
export const generalName = "田头";

/** Sessions working at once; also the beds on the farm. */
export const maxRunning = 6;

/** Times are Unix milliseconds. */
export const dayMs = 86400000;

/** The voice line's first words when the settings have none of their own; the voice samples say it. */
export const defaultGreeting = "来啦！今天想种点什么？";

/** An agent's memories past this go, the longest unused first. */
export const memoryKeep = 300;

/** The three long-lived streams; the client asks for them by path. */
export const statePath = "/api/v1/state";

export const eventsPath = "/api/v1/events";

export const livePath = "/api/v1/live";

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

export interface SettingsCheck {
  github?: GitHubStatus;
  problem?: string;
}

export interface ProjectCheck {
  problem?: string;
}

export interface RuntimeQuota {
  left?: number;
  text: string;
}

export const AgentIssueLevelValues = ["error", "warn"] as const;
export type AgentIssueLevel = (typeof AgentIssueLevelValues)[number];

export interface AgentIssue {
  field: string;
  level: AgentIssueLevel;
  text: string;
}

export interface AgentCheckRequest {
  agents: Agent[];
}

export interface AgentCheck {
  id: string;
  issues: AgentIssue[];
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

export const ManagerStateValues = ["idle", "listening", "thinking", "speaking"] as const;
export type ManagerState = (typeof ManagerStateValues)[number];

export const SenderKindValues = ["user", "manager", "agent", "system"] as const;
export type SenderKind = (typeof SenderKindValues)[number];

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
  conversation: string;
  from: string;
  fromKind: SenderKind;
  name: string;
  agent?: string;
  kind: MessageKind;
  text: string;
  final: boolean;
  mentions?: string[];
  session?: string;
  run?: string;
  outcome?: Outcome;
  spent?: Spent;
  spoken?: boolean;
  at: number;
}

export const ConversationKindValues = ["general", "channel", "thread"] as const;
export type ConversationKind = (typeof ConversationKindValues)[number];

export const SubjectKindValues = ["issue", "graph", "talk"] as const;
export type SubjectKind = (typeof SubjectKindValues)[number];

export interface Conversation {
  id: string;
  kind: ConversationKind;
  parent?: string;
  parentNumber?: number;
  name?: string;
  description?: string;
  project?: string;
  channel?: string;
  subjectKind?: SubjectKind;
  subjectId?: string;
  lastNumber?: number;
  replies: number;
  read?: number;
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
export type Phase = PhaseArriving | PhaseWorking | PhaseRipe | PhaseFailed | PhaseResting | PhaseClosed;

export interface LastRun {
  outcome: Outcome;
  summary: string;
  at: number;
  spent?: Spent;
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
  id: string;
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
  issue?: string;
  draft?: boolean;
  phaseText?: string;
}

export interface CommitCount {
  total: number;
  repos: Repo[];
}

export const GraphStateValues = ["splitting", "draft", "running", "paused", "ripe", "done", "abandoned"] as const;
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
  session?: string;
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
  session?: string;
  unlocked?: Unlock[];
}

/** Told apart by `kind`. */
export type ScheduleWhen = ScheduleWhenOnce | ScheduleWhenEvery | ScheduleWhenDaily | ScheduleWhenWeekly | ScheduleWhenCron;

export interface Schedule {
  id: string;
  name: string;
  text: string;
  channel: string;
  agent?: string;
  project?: string;
  when: ScheduleWhen;
  tz: string;
  enabled: boolean;
  created: number;
  lastRun?: number;
  by: ScheduleBy;
  pending?: boolean;
  whenText?: string;
  nextText?: string;
}

export const ScheduleByValues = ["owner", "manager"] as const;
export type ScheduleBy = (typeof ScheduleByValues)[number];

export interface Chat {
  conversations: Conversation[];
  messages: ChatMessage[];
}

export interface CoreState {
  call: CallState;
  callReason?: string;
  manager: ManagerState;
  sessions: Session[];
  chat?: Chat;
  commits?: CommitCount;
  progress?: Progress;
  schedules?: Schedule[];
  issues?: Issue[];
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

export const InboxKindValues = ["merge", "fix", "conflict", "quiet", "graph-draft", "graph-ripe", "task-failed", "mention", "schedule-ask"] as const;
export type InboxKind = (typeof InboxKindValues)[number];

/** Told apart by `kind`. */
export type InboxFrom = InboxFromSession | InboxFromManager;

/** Told apart by `kind`. */
export type InboxTarget = InboxTargetSession | InboxTargetGraph | InboxTargetChat;

export interface InboxItem {
  id: string;
  kind: InboxKind;
  from: InboxFrom;
  text: string;
  at: number;
  target: InboxTarget;
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
  plots: Record<string, PlotView>;
  achievements: AchievementStanding[];
}

/** Told apart by `kind`. */
export type GameEffect = GameEffectReward | GameEffectPenalty | GameEffectLevelUp | GameEffectAchievement;

export interface StateFrame {
  state: CoreState;
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
  "ripe",
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

export const GraphActorValues = ["user", "manager", "system", "session"] as const;
export type GraphActor = (typeof GraphActorValues)[number];

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
  actor: GraphActor;
  session?: string;
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

export interface IssueDispatchRequest {
  station?: number;
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
  version: string;
  loggedIn: boolean;
  account: string;
  reason: string;
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

export interface ManagerEvalRequest {
  on: number;
  want: string;
}

export interface ManagerEval {
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
  author?: MemoryAuthor;
  project?: string;
  session?: string;
  at: number;
  recalled: number;
  recalledAt?: number;
  fading?: boolean;
  source?: string;
}

export const MemoryAuthorValues = ["owner", "agent", "manager", "system"] as const;
export type MemoryAuthor = (typeof MemoryAuthorValues)[number];

export const MemoryKindValues = ["note", "issue"] as const;
export type MemoryKind = (typeof MemoryKindValues)[number];

export interface MemoryRequest {
  text: string;
  project?: string;
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

export interface Agent {
  id: string;
  name: string;
  role: string;
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
}

export interface Look {
  species?: Species;
  outfit?: Outfit;
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
  session?: string;
  queued?: string;
}

export interface IssueHistory {
  issue: Issue;
  sessions: Session[];
  missingSessions: string[];
}

export const PullRequestStateValues = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PullRequestStateValues)[number];

export interface PullRequest {
  url: string;
  number: number;
  state: PullRequestState;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  description?: string;
  project?: string;
  assignee?: string;
  priority: Priority;
  rank?: number;
  createdAt: number;
  queuedAt?: number;
  sessions: string[];
  closedAt?: number;
  closed?: IssueClose;
  parent?: string;
  blockedBy?: string[];
  graph?: IssueGraph;
  task?: IssueTask;
  schedule?: string;
  status: IssueStatus;
  moves: IssueStatus[];
  pullRequest?: PullRequest;
  acceptance: Acceptance;
  acceptedAt?: number;
  findings: Finding[];
  asks: string[];
  criteria?: string[];
  drafting?: IssueDrafting;
}

export interface IssueDrafting {
  session: string;
  name: string;
}

export interface IssueDraftRequest {
  text?: string;
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
  session?: string;
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
  acceptance?: Acceptance;
  criteria?: string[];
}

export const AcceptanceValues = ["glance", "required"] as const;
export type Acceptance = (typeof AcceptanceValues)[number];

export interface Finding {
  id: string;
  text: string;
  at: number;
  pulled?: boolean;
}

export interface IssueAcceptRequest {
  pass: boolean;
  findings?: string[];
  text?: string;
}

export interface IssueRequest {
  title: string;
  description?: string;
  project?: string;
  assignee?: string;
  priority?: Priority;
  acceptance?: Acceptance;
}

export const IssueCloseValues = ["merged", "merged_into_graph", "dismissed", "lost", "answered"] as const;
export type IssueClose = (typeof IssueCloseValues)[number];

export const RunTriggerKindValues = ["issue", "comment", "task", "schedule", "draft", "runtime"] as const;
export type RunTriggerKind = (typeof RunTriggerKindValues)[number];

export interface RunTrigger {
  kind: RunTriggerKind;
  message?: string;
  schedule?: string;
  missed?: boolean;
}

export interface Run {
  id: string;
  session: string;
  issue?: string;
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
  text: string;
  station?: number;
  conversation?: string;
  agent?: string;
  project?: string;
  sendKey?: string;
}

export interface ChannelUpdate {
  description?: string;
  project?: string;
}

export interface ScheduleRequest {
  name: string;
  text: string;
  channel?: string;
  agent?: string;
  project?: string;
  when: ScheduleWhen;
  tz?: string;
}

export interface ChannelRequest {
  name: string;
  description?: string;
  project?: string;
}

export interface SettingsStatus {
  file: string;
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
  deepseekApiKey?: string;
  agoraAppId?: string;
  agoraAppCertificate?: string;
  voice?: SettingsUpdateVoice;
  asrKey?: string;
  llmKey?: string;
  ttsKey?: string;
  dictation?: Dictation;
  dictationKey?: string;
  memorySources?: MemorySourceUpdate[];
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

export interface PhaseRipe {
  _tag: "ripe";
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
  closed: IssueClose;
}

export interface Repo {
  path: string;
  commits: number;
}

export interface ProgressTitle {
  id: string;
  tier: number;
}

export interface ScheduleWhenOnce {
  kind: "once";
  at: number;
}

export interface ScheduleWhenEvery {
  kind: "every";
  minutes: number;
}

export interface ScheduleWhenDaily {
  kind: "daily";
  time: string;
}

export interface ScheduleWhenWeekly {
  kind: "weekly";
  days: number[];
  time: string;
}

export interface ScheduleWhenCron {
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

export interface InboxFromManager {
  kind: "manager";
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
  conversation: string;
}

export interface Badge {
  text: string;
  tone: BadgeTone;
}

export interface GameEffectReward {
  kind: "reward";
  sessionId: string;
  coins: number;
  streak: number;
}

export interface GameEffectPenalty {
  kind: "penalty";
  sessionId: string;
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
  session: string;
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
  session: string;
  agent?: string;
}

export interface LedgerEntryConflicted {
  kind: "conflicted";
  at: number;
  session: string;
}

export interface LedgerEntryTold {
  kind: "told";
  at: number;
  session: string;
}

export interface LedgerEntryReviewed {
  kind: "reviewed";
  at: number;
  session: string;
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
  session: string;
  to: string;
}

export interface LedgerEntryCalled {
  kind: "called";
  at: number;
  session: string;
}

export interface LedgerEntryHired {
  kind: "hired";
  at: number;
  session: string;
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
export type VoiceAnswer = VoiceAnswerManager | VoiceAnswerAgora | VoiceAnswerDeepseek | VoiceAnswerOpenai;

export interface VoiceAnswerManager {
  vendor: "manager";
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
  | FactManager
  | FactMessage
  | FactConversation
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
  | FactSchedule
  | FactUnschedule;

export interface FactCall {
  type: "call";
  at: number;
  state: CallState;
  reason?: string;
}

export interface FactManager {
  type: "manager";
  at: number;
  state: ManagerState;
}

export interface FactMessage {
  type: "message";
  at: number;
  message: ChatMessage;
  thread?: string;
  answers?: string;
}

export interface FactConversation {
  type: "conversation";
  at: number;
  conversation: Conversation;
}

export interface FactHired {
  type: "hired";
  at: number;
  session: Session;
}

export interface FactStation {
  type: "station";
  at: number;
  id: string;
  station: number;
}

export interface FactRun {
  type: "run";
  at: number;
  id: string;
  brief?: string;
}

export interface FactDoing {
  type: "doing";
  at: number;
  id: string;
  action: SessionAction;
  label: string;
}

export interface FactQuiet {
  type: "quiet";
  at: number;
  id: string;
  since: number;
}

export interface FactRetry {
  type: "retry";
  at: number;
  id: string;
  attempt: number;
  of?: number;
}

export interface FactSpent {
  type: "spent";
  at: number;
  id: string;
  spent: Spent;
}

export interface FactReport {
  type: "report";
  at: number;
  id: string;
  run?: string;
  outcome: Outcome;
  summary: string;
  runs: number;
  spent?: Spent;
  asks?: string[];
}

export interface FactConflict {
  type: "conflict";
  at: number;
  id: string;
  conflict?: Conflict;
}

export interface FactLeft {
  type: "left";
  at: number;
  id: string;
  closed?: IssueClose;
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
  id: string;
}

export interface FactProgress {
  type: "progress";
  at: number;
  progress: Progress;
  news?: ProgressNews;
}

export interface FactSchedule {
  type: "schedule";
  at: number;
  schedule: Schedule;
}

export interface FactUnschedule {
  type: "unschedule";
  at: number;
  id: string;
}

/** Told apart by `type`. */
export type SideEvent =
  | FactCall
  | FactManager
  | FactMessage
  | FactConversation
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
  | FactSchedule
  | FactUnschedule
  | SideEventSnapshot
  | SideEventSessionEvent
  | SideEventNotice
  | SideEventRuntime;

export interface SideEventSnapshot {
  type: "snapshot";
  at: number;
  state: CoreState;
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

export interface ScheduleUpdate {
  enabled?: boolean;
}

export interface MoveIssueRequest {
  before?: string;
}

export interface IssueStatusRequest {
  status: IssueStatus;
  text?: string;
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
  issueId?: string;
  memoryId?: string;
}

export interface Block {
  id: string;
  docId: string;
  parentId?: string;
  orderKey: string;
  type: string;
  attrs: BlockAttrs;
  text: DocSpan[];
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
  block: Block;
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
  newBlock: Block;
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

/** A refusal from the server: its tagged error (Refused, VoiceUnavailable…) and reason, or the bare status. */
export class VibeValleyApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    readonly reason: string,
    /** The error as the server wrote it, for what it carries besides the reason. */
    readonly error?: ApiError,
  ) {
    super(reason);
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
    health: (): Promise<Health> => this.call("GET", "/api/v1/health", undefined, undefined) as Promise<Health>,
  };

  readonly manager = {
    open: (): Promise<void> => this.call("POST", "/api/v1/manager/open", undefined, undefined) as Promise<void>,
    /** Ends the manager's run under way and drops what waits for it; the sessions it sent keep working. */
    stop: (): Promise<void> => this.call("POST", "/api/v1/manager/stop", undefined, undefined) as Promise<void>,
    /** The v1 caption relay without a call id is accepted only with one active call. */
    hear: (a: { body: SayRequest }): Promise<void> => this.call("POST", "/api/v1/manager/hear", undefined, a.body) as Promise<void>,
    listArchive: (a: { q?: string }): Promise<ArchiveListing> => this.call("GET", "/api/v1/manager/archive", { q: a.q }, undefined) as Promise<ArchiveListing>,
    getArchive: (a: { name: string }): Promise<string> =>
      this.call("GET", "/api/v1/manager/archive/" + encodeURIComponent(String(a.name)), undefined, undefined) as Promise<string>,
    /** Saves the turn begun at a step of the manager's log as a case for its evals, with what it should have done. */
    markWrong: (a: { body: ManagerEvalRequest }): Promise<ManagerEval> => this.call("POST", "/api/v1/manager/evals", undefined, a.body) as Promise<ManagerEval>,
  };

  readonly setting = {
    load: (): Promise<SettingsStatus> => this.call("GET", "/api/v1/settings", undefined, undefined) as Promise<SettingsStatus>,
    /** The first thing Save would refuse in these settings, without saving them. */
    check: (a: { body: SettingsUpdate }): Promise<SettingsCheck> => this.call("POST", "/api/v1/settings/check", undefined, a.body) as Promise<SettingsCheck>,
    save: (a: { body: SettingsUpdate }): Promise<SettingsStatus> => this.call("PUT", "/api/v1/settings", undefined, a.body) as Promise<SettingsStatus>,
  };

  readonly channel = {
    say: (a: { body: SayRequest }): Promise<void> => this.call("POST", "/api/v1/say", undefined, a.body) as Promise<void>,
    create: (a: { body: ChannelRequest }): Promise<string> => this.call("POST", "/api/v1/channels", undefined, a.body) as Promise<string>,
    update: (a: { id: string; body: ChannelUpdate }): Promise<void> =>
      this.call("PUT", "/api/v1/channels/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<void>,
    history: (a: { id: string; before?: number; limit?: number }): Promise<ChatMessage[]> =>
      this.call("GET", "/api/v1/channels/" + encodeURIComponent(String(a.id)) + "/messages", { before: a.before, limit: a.limit }, undefined) as Promise<
        ChatMessage[]
      >,
    markRead: (a: { id: string; body: ChatReadRequest }): Promise<void> =>
      this.call("POST", "/api/v1/channels/" + encodeURIComponent(String(a.id)) + "/read", undefined, a.body) as Promise<void>,
  };

  readonly schedule = {
    create: (a: { body: ScheduleRequest }): Promise<Schedule> => this.call("POST", "/api/v1/schedules", undefined, a.body) as Promise<Schedule>,
    list: (): Promise<Schedule[]> => this.call("GET", "/api/v1/schedules", undefined, undefined) as Promise<Schedule[]>,
    /** Only what the body gives changes. */
    update: (a: { id: string; body: ScheduleUpdate }): Promise<void> =>
      this.call("PUT", "/api/v1/schedules/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<void>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/schedules/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
  };

  readonly issue = {
    /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
    comment: (a: { id: string; body: CommentRequest }): Promise<void> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/comment", undefined, a.body) as Promise<void>,
    changes: (a: { id: string }): Promise<Changes> =>
      this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/changes", undefined, undefined) as Promise<Changes>,
    /** Tells the newest session to merge its base in and settle the conflicts, in the owner's words (ConflictTask). */
    resolve: (a: { id: string }): Promise<void> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/resolve", undefined, undefined) as Promise<void>,
    /** One joined read of issues and their real sessions, including explicit missing records. */
    history: (): Promise<IssueHistory[]> => this.call("GET", "/api/v1/issues/history", undefined, undefined) as Promise<IssueHistory[]>,
    list: (): Promise<Issue[]> => this.call("GET", "/api/v1/issues", undefined, undefined) as Promise<Issue[]>,
    get: (a: { id: string }): Promise<Issue> => this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<Issue>,
    runs: (a: { id: string }): Promise<Run[]> =>
      this.call("GET", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/runs", undefined, undefined) as Promise<Run[]>,
    create: (a: { body: IssueRequest }): Promise<Issue> => this.call("POST", "/api/v1/issues", undefined, a.body) as Promise<Issue>,
    update: (a: { id: string; body: IssueUpdate }): Promise<Issue> =>
      this.call("PUT", "/api/v1/issues/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<Issue>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/issues/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
    move: (a: { id: string; body: MoveIssueRequest }): Promise<Issue[]> =>
      this.call("PUT", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/move", undefined, a.body) as Promise<Issue[]>,
    /** Moving an issue is what it does: todo sends it out (or waits for room), done merges, canceled sends its session home,
     * todo again after a round or a close is another round with text. Issue.moves lists where it may go. */
    status: (a: { id: string; body: IssueStatusRequest }): Promise<Issue> =>
      this.call("PUT", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/status", undefined, a.body) as Promise<Issue>,
    /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
     * leaves; with asks open, the word is their answer. The issue stays in the backlog until it is moved to todo. */
    draft: (a: { id: string; body: IssueDraftRequest }): Promise<Issue> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/draft", undefined, a.body) as Promise<Issue>,
    /** Starts a queued todo now, if its project and the farm have room; otherwise it keeps its place in the queue. */
    dispatch: (a: { id: string; body: IssueDispatchRequest }): Promise<Dispatched> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/dispatch", undefined, a.body) as Promise<Dispatched>,
    /** The acceptance of what was handed back (in review): a pass makes it ready to harvest, a fail adds weeds and sends
     * another round. */
    accept: (a: { id: string; body: IssueAcceptRequest }): Promise<Issue> =>
      this.call("POST", "/api/v1/issues/" + encodeURIComponent(String(a.id)) + "/accept", undefined, a.body) as Promise<Issue>,
  };

  readonly session = {
    /** Stops a session's turn; it stays, and a comment starts the next. */
    stop: (a: { id: string }): Promise<void> =>
      this.call("POST", "/api/v1/sessions/" + encodeURIComponent(String(a.id)) + "/stop", undefined, undefined) as Promise<void>,
    list: (a: { agent?: string }): Promise<Session[]> => this.call("GET", "/api/v1/sessions", { agent: a.agent }, undefined) as Promise<Session[]>,
    get: (a: { id: string }): Promise<Session> =>
      this.call("GET", "/api/v1/sessions/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<Session>,
    /** Its log, oldest first; run gives one run's only. The manager's log is session manager's. */
    events: (a: { id: string; run?: string }): Promise<SessionEvent[]> =>
      this.call("GET", "/api/v1/sessions/" + encodeURIComponent(String(a.id)) + "/events", { run: a.run }, undefined) as Promise<SessionEvent[]>,
  };

  readonly graph = {
    split: (a: { body: GraphSplitRequest }): Promise<string> => this.call("POST", "/api/v1/graphs", undefined, a.body) as Promise<string>,
    updateTask: (a: { id: string; task: string; body: TaskEdit }): Promise<string> =>
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
    act: (a: { id: string; body: GraphActRequest }): Promise<string> =>
      this.call("POST", "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/act", undefined, a.body) as Promise<string>,
    taskAct: (a: { id: string; task: string; body: TaskActRequest }): Promise<string> =>
      this.call(
        "POST",
        "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/tasks/" + encodeURIComponent(String(a.task)) + "/act",
        undefined,
        a.body,
      ) as Promise<string>,
    changes: (a: { id: string }): Promise<Changes> =>
      this.call("GET", "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/changes", undefined, undefined) as Promise<Changes>,
    events: (a: { id: string }): Promise<GraphEvent[]> =>
      this.call("GET", "/api/v1/graphs/" + encodeURIComponent(String(a.id)) + "/events", undefined, undefined) as Promise<GraphEvent[]>,
  };

  readonly game = {
    achievements: (): Promise<Achievement[]> => this.call("GET", "/api/v1/game/achievements", undefined, undefined) as Promise<Achievement[]>,
    chooseTitle: (a: { body: ChooseTitleRequest }): Promise<void> => this.call("POST", "/api/v1/game/title", undefined, a.body) as Promise<void>,
  };

  readonly runtime = {
    list: (): Promise<RuntimeInfo[]> => this.call("GET", "/api/v1/runtimes", undefined, undefined) as Promise<RuntimeInfo[]>,
    refresh: (a: { id: string }): Promise<RuntimeInfo> =>
      this.call("POST", "/api/v1/runtimes/" + encodeURIComponent(String(a.id)) + "/refresh", undefined, undefined) as Promise<RuntimeInfo>,
    update: (a: { id: string; body: RuntimeSettings }): Promise<RuntimeInfo> =>
      this.call("PUT", "/api/v1/runtimes/" + encodeURIComponent(String(a.id)) + "/settings", undefined, a.body) as Promise<RuntimeInfo>,
  };

  readonly github = {
    status: (): Promise<GitHubStatus> => this.call("GET", "/api/v1/github", undefined, undefined) as Promise<GitHubStatus>,
    refresh: (): Promise<GitHubStatus> => this.call("POST", "/api/v1/github/refresh", undefined, undefined) as Promise<GitHubStatus>,
  };

  readonly agent = {
    list: (): Promise<Agent[]> => this.call("GET", "/api/v1/agents", undefined, undefined) as Promise<Agent[]>,
    /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
    check: (a: { body: AgentCheckRequest }): Promise<AgentCheck[]> => this.call("POST", "/api/v1/agents/check", undefined, a.body) as Promise<AgentCheck[]>,
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: { body: Agent }): Promise<Agent> => this.call("POST", "/api/v1/agents", undefined, a.body) as Promise<Agent>,
    save: (a: { id: string; body: Agent }): Promise<Agent> =>
      this.call("PUT", "/api/v1/agents/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<Agent>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/agents/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
  };

  readonly memory = {
    /** An agent's memories: the manager's (agent manager) are the lines of its MEMORY.md, with the file and how many of the newest
     * its prompt carries; every other agent's are rows. */
    list: (a: { agent: string }): Promise<MemoryList> =>
      this.call("GET", "/api/v1/memories/" + encodeURIComponent(String(a.agent)), undefined, undefined) as Promise<MemoryList>,
    /** What the agent would be reminded of on its next start; the manager is not reminded, it carries its whole file. */
    recall: (a: { agent: string; project?: string; text?: string }): Promise<RecallPreview> =>
      this.call(
        "GET",
        "/api/v1/memories/" + encodeURIComponent(String(a.agent)) + "/recall",
        { project: a.project, text: a.text },
        undefined,
      ) as Promise<RecallPreview>,
    create: (a: { agent: string; body: MemoryRequest }): Promise<Memory> =>
      this.call("POST", "/api/v1/memories/" + encodeURIComponent(String(a.agent)), undefined, a.body) as Promise<Memory>,
    delete: (a: { agent: string; memory: string }): Promise<void> =>
      this.call(
        "DELETE",
        "/api/v1/memories/" + encodeURIComponent(String(a.agent)) + "/" + encodeURIComponent(String(a.memory)),
        undefined,
        undefined,
      ) as Promise<void>,
  };

  readonly skill = {
    list: (): Promise<Skill[]> => this.call("GET", "/api/v1/skills", undefined, undefined) as Promise<Skill[]>,
    /** Create allocates an identity; callers with an existing identity use save. */
    create: (a: { body: Skill }): Promise<Skill> => this.call("POST", "/api/v1/skills", undefined, a.body) as Promise<Skill>,
    save: (a: { id: string; body: Skill }): Promise<Skill> =>
      this.call("PUT", "/api/v1/skills/" + encodeURIComponent(String(a.id)), undefined, a.body) as Promise<Skill>,
    delete: (a: { id: string }): Promise<void> =>
      this.call("DELETE", "/api/v1/skills/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<void>,
  };

  readonly project = {
    list: (): Promise<ProjectSummary[]> => this.call("GET", "/api/v1/projects", undefined, undefined) as Promise<ProjectSummary[]>,
    /** The first thing Create would refuse in this project, without making it. */
    check: (a: { body: NewProject }): Promise<ProjectCheck> => this.call("POST", "/api/v1/projects/check", undefined, a.body) as Promise<ProjectCheck>,
    create: (a: { body: NewProject }): Promise<ProjectSummary> => this.call("POST", "/api/v1/projects", undefined, a.body) as Promise<ProjectSummary>,
    languages: (a: { id: string }): Promise<ProjectLanguages> =>
      this.call("GET", "/api/v1/projects/" + encodeURIComponent(String(a.id)) + "/languages", undefined, undefined) as Promise<ProjectLanguages>,
    /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
    templates: (a: { id: string }): Promise<ProjectTemplates> =>
      this.call("GET", "/api/v1/projects/" + encodeURIComponent(String(a.id)) + "/templates", undefined, undefined) as Promise<ProjectTemplates>,
    activity: (a: { id: string }): Promise<ProjectActivity> =>
      this.call("GET", "/api/v1/projects/" + encodeURIComponent(String(a.id)) + "/activity", undefined, undefined) as Promise<ProjectActivity>,
  };

  readonly voice = {
    session: (): Promise<AgoraGrant> => this.call("POST", "/api/v1/voice/session", undefined, undefined) as Promise<AgoraGrant>,
    renew: (a: { body: RenewRequest }): Promise<AgoraGrant> => this.call("POST", "/api/v1/voice/renew", undefined, a.body) as Promise<AgoraGrant>,
    start: (a: { body: StartRequest }): Promise<VoiceAgent> => this.call("POST", "/api/v1/voice/agent", undefined, a.body) as Promise<VoiceAgent>,
    stop: (a: { body: VoiceAgent }): Promise<void> => this.call("POST", "/api/v1/voice/agent/stop", undefined, a.body) as Promise<void>,
    heard: (a: { body: VoiceHeard }): Promise<void> => this.call("POST", "/api/v1/voice/agent/heard", undefined, a.body) as Promise<void>,
    said: (a: { body: VoiceSaid }): Promise<void> => this.call("POST", "/api/v1/voice/agent/said", undefined, a.body) as Promise<void>,
    dictate: (a: { body: DictateRequest }): Promise<Dictated> => this.call("POST", "/api/v1/voice/dictate", undefined, a.body) as Promise<Dictated>,
  };

  readonly connector = {
    list: (): Promise<ConnectorStatus[]> => this.call("GET", "/api/v1/connectors", undefined, undefined) as Promise<ConnectorStatus[]>,
    login: (a: { id: ConnectorID; body: ConnectorLogin }): Promise<ConnectorStatus> =>
      this.call("POST", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/login", undefined, a.body) as Promise<ConnectorStatus>,
    verify: (a: { id: ConnectorID; body: VerifyRequest }): Promise<ConnectorStatus> =>
      this.call("POST", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/verify", undefined, a.body) as Promise<ConnectorStatus>,
    logout: (a: { id: ConnectorID }): Promise<ConnectorStatus> =>
      this.call("POST", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/logout", undefined, undefined) as Promise<ConnectorStatus>,
    channel: (a: { id: ConnectorID; body: ConnectorsChannelRequest }): Promise<ConnectorStatus> =>
      this.call("PUT", "/api/v1/connectors/" + encodeURIComponent(String(a.id)) + "/channel", undefined, a.body) as Promise<ConnectorStatus>,
  };

  readonly lan = {
    status: (): Promise<LanStatus> => this.call("GET", "/api/v1/lan", undefined, undefined) as Promise<LanStatus>,
    update: (a: { body: SetOpenRequest }): Promise<LanStatus> => this.call("PUT", "/api/v1/lan", undefined, a.body) as Promise<LanStatus>,
    startPairing: (): Promise<LanStatus> => this.call("POST", "/api/v1/lan/pairing", undefined, undefined) as Promise<LanStatus>,
    stopPairing: (): Promise<LanStatus> => this.call("DELETE", "/api/v1/lan/pairing", undefined, undefined) as Promise<LanStatus>,
    answerPairing: (a: { body: AnswerPairingRequest }): Promise<LanStatus> =>
      this.call("POST", "/api/v1/lan/pairing/answer", undefined, a.body) as Promise<LanStatus>,
    deleteDevice: (a: { id: string }): Promise<LanStatus> =>
      this.call("DELETE", "/api/v1/lan/devices/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<LanStatus>,
    pair: (a: { body: LanPairRequest }): Promise<LanPaired> => this.call("POST", "/api/v1/lan/pair", undefined, a.body) as Promise<LanPaired>,
    me: (): Promise<LanDevice> => this.call("GET", "/api/v1/lan/me", undefined, undefined) as Promise<LanDevice>,
  };

  readonly doc = {
    /** The documents, the newest change first; their blocks are in doc.get. */
    list: (): Promise<Document[]> => this.call("GET", "/api/v1/docs", undefined, undefined) as Promise<Document[]>,
    create: (a: { body: DocRequest }): Promise<DocSnapshot> => this.call("POST", "/api/v1/docs", undefined, a.body) as Promise<DocSnapshot>,
    /** A new document from Markdown: the format documents trade with agents and MEMORY.md in, not how they are stored. */
    import: (a: { body: DocImport }): Promise<DocSnapshot> => this.call("POST", "/api/v1/docs/import", undefined, a.body) as Promise<DocSnapshot>,
    /** The document and every live block (no tombstones), in order. */
    get: (a: { id: string }): Promise<DocSnapshot> =>
      this.call("GET", "/api/v1/docs/" + encodeURIComponent(String(a.id)), undefined, undefined) as Promise<DocSnapshot>,
    /** A batch of ops, as the owner: taken in order, in one transaction, one batch of a document at a time. */
    submit: (a: { id: string; body: DocSubmit }): Promise<DocAck> =>
      this.call("POST", "/api/v1/docs/" + encodeURIComponent(String(a.id)) + "/submit", undefined, a.body) as Promise<DocAck>,
    markdown: (a: { id: string }): Promise<DocMarkdown> =>
      this.call("GET", "/api/v1/docs/" + encodeURIComponent(String(a.id)) + "/markdown", undefined, undefined) as Promise<DocMarkdown>,
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
    const decoded: unknown = text === "" ? undefined : JSON.parse(text);
    if (!res.ok) {
      const j = (decoded ?? {}) as { _tag?: unknown; reason?: unknown };
      const reason = typeof j.reason === "string" ? j.reason : "服务端答 " + res.status;
      throw new VibeValleyApiError(
        res.status,
        typeof j._tag === "string" ? j._tag : undefined,
        reason,
        typeof j._tag === "string" ? (j as ApiError) : undefined,
      );
    }
    return decoded;
  }
}
