// The shapes the server and the page share: every type on the wire and on disk, and the closed sets' members. schema.ts
// holds a Schema for each, typed by it (Schema.Codec<T.X>), so the two cannot drift apart; api.ts the endpoints.

/** The orchestrator's participant id, and the agent of an issue for it. No agent profile has this id. */
export const orchestratorAgent = "orchestrator";

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

export const OrchestratorStateValues = ["idle", "listening", "thinking", "speaking"] as const;
export type OrchestratorState = (typeof OrchestratorStateValues)[number];

export const SenderKindValues = ["user", "orchestrator", "agent", "system"] as const;
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
  refining?: boolean;
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
  by: RecurrenceBy;
  pending?: boolean;
  whenText?: string;
  nextText?: string;
}

export const RecurrenceByValues = ["owner", "orchestrator"] as const;
export type RecurrenceBy = (typeof RecurrenceByValues)[number];

export interface OwnerMention {
  message: ChatMessage;
  channel: string;
  address: string;
}

export interface Chat {
  conversations: Conversation[];
  messages: ChatMessage[];
  ownerMentions?: OwnerMention[];
}

export interface WorkspaceState {
  call: CallState;
  callReason?: string;
  orchestrator: OrchestratorState;
  sessions: Session[];
  chat?: Chat;
  commits?: CommitCount;
  progress?: Progress;
  recurrences?: Recurrence[];
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
  "merge",
  "ask",
  "fix",
  "interrupted",
  "conflict",
  "quiet",
  "graph-draft",
  "graph-ripe",
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

export const GraphActorValues = ["user", "orchestrator", "system", "session"] as const;
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
  /** Fields the owner changed and has not saved: saved first, so the act sees them. */
  edit?: IssueUpdate;
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

export interface OrchestratorEvalRequest {
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
  author?: MemoryAuthor;
  project?: string;
  session?: string;
  at: number;
  recalled: number;
  recalledAt?: number;
  fading?: boolean;
  source?: string;
}

export const MemoryAuthorValues = ["owner", "agent", "orchestrator", "system"] as const;
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
  /** Done: what it delivered. Its verdict is the status; how its work went in is this. */
  delivered?: Delivery;
  /** Canceled: why. */
  canceled?: IssueCanceled;
  parent?: string;
  blockedBy?: string[];
  graph?: IssueGraph;
  task?: IssueTask;
  recurrence?: string;
  status: IssueStatus;
  moves: IssueStatus[];
  pullRequest?: PullRequest;
  review: Review;
  reviewedAt?: number;
  findings: Finding[];
  questions: Question[];
  criteria?: string[];
  checks?: CriterionCheck[];
  refining?: IssueRefining;
  /** An issue for the orchestrator: how its last turn on it ended. Set, the issue waits on the owner; only the owner closes it. */
  handedBack?: HandedBack;
  attention: IssueAttention;
}

export interface HandedBack {
  at: number;
  outcome: Outcome;
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
export const AttentionValues = ["draft", "queued", "working", "asking", "reviewing", "stuck", "harvested", "closed"] as const;
export type Attention = (typeof AttentionValues)[number];

export const StuckReasonValues = ["failed", "conflict", "interrupted", "quiet"] as const;
export type StuckReason = (typeof StuckReasonValues)[number];

/** What the owner can do to an issue from its page. tell is a word to the helper, answer the same to its question;
 * reject sends it back with findings; acknowledge takes what the orchestrator answered as done. */
export const IssueActValues = [
  "start",
  "answer",
  "accept",
  "reject",
  "harvest",
  "keep",
  "acknowledge",
  "resolve",
  "resume",
  "cure",
  "tell",
  "stop",
  "close",
  "reopen",
] as const;
export type IssueAct = (typeof IssueActValues)[number];

/** since: when it came to stand so, when known. lead is the one thing the owner is asked to do, if any; acts are all
 * it can do, lead first. */
export interface IssueAttention {
  state: Attention;
  since?: number;
  stuck?: StuckReason;
  lead?: IssueAct;
  acts: IssueAct[];
}

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
  session: string;
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
  review?: Review;
  criteria?: string[];
}

export const ReviewValues = ["glance", "required"] as const;
export type Review = (typeof ReviewValues)[number];

export interface Finding {
  id: string;
  text: string;
  at: number;
  pulled?: boolean;
}

/** One of what the owner may do (Issue.attention.acts). text: what answer, tell and reopen say, and reject's findings
 * one a line unless findings is given; sendKey: answer and tell said again with the same key are said once. */
export interface IssueActRequest {
  act: IssueAct;
  text?: string;
  findings?: string[];
  sendKey?: string;
}

export interface IssueReviewRequest {
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
  review?: Review;
}

/** What a completed issue delivered: its branch merged into the project's main branch, into its parent's branch (a step of
 * a task graph), by a pull request, its branch kept unmerged, or nothing (no change, or an answer). */
export const DeliveryValues = ["merged", "merged_into_parent", "pull_request", "kept", "none"] as const;
export type Delivery = (typeof DeliveryValues)[number];

/** Why an issue is not done: the owner closed it, or its workplace was lost. */
export const IssueCanceledValues = ["dismissed", "lost"] as const;
export type IssueCanceled = (typeof IssueCanceledValues)[number];

/** How a session left: its work merged (into the main branch, or a task graph's branch), its issue completed without a
 * merge, sent home, or its workplace lost. */
export const SessionCloseValues = ["merged", "merged_into_graph", "completed", "dismissed", "lost"] as const;
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
  | FactConversation
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
  | FactRecurrenceGone;

export interface FactCall {
  type: "call";
  at: number;
  state: CallState;
  reason?: string;
}

export interface FactOrchestrator {
  type: "orchestrator";
  at: number;
  state: OrchestratorState;
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
  questions?: Question[];
  checks?: CriterionCheck[];
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
  id: string;
}

export interface FactProgress {
  type: "progress";
  at: number;
  progress: Progress;
  news?: ProgressNews;
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
  | FactConversation
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

export interface MoveIssueRequest {
  before?: string;
}

export interface IssueStatusRequest {
  status: IssueStatus;
  text?: string;
  /** Moving to done: complete it with its branch kept, not merged. */
  keepBranch?: boolean;
  /** Moving to todo: the profile that takes it on. Another than its own hands it over: the last session leaves, its branch
   * kept, and this one goes on in the same issue. */
  agent?: string;
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
  issueId?: string;
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
