// A Schema for each shape in shapes.ts, typed by it: a field added there and not here (or here and not there) does not
// compile.

import { Schema } from "effect";
import * as T from "./shapes";

export const ServerReady: Schema.Codec<T.ServerReady> = Schema.Struct({
  url: Schema.String,
  pid: Schema.Number,
});

export const GitHubStatus: Schema.Codec<T.GitHubStatus> = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.String,
  loggedIn: Schema.Boolean,
  account: Schema.String,
  reason: Schema.String,
  checkedAt: Schema.Number,
});

export const SettingsCheck: Schema.Codec<T.SettingsCheck> = Schema.Struct({
  problem: Schema.optionalKey(Schema.String),
});

export const ProjectCheck: Schema.Codec<T.ProjectCheck> = Schema.Struct({
  problem: Schema.optionalKey(Schema.String),
});

export const RuntimeQuota: Schema.Codec<T.RuntimeQuota> = Schema.Struct({
  left: Schema.optionalKey(Schema.Number),
  text: Schema.String,
});

export const AgentIssueLevel: Schema.Codec<T.AgentIssueLevel> = Schema.Literals(T.AgentIssueLevelValues);

export const AgentIssue: Schema.Codec<T.AgentIssue> = Schema.Struct({
  field: Schema.String,
  level: AgentIssueLevel,
  text: Schema.String,
});

export const PersonaMode: Schema.Codec<T.PersonaMode> = Schema.Literals(T.PersonaModeValues);

export const MCPServerStdio: Schema.Codec<T.MCPServerStdio> = Schema.Struct({
  type: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.String)),
  env: Schema.Record(Schema.String, Schema.String),
});

export const MCPServerHTTP: Schema.Codec<T.MCPServerHTTP> = Schema.Struct({
  type: Schema.Literal("http"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
});

export const MCPServer: Schema.Codec<T.MCPServer> = Schema.Union([MCPServerStdio, MCPServerHTTP]);

export const Species: Schema.Codec<T.Species> = Schema.Literals(T.SpeciesValues);

export const Outfit: Schema.Codec<T.Outfit> = Schema.Literals(T.OutfitValues);

export const Build: Schema.Codec<T.Build> = Schema.Literals(T.BuildValues);

export const Head: Schema.Codec<T.Head> = Schema.Literals(T.HeadValues);

export const Look: Schema.Codec<T.Look> = Schema.Struct({
  species: Schema.optionalKey(Species),
  outfit: Schema.optionalKey(Outfit),
  build: Build,
  head: Head,
  body: Schema.String,
  trim: Schema.String,
  hat: Schema.String,
  eye: Schema.String,
});

export const Agent: Schema.Codec<T.Agent> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  enabled: Schema.Boolean,
  runtime: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  persona: Schema.String,
  personaMode: PersonaMode,
  skills: Schema.mutable(Schema.Array(Schema.String)),
  mcpServers: Schema.mutable(Schema.Array(MCPServer)),
  disallowedTools: Schema.mutable(Schema.Array(Schema.String)),
  env: Schema.Record(Schema.String, Schema.String),
  workdir: Schema.String,
  worktree: Schema.Boolean,
  tags: Schema.mutable(Schema.Array(Schema.String)),
  look: Look,
});

export const AgentCheckRequest: Schema.Codec<T.AgentCheckRequest> = Schema.Struct({
  agents: Schema.mutable(Schema.Array(Agent)),
});

export const AgentCheck: Schema.Codec<T.AgentCheck> = Schema.Struct({
  id: Schema.String,
  issues: Schema.mutable(Schema.Array(AgentIssue)),
});

export const RecallPreview: Schema.Codec<T.RecallPreview> = Schema.Struct({
  lines: Schema.mutable(Schema.Array(Schema.String)),
  chars: Schema.Number,
  limit: Schema.Number,
});

export const AchievementCategory: Schema.Codec<T.AchievementCategory> = Schema.Literals(T.AchievementCategoryValues);

export const AchievementDef: Schema.Codec<T.AchievementDef> = Schema.Struct({
  id: Schema.String,
  category: AchievementCategory,
  title: Schema.String,
  tierTitles: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  detail: Schema.String,
  tiers: Schema.mutable(Schema.Array(Schema.Number)),
  coins: Schema.mutable(Schema.Array(Schema.Number)),
  unit: Schema.optionalKey(Schema.String),
});

export const AchievementTier: Schema.Codec<T.AchievementTier> = Schema.Struct({
  need: Schema.Number,
  title: Schema.String,
  coins: Schema.Number,
  reached: Schema.String,
});

export const Achievement: Schema.Codec<T.Achievement> = Schema.Struct({
  id: Schema.String,
  category: AchievementCategory,
  title: Schema.String,
  detail: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  wearable: Schema.Boolean,
  tiers: Schema.mutable(Schema.Array(AchievementTier)),
});

export const AchievementStanding: Schema.Codec<T.AchievementStanding> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Number,
  count: Schema.Number,
  next: Schema.optionalKey(Schema.Number),
});

export const RuntimePreset: Schema.Codec<T.RuntimePreset> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  blurb: Schema.String,
  look: Look,
});

export const RuntimeCapability: Schema.Codec<T.RuntimeCapability> = Schema.Literals(T.RuntimeCapabilityValues);

export const RuntimeFacts: Schema.Codec<T.RuntimeFacts> = Schema.Struct({
  steer: Schema.Boolean,
  refused: Schema.Record(Schema.String, Schema.String),
  capabilities: Schema.mutable(Schema.Array(RuntimeCapability)),
  inProcess: Schema.Boolean,
});

export const CallState: Schema.Codec<T.CallState> = Schema.Literals(T.CallStateValues);

export const OrchestratorState: Schema.Codec<T.OrchestratorState> = Schema.Literals(T.OrchestratorStateValues);

export const SenderKind: Schema.Codec<T.SenderKind> = Schema.Literals(T.SenderKindValues);

export const MessageKind: Schema.Codec<T.MessageKind> = Schema.Literals(T.MessageKindValues);

export const Outcome: Schema.Codec<T.Outcome> = Schema.Literals(T.OutcomeValues);

export const Spent: Schema.Codec<T.Spent> = Schema.Struct({
  tokens: Schema.Number,
  cny: Schema.optionalKey(Schema.Number),
});

export const ChatMessage: Schema.Codec<T.ChatMessage> = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  conversation: Schema.String,
  from: Schema.String,
  fromKind: SenderKind,
  name: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  kind: MessageKind,
  text: Schema.String,
  final: Schema.Boolean,
  mentions: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  session: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Outcome),
  spent: Schema.optionalKey(Spent),
  spoken: Schema.optionalKey(Schema.Boolean),
  at: Schema.Number,
});

export const ConversationKind: Schema.Codec<T.ConversationKind> = Schema.Literals(T.ConversationKindValues);

export const SubjectKind: Schema.Codec<T.SubjectKind> = Schema.Literals(T.SubjectKindValues);

export const Conversation: Schema.Codec<T.Conversation> = Schema.Struct({
  id: Schema.String,
  kind: ConversationKind,
  parent: Schema.optionalKey(Schema.String),
  parentNumber: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  subjectKind: Schema.optionalKey(SubjectKind),
  subjectId: Schema.optionalKey(Schema.String),
  lastNumber: Schema.optionalKey(Schema.Number),
  replies: Schema.Number,
  read: Schema.optionalKey(Schema.Number),
  at: Schema.Number,
});

export const Conflict: Schema.Codec<T.Conflict> = Schema.Struct({
  base: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
});

export const SessionAction: Schema.Codec<T.SessionAction> = Schema.Literals(T.SessionActionValues);

export const Doing: Schema.Codec<T.Doing> = Schema.Struct({
  action: SessionAction,
  label: Schema.String,
  actionText: Schema.optionalKey(Schema.String),
});

export const PhaseArriving: Schema.Codec<T.PhaseArriving> = Schema.Struct({
  _tag: Schema.Literal("arriving"),
});

export const Retry: Schema.Codec<T.Retry> = Schema.Struct({
  attempt: Schema.Number,
  of: Schema.optionalKey(Schema.Number),
});

export const PhaseWorking: Schema.Codec<T.PhaseWorking> = Schema.Struct({
  _tag: Schema.Literal("working"),
  since: Schema.Number,
  doing: Doing,
  quietSince: Schema.optionalKey(Schema.Number),
  retry: Schema.optionalKey(Retry),
});

export const PhaseDone: Schema.Codec<T.PhaseDone> = Schema.Struct({
  _tag: Schema.Literal("done"),
});

export const PhaseFailed: Schema.Codec<T.PhaseFailed> = Schema.Struct({
  _tag: Schema.Literal("failed"),
});

export const PhaseResting: Schema.Codec<T.PhaseResting> = Schema.Struct({
  _tag: Schema.Literal("resting"),
});

export const SessionClose: Schema.Codec<T.SessionClose> = Schema.Literals(T.SessionCloseValues);
export const Delivery: Schema.Codec<T.Delivery> = Schema.Literals(T.DeliveryValues);
export const IssueCanceled: Schema.Codec<T.IssueCanceled> = Schema.Literals(T.IssueCanceledValues);

export const PhaseClosed: Schema.Codec<T.PhaseClosed> = Schema.Struct({
  _tag: Schema.Literal("closed"),
  at: Schema.Number,
  closed: SessionClose,
});

export const Phase: Schema.Codec<T.Phase> = Schema.Union([PhaseArriving, PhaseWorking, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

export const IssueAnswer: Schema.Codec<T.IssueAnswer> = Schema.Struct({
  conclusion: Schema.String,
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  unsure: Schema.mutable(Schema.Array(Schema.String)),
  next: Schema.mutable(Schema.Array(Schema.String)),
});

export const LastRun: Schema.Codec<T.LastRun> = Schema.Struct({
  outcome: Outcome,
  summary: Schema.String,
  at: Schema.Number,
  spent: Schema.optionalKey(Spent),
  answer: Schema.optionalKey(IssueAnswer),
});

export const SessionGraph: Schema.Codec<T.SessionGraph> = Schema.Struct({
  id: Schema.String,
  task: Schema.optionalKey(Schema.String),
});

export const ActionStep: Schema.Codec<T.ActionStep> = Schema.Struct({
  at: Schema.Number,
  action: SessionAction,
  label: Schema.String,
  actionText: Schema.optionalKey(Schema.String),
});

export const SessionPlay: Schema.Codec<T.SessionPlay> = Schema.Struct({
  station: Schema.Number,
  history: Schema.mutable(Schema.Array(ActionStep)),
  toolsThisRun: Schema.Number,
  counts: Schema.Record(Schema.String, Schema.Number),
  files: Schema.mutable(Schema.Array(Schema.String)),
  commands: Schema.mutable(Schema.Array(Schema.String)),
  runStartedAt: Schema.optionalKey(Schema.Number),
});

export const Session: Schema.Codec<T.Session> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
  runtime: Schema.String,
  brief: Schema.String,
  project: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  conflict: Schema.optionalKey(Conflict),
  hiredAt: Schema.Number,
  runs: Schema.Number,
  phase: Phase,
  lastRun: Schema.optionalKey(LastRun),
  spent: Schema.optionalKey(Spent),
  graph: Schema.optionalKey(SessionGraph),
  channel: Schema.optionalKey(Schema.String),
  play: Schema.optionalKey(SessionPlay),
  issue: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.Boolean),
  phaseText: Schema.optionalKey(Schema.String),
});

export const Repo: Schema.Codec<T.Repo> = Schema.Struct({
  path: Schema.String,
  commits: Schema.Number,
});

export const CommitCount: Schema.Codec<T.CommitCount> = Schema.Struct({
  total: Schema.Number,
  repos: Schema.mutable(Schema.Array(Repo)),
});

export const GraphState: Schema.Codec<T.GraphState> = Schema.Literals(T.GraphStateValues);

export const TaskState: Schema.Codec<T.TaskState> = Schema.Literals(T.TaskStateValues);

export const TaskAction: Schema.Codec<T.TaskAction> = Schema.Literals(T.TaskActionValues);

export const Task: Schema.Codec<T.Task> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  brief: Schema.String,
  needs: Schema.mutable(Schema.Array(Schema.String)),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  acceptance: Schema.optionalKey(Schema.Boolean),
  frozen: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  state: TaskState,
  session: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  spent: Schema.optionalKey(Spent),
  tries: Schema.Number,
  failures: Schema.optionalKey(Schema.Number),
  blockedBy: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  stateText: Schema.optionalKey(Schema.String),
  actions: Schema.optionalKey(Schema.mutable(Schema.Array(TaskAction))),
  actionText: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  canEdit: Schema.optionalKey(Schema.Boolean),
  canRemove: Schema.optionalKey(Schema.Boolean),
});

export const GraphAction: Schema.Codec<T.GraphAction> = Schema.Literals(T.GraphActionValues);

export const TaskGraph: Schema.Codec<T.TaskGraph> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  project: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  state: GraphState,
  stateTag: Schema.optionalKey(Schema.String),
  actionText: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  actions: Schema.optionalKey(Schema.mutable(Schema.Array(GraphAction))),
  tasks: Schema.mutable(Schema.Array(Task)),
  parallel: Schema.Number,
  note: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  layers: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(Schema.String))))),
  asksForYou: Schema.optionalKey(Schema.Boolean),
  spent: Schema.optionalKey(Spent),
  settled: Schema.optionalKey(Schema.Number),
});

export const Unlock: Schema.Codec<T.Unlock> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Number,
  at: Schema.Number,
});

export const AgentTally: Schema.Codec<T.AgentTally> = Schema.Struct({
  hired: Schema.Number,
  harvested: Schema.Number,
  failed: Schema.Number,
});

export const ProgressTitle: Schema.Codec<T.ProgressTitle> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Number,
});

export const Progress: Schema.Codec<T.Progress> = Schema.Struct({
  coins: Schema.Number,
  streak: Schema.Number,
  bestStreak: Schema.Number,
  counts: Schema.Record(Schema.String, Schema.Number),
  unlocked: Schema.mutable(Schema.Array(Unlock)),
  title: Schema.optionalKey(ProgressTitle),
  agents: Schema.optionalKey(Schema.Record(Schema.String, AgentTally)),
  multiplier: Schema.optionalKey(Schema.Number),
});

export const ProgressNews: Schema.Codec<T.ProgressNews> = Schema.Struct({
  coins: Schema.optionalKey(Schema.Number),
  session: Schema.optionalKey(Schema.String),
  unlocked: Schema.optionalKey(Schema.mutable(Schema.Array(Unlock))),
});

export const RecurrenceWhenOnce: Schema.Codec<T.RecurrenceWhenOnce> = Schema.Struct({
  kind: Schema.Literal("once"),
  at: Schema.Number,
});

export const RecurrenceWhenEvery: Schema.Codec<T.RecurrenceWhenEvery> = Schema.Struct({
  kind: Schema.Literal("every"),
  minutes: Schema.Number,
});

export const RecurrenceWhenDaily: Schema.Codec<T.RecurrenceWhenDaily> = Schema.Struct({
  kind: Schema.Literal("daily"),
  time: Schema.String,
});

export const RecurrenceWhenWeekly: Schema.Codec<T.RecurrenceWhenWeekly> = Schema.Struct({
  kind: Schema.Literal("weekly"),
  days: Schema.mutable(Schema.Array(Schema.Number)),
  time: Schema.String,
});

export const RecurrenceWhenCron: Schema.Codec<T.RecurrenceWhenCron> = Schema.Struct({
  kind: Schema.Literal("cron"),
  expr: Schema.String,
});

export const RecurrenceWhen: Schema.Codec<T.RecurrenceWhen> = Schema.Union([
  RecurrenceWhenOnce,
  RecurrenceWhenEvery,
  RecurrenceWhenDaily,
  RecurrenceWhenWeekly,
  RecurrenceWhenCron,
]);

export const RecurrenceBy: Schema.Codec<T.RecurrenceBy> = Schema.Literals(T.RecurrenceByValues);

export const Recurrence: Schema.Codec<T.Recurrence> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  text: Schema.String,
  channel: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  when: RecurrenceWhen,
  tz: Schema.String,
  enabled: Schema.Boolean,
  created: Schema.Number,
  lastRun: Schema.optionalKey(Schema.Number),
  by: RecurrenceBy,
  pending: Schema.optionalKey(Schema.Boolean),
  whenText: Schema.optionalKey(Schema.String),
  nextText: Schema.optionalKey(Schema.String),
});

export const OwnerMention: Schema.Codec<T.OwnerMention> = Schema.Struct({
  message: ChatMessage,
  channel: Schema.String,
  address: Schema.String,
});

export const Chat: Schema.Codec<T.Chat> = Schema.Struct({
  conversations: Schema.mutable(Schema.Array(Conversation)),
  messages: Schema.mutable(Schema.Array(ChatMessage)),
  ownerMentions: Schema.optionalKey(Schema.mutable(Schema.Array(OwnerMention))),
});

export const Priority: Schema.Codec<T.Priority> = Schema.Literals(T.PriorityValues);

export const IssueGraph: Schema.Codec<T.IssueGraph> = Schema.Struct({
  state: GraphState,
  branch: Schema.optionalKey(Schema.String),
  parallel: Schema.Number,
  note: Schema.optionalKey(Schema.String),
});

export const IssueTask: Schema.Codec<T.IssueTask> = Schema.Struct({
  key: Schema.String,
  state: TaskState,
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  acceptance: Schema.optionalKey(Schema.Boolean),
  frozen: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  session: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  spent: Schema.optionalKey(Spent),
  tries: Schema.Number,
  failures: Schema.optionalKey(Schema.Number),
});

export const IssueStatus: Schema.Codec<T.IssueStatus> = Schema.Literals(T.IssueStatusValues);

export const PullRequestState: Schema.Codec<T.PullRequestState> = Schema.Literals(T.PullRequestStateValues);

export const PullRequest: Schema.Codec<T.PullRequest> = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  state: PullRequestState,
});

export const Review: Schema.Codec<T.Review> = Schema.Literals(T.ReviewValues);

export const Finding: Schema.Codec<T.Finding> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  at: Schema.Number,
  pulled: Schema.optionalKey(Schema.Boolean),
});

export const IssueRefining: Schema.Codec<T.IssueRefining> = Schema.Struct({
  session: Schema.String,
  name: Schema.String,
});

export const Question: Schema.Codec<T.Question> = Schema.Struct({
  question: Schema.String,
  options: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const CheckResult: Schema.Codec<T.CheckResult> = Schema.Literals(T.CheckResultValues);

export const CriterionCheck: Schema.Codec<T.CriterionCheck> = Schema.Struct({
  criterion: Schema.Number,
  result: CheckResult,
  proof: Schema.optionalKey(Schema.String),
});

export const Attention: Schema.Codec<T.Attention> = Schema.Literals(T.AttentionValues);
export const StuckReason: Schema.Codec<T.StuckReason> = Schema.Literals(T.StuckReasonValues);
export const IssueAct: Schema.Codec<T.IssueAct> = Schema.Literals(T.IssueActValues);

export const IssueAttention: Schema.Codec<T.IssueAttention> = Schema.Struct({
  state: Attention,
  since: Schema.optionalKey(Schema.Number),
  stuck: Schema.optionalKey(StuckReason),
  lead: Schema.optionalKey(IssueAct),
  acts: Schema.mutable(Schema.Array(IssueAct)),
});

export const MilestoneKind: Schema.Codec<T.MilestoneKind> = Schema.Literals(T.MilestoneKindValues);

export const Milestone: Schema.Codec<T.Milestone> = Schema.Struct({
  at: Schema.Number,
  kind: MilestoneKind,
  who: Schema.optionalKey(Schema.String),
  text: Schema.String,
});

export const IssueTimeline: Schema.Codec<T.IssueTimeline> = Schema.Struct({
  milestones: Schema.mutable(Schema.Array(Milestone)),
  spent: Schema.optionalKey(Spent),
});

export const IssueRun: Schema.Codec<T.IssueRun> = Schema.Struct({
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  outcome: Schema.optionalKey(Outcome),
});

export const Deliverable: Schema.Codec<T.Deliverable> = Schema.Literals(T.DeliverableValues);

export const Issue: Schema.Codec<T.Issue> = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Priority,
  rank: Schema.optionalKey(Schema.Number),
  createdAt: Schema.Number,
  queuedAt: Schema.optionalKey(Schema.Number),
  sessions: Schema.mutable(Schema.Array(Schema.String)),
  closedAt: Schema.optionalKey(Schema.Number),
  delivered: Schema.optionalKey(Delivery),
  canceled: Schema.optionalKey(IssueCanceled),
  parent: Schema.optionalKey(Schema.String),
  blockedBy: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  graph: Schema.optionalKey(IssueGraph),
  task: Schema.optionalKey(IssueTask),
  recurrence: Schema.optionalKey(Schema.String),
  status: IssueStatus,
  moves: Schema.mutable(Schema.Array(IssueStatus)),
  pullRequest: Schema.optionalKey(PullRequest),
  review: Review,
  deliver: Deliverable,
  reviewedAt: Schema.optionalKey(Schema.Number),
  findings: Schema.mutable(Schema.Array(Finding)),
  questions: Schema.mutable(Schema.Array(Question)),
  criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  checks: Schema.optionalKey(Schema.mutable(Schema.Array(CriterionCheck))),
  drafting: Schema.optionalKey(IssueRefining),
  lastRun: Schema.optionalKey(IssueRun),
  answer: Schema.optionalKey(IssueAnswer),
  attention: IssueAttention,
});

export const WorkspaceState: Schema.Codec<T.WorkspaceState> = Schema.Struct({
  call: CallState,
  callReason: Schema.optionalKey(Schema.String),
  orchestrator: OrchestratorState,
  sessions: Schema.mutable(Schema.Array(Session)),
  chat: Schema.optionalKey(Chat),
  commits: Schema.optionalKey(CommitCount),
  progress: Schema.optionalKey(Progress),
  recurrences: Schema.optionalKey(Schema.mutable(Schema.Array(Recurrence))),
  issues: Schema.optionalKey(Schema.mutable(Schema.Array(Issue))),
});

export const SessionEventType: Schema.Codec<T.SessionEventType> = Schema.Literals(T.SessionEventTypeValues);

export const ToolAction: Schema.Codec<T.ToolAction> = Schema.Literals(T.ToolActionValues);

export const EventTokens: Schema.Codec<T.EventTokens> = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  output: Schema.Number,
});

export const SessionEvent: Schema.Codec<T.SessionEvent> = Schema.Struct({
  seq: Schema.Number,
  revision: Schema.Number,
  time: Schema.Number,
  type: SessionEventType,
  run: Schema.optionalKey(Schema.String),
  call: Schema.optionalKey(Schema.Number),
  under: Schema.optionalKey(Schema.Number),
  text: Schema.String,
  action: Schema.optionalKey(ToolAction),
  actionText: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.String),
  ok: Schema.optionalKey(Schema.Boolean),
  tokens: Schema.optionalKey(EventTokens),
});

export const NoticeLevel: Schema.Codec<T.NoticeLevel> = Schema.Literals(T.NoticeLevelValues);

export const Via: Schema.Codec<T.Via> = Schema.Literals(T.ViaValues);

export const InstallationAvailable: Schema.Codec<T.InstallationAvailable> = Schema.Struct({
  status: Schema.Literal("available"),
  via: Via,
  command: Schema.String,
  version: Schema.NullOr(Schema.String),
});

export const InstallationNotFound: Schema.Codec<T.InstallationNotFound> = Schema.Struct({
  status: Schema.Literal("not_found"),
});

export const InstallationChecking: Schema.Codec<T.InstallationChecking> = Schema.Struct({
  status: Schema.Literal("checking"),
});

export const InstallationUnsupported: Schema.Codec<T.InstallationUnsupported> = Schema.Struct({
  status: Schema.Literal("unsupported"),
  reason: Schema.String,
});

export const Installation: Schema.Codec<T.Installation> = Schema.Union([
  InstallationAvailable,
  InstallationNotFound,
  InstallationChecking,
  InstallationUnsupported,
]);

export const ModelEntry: Schema.Codec<T.ModelEntry> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  effortLevels: Schema.mutable(Schema.Array(Schema.String)),
  isDefault: Schema.Boolean,
});

export const UsageWindow: Schema.Codec<T.UsageWindow> = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.Number),
});

export const Balance: Schema.Codec<T.Balance> = Schema.Struct({
  currency: Schema.String,
  amount: Schema.Number,
});

export const AccountUsageOk: Schema.Codec<T.AccountUsageOk> = Schema.Struct({
  status: Schema.Literal("ok"),
  subscription: Schema.NullOr(Schema.String),
  windows: Schema.mutable(Schema.Array(UsageWindow)),
});

export const AccountUsageBalance: Schema.Codec<T.AccountUsageBalance> = Schema.Struct({
  status: Schema.Literal("balance"),
  provider: Schema.String,
  available: Schema.Boolean,
  balances: Schema.mutable(Schema.Array(Balance)),
});

export const AccountUsageLoginRequired: Schema.Codec<T.AccountUsageLoginRequired> = Schema.Struct({
  status: Schema.Literal("login_required"),
});

export const AccountUsageUnavailable: Schema.Codec<T.AccountUsageUnavailable> = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
});

export const AccountUsage: Schema.Codec<T.AccountUsage> = Schema.Union([
  AccountUsageOk,
  AccountUsageBalance,
  AccountUsageLoginRequired,
  AccountUsageUnavailable,
]);

export const InventoryEntry: Schema.Codec<T.InventoryEntry> = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const RuntimeSettings: Schema.Codec<T.RuntimeSettings> = Schema.Struct({
  enabled: Schema.Boolean,
  binPath: Schema.String,
  defaultModel: Schema.String,
  defaultEffort: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  dailyBudget: Schema.optionalKey(Schema.Number),
  maxWorking: Schema.optionalKey(Schema.Number),
});

export const RuntimeInfo: Schema.Codec<T.RuntimeInfo> = Schema.Struct({
  id: Schema.String,
  preset: RuntimePreset,
  facts: RuntimeFacts,
  installation: Installation,
  models: Schema.NullOr(Schema.mutable(Schema.Array(ModelEntry))),
  usage: Schema.NullOr(AccountUsage),
  skills: Schema.NullOr(Schema.mutable(Schema.Array(InventoryEntry))),
  mcpServers: Schema.NullOr(Schema.mutable(Schema.Array(InventoryEntry))),
  tools: Schema.NullOr(Schema.mutable(Schema.Array(InventoryEntry))),
  settings: RuntimeSettings,
  spentToday: Schema.optionalKey(Schema.Number),
  quota: Schema.optionalKey(RuntimeQuota),
  stop: Schema.optionalKey(Schema.String),
  checkedAt: Schema.Number,
});

export const FarmLevel: Schema.Codec<T.FarmLevel> = Schema.Struct({
  level: Schema.Number,
  xp: Schema.Number,
  need: Schema.Number,
});

export const InboxKind: Schema.Codec<T.InboxKind> = Schema.Literals(T.InboxKindValues);

export const InboxFromSession: Schema.Codec<T.InboxFromSession> = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
});

export const InboxFromOrchestrator: Schema.Codec<T.InboxFromOrchestrator> = Schema.Struct({
  kind: Schema.Literal("orchestrator"),
});

export const InboxFrom: Schema.Codec<T.InboxFrom> = Schema.Union([InboxFromSession, InboxFromOrchestrator]);

export const InboxTargetSession: Schema.Codec<T.InboxTargetSession> = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
});

export const InboxTargetGraph: Schema.Codec<T.InboxTargetGraph> = Schema.Struct({
  kind: Schema.Literal("graph"),
  graph: Schema.String,
});

export const InboxTargetChat: Schema.Codec<T.InboxTargetChat> = Schema.Struct({
  kind: Schema.Literal("chat"),
  conversation: Schema.String,
});

export const InboxTarget: Schema.Codec<T.InboxTarget> = Schema.Union([InboxTargetSession, InboxTargetGraph, InboxTargetChat]);

export const InboxWords: Schema.Codec<T.InboxWords> = Schema.Struct({
  label: Schema.String,
  title: Schema.String,
  body: Schema.String,
  tray: Schema.optionalKey(Schema.String),
});

export const InboxItem: Schema.Codec<T.InboxItem> = Schema.Struct({
  id: Schema.String,
  kind: InboxKind,
  from: InboxFrom,
  who: Schema.String,
  text: Schema.String,
  at: Schema.Number,
  target: InboxTarget,
  words: InboxWords,
});

export const Crop: Schema.Codec<T.Crop> = Schema.Literals(T.CropValues);

export const BadgeTone: Schema.Codec<T.BadgeTone> = Schema.Literals(T.BadgeToneValues);

export const Badge: Schema.Codec<T.Badge> = Schema.Struct({
  text: Schema.String,
  tone: BadgeTone,
});

export const PlotView: Schema.Codec<T.PlotView> = Schema.Struct({
  crop: Crop,
  badge: Schema.optionalKey(Badge),
});

export const FarmView: Schema.Codec<T.FarmView> = Schema.Struct({
  level: FarmLevel,
  plots: Schema.Record(Schema.String, PlotView),
  achievements: Schema.mutable(Schema.Array(AchievementStanding)),
});

export const GameEffectReward: Schema.Codec<T.GameEffectReward> = Schema.Struct({
  kind: Schema.Literal("reward"),
  sessionId: Schema.String,
  coins: Schema.Number,
  streak: Schema.Number,
});

export const GameEffectPenalty: Schema.Codec<T.GameEffectPenalty> = Schema.Struct({
  kind: Schema.Literal("penalty"),
  sessionId: Schema.String,
});

export const GameEffectLevelUp: Schema.Codec<T.GameEffectLevelUp> = Schema.Struct({
  kind: Schema.Literal("levelUp"),
  level: Schema.Number,
});

export const GameEffectAchievement: Schema.Codec<T.GameEffectAchievement> = Schema.Struct({
  kind: Schema.Literal("achievement"),
  achievement: Schema.String,
  tier: Schema.Number,
  title: Schema.String,
  reached: Schema.String,
  detail: Schema.String,
  coins: Schema.Number,
  oneOff: Schema.optionalKey(Schema.Boolean),
});

export const GameEffect: Schema.Codec<T.GameEffect> = Schema.Union([GameEffectReward, GameEffectPenalty, GameEffectLevelUp, GameEffectAchievement]);

export const StateFrame: Schema.Codec<T.StateFrame> = Schema.Struct({
  state: WorkspaceState,
  inbox: Schema.mutable(Schema.Array(InboxItem)),
  graphs: Schema.mutable(Schema.Array(TaskGraph)),
  view: FarmView,
  effects: Schema.mutable(Schema.Array(GameEffect)),
});

export const LedgerEntryHarvested: Schema.Codec<T.LedgerEntryHarvested> = Schema.Struct({
  kind: Schema.Literal("harvested"),
  at: Schema.Number,
  session: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  project: Schema.String,
  runtime: Schema.String,
  commits: Schema.Number,
  cny: Schema.optionalKey(Schema.Number),
  runs: Schema.Number,
});

export const LedgerEntryFailed: Schema.Codec<T.LedgerEntryFailed> = Schema.Struct({
  kind: Schema.Literal("failed"),
  at: Schema.Number,
  session: Schema.String,
  agent: Schema.optionalKey(Schema.String),
});

export const LedgerEntryConflicted: Schema.Codec<T.LedgerEntryConflicted> = Schema.Struct({
  kind: Schema.Literal("conflicted"),
  at: Schema.Number,
  session: Schema.String,
});

export const LedgerEntryTold: Schema.Codec<T.LedgerEntryTold> = Schema.Struct({
  kind: Schema.Literal("told"),
  at: Schema.Number,
  session: Schema.String,
});

export const LedgerEntryReviewed: Schema.Codec<T.LedgerEntryReviewed> = Schema.Struct({
  kind: Schema.Literal("reviewed"),
  at: Schema.Number,
  session: Schema.String,
});

export const LedgerEntryGraph: Schema.Codec<T.LedgerEntryGraph> = Schema.Struct({
  kind: Schema.Literal("graph"),
  at: Schema.Number,
  graph: Schema.String,
  merged: Schema.Number,
  parallel: Schema.Boolean,
});

export const LedgerEntryHandoff: Schema.Codec<T.LedgerEntryHandoff> = Schema.Struct({
  kind: Schema.Literal("handoff"),
  at: Schema.Number,
  session: Schema.String,
  to: Schema.String,
});

export const LedgerEntryCalled: Schema.Codec<T.LedgerEntryCalled> = Schema.Struct({
  kind: Schema.Literal("called"),
  at: Schema.Number,
  session: Schema.String,
});

export const LedgerEntryHired: Schema.Codec<T.LedgerEntryHired> = Schema.Struct({
  kind: Schema.Literal("hired"),
  at: Schema.Number,
  session: Schema.String,
  agent: Schema.optionalKey(Schema.String),
});

export const LedgerEntryMomentKind: Schema.Codec<T.LedgerEntryMomentKind> = Schema.Literals(T.LedgerEntryMomentKindValues);

export const LedgerEntryMoment: Schema.Codec<T.LedgerEntryMoment> = Schema.Struct({
  kind: LedgerEntryMomentKind,
  at: Schema.Number,
});

export const LedgerEntryLevel: Schema.Codec<T.LedgerEntryLevel> = Schema.Struct({
  kind: Schema.Literal("level"),
  at: Schema.Number,
  level: Schema.Number,
});

export const LedgerEntryTitled: Schema.Codec<T.LedgerEntryTitled> = Schema.Struct({
  kind: Schema.Literal("titled"),
  at: Schema.Number,
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Number),
});

export const LedgerEntry: Schema.Codec<T.LedgerEntry> = Schema.Union([
  LedgerEntryHarvested,
  LedgerEntryFailed,
  LedgerEntryConflicted,
  LedgerEntryTold,
  LedgerEntryReviewed,
  LedgerEntryGraph,
  LedgerEntryHandoff,
  LedgerEntryCalled,
  LedgerEntryHired,
  LedgerEntryMoment,
  LedgerEntryLevel,
  LedgerEntryTitled,
]);

export const GraphEventKind: Schema.Codec<T.GraphEventKind> = Schema.Literals(T.GraphEventKindValues);

export const GraphActor: Schema.Codec<T.GraphActor> = Schema.Literals(T.GraphActorValues);

export const TaskFieldChange: Schema.Codec<T.TaskFieldChange> = Schema.Struct({
  field: Schema.String,
  from: Schema.String,
  to: Schema.String,
});

export const GraphEvent: Schema.Codec<T.GraphEvent> = Schema.Struct({
  id: Schema.String,
  graph: Schema.String,
  task: Schema.optionalKey(Schema.String),
  kind: GraphEventKind,
  actor: GraphActor,
  session: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  changes: Schema.optionalKey(Schema.mutable(Schema.Array(TaskFieldChange))),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  at: Schema.Number,
  text: Schema.optionalKey(Schema.String),
  actorText: Schema.optionalKey(Schema.String),
});

export const LanDevice: Schema.Codec<T.LanDevice> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  pairedAt: Schema.Number,
  lastSeen: Schema.optionalKey(Schema.Number),
});

export const LanPaired: Schema.Codec<T.LanPaired> = Schema.Struct({
  device: Schema.String,
  key: Schema.String,
  hostName: Schema.String,
});

export const LanPairRequest: Schema.Codec<T.LanPairRequest> = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
});

export const LanPairing: Schema.Codec<T.LanPairing> = Schema.Struct({
  code: Schema.String,
  link: Schema.String,
  expiresAt: Schema.Number,
  asking: Schema.optionalKey(Schema.String),
});

export const LanStatus: Schema.Codec<T.LanStatus> = Schema.Struct({
  open: Schema.Boolean,
  hostName: Schema.String,
  url: Schema.optionalKey(Schema.String),
  problem: Schema.optionalKey(Schema.String),
  pairing: Schema.optionalKey(LanPairing),
  devices: Schema.mutable(Schema.Array(LanDevice)),
});

export const ConnectorID: Schema.Codec<T.ConnectorID> = Schema.Literals(T.ConnectorIDValues);

export const ConnectorState: Schema.Codec<T.ConnectorState> = Schema.Literals(T.ConnectorStateValues);

export const ConnectorStatus: Schema.Codec<T.ConnectorStatus> = Schema.Struct({
  id: ConnectorID,
  state: ConnectorState,
  qr: Schema.optionalKey(Schema.String),
  pairCode: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.Number),
  lastInbound: Schema.optionalKey(Schema.Number),
  pausedUntil: Schema.optionalKey(Schema.Number),
  pending: Schema.Number,
  error: Schema.optionalKey(Schema.String),
});

export const ConnectorLogin: Schema.Codec<T.ConnectorLogin> = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  appId: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
});

export const VoiceAgent: Schema.Codec<T.VoiceAgent> = Schema.Struct({
  agentId: Schema.String,
  answeredBy: Schema.optionalKey(Schema.Literals(["orchestrator", "agora"])),
});

export const AgoraGrant: Schema.Codec<T.AgoraGrant> = Schema.Struct({
  appId: Schema.String,
  channel: Schema.String,
  uid: Schema.String,
  token: Schema.String,
});

export const DayCount: Schema.Codec<T.DayCount> = Schema.Struct({
  day: Schema.String,
  commits: Schema.Number,
});

export const Author: Schema.Codec<T.Author> = Schema.Struct({
  name: Schema.String,
  commits: Schema.Number,
});

export const ProjectActivity: Schema.Codec<T.ProjectActivity> = Schema.Struct({
  project: Schema.String,
  at: Schema.Number,
  days: Schema.mutable(Schema.Array(DayCount)),
  authors: Schema.mutable(Schema.Array(Author)),
  total: Schema.Number,
  first: Schema.optionalKey(Schema.Number),
  last: Schema.optionalKey(Schema.Number),
});

export const LanguageCount: Schema.Codec<T.LanguageCount> = Schema.Struct({
  name: Schema.String,
  files: Schema.Number,
  code: Schema.Number,
  comments: Schema.Number,
  blanks: Schema.Number,
});

export const ProjectLanguages: Schema.Codec<T.ProjectLanguages> = Schema.Struct({
  project: Schema.String,
  at: Schema.Number,
  languages: Schema.mutable(Schema.Array(LanguageCount)),
});

export const ProjectStack: Schema.Codec<T.ProjectStack> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  test: Schema.optionalKey(Schema.String),
  lint: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(Schema.String),
});

export const TemplateBlank: Schema.Codec<T.TemplateBlank> = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
});

export const IssueTemplate: Schema.Codec<T.IssueTemplate> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.String,
  text: Schema.String,
  blank: Schema.optionalKey(TemplateBlank),
});

export const TemplateKind: Schema.Codec<T.TemplateKind> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  templates: Schema.mutable(Schema.Array(IssueTemplate)),
});

export const ProjectTemplates: Schema.Codec<T.ProjectTemplates> = Schema.Struct({
  project: Schema.String,
  stack: ProjectStack,
  recent: Schema.mutable(Schema.Array(Schema.String)),
  kinds: Schema.mutable(Schema.Array(TemplateKind)),
});

export const IssueUpdate: Schema.Codec<T.IssueUpdate> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  review: Schema.optionalKey(Review),
  criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  deliver: Schema.optionalKey(Deliverable),
});

export const IssueDispatchRequest: Schema.Codec<T.IssueDispatchRequest> = Schema.Struct({
  station: Schema.optionalKey(Schema.Number),
  edit: Schema.optionalKey(IssueUpdate),
});

export const PullRequestCapability: Schema.Codec<T.PullRequestCapability> = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.String,
});

export const ProjectSummary: Schema.Codec<T.ProjectSummary> = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  git: Schema.Boolean,
  last: Schema.optionalKey(Schema.Number),
  maxSessions: Schema.Number,
  pullRequest: PullRequestCapability,
});

export const NewProject: Schema.Codec<T.NewProject> = Schema.Struct({
  name: Schema.String,
  github: Schema.optionalKey(Schema.String),
});

export const Skill: Schema.Codec<T.Skill> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
});

export const OrchestratorEvalRequest: Schema.Codec<T.OrchestratorEvalRequest> = Schema.Struct({
  on: Schema.Number,
  want: Schema.String,
});

export const OrchestratorEval: Schema.Codec<T.OrchestratorEval> = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
});

export const ArchiveFile: Schema.Codec<T.ArchiveFile> = Schema.Struct({
  name: Schema.String,
  at: Schema.Number,
  chars: Schema.Number,
});

export const ArchiveHit: Schema.Codec<T.ArchiveHit> = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  text: Schema.String,
});

export const ArchiveListing: Schema.Codec<T.ArchiveListing> = Schema.Struct({
  files: Schema.mutable(Schema.Array(ArchiveFile)),
  hits: Schema.mutable(Schema.Array(ArchiveHit)),
});

export const MemoryKind: Schema.Codec<T.MemoryKind> = Schema.Literals(T.MemoryKindValues);

export const MemoryAuthor: Schema.Codec<T.MemoryAuthor> = Schema.Literals(T.MemoryAuthorValues);

export const Memory: Schema.Codec<T.Memory> = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  kind: MemoryKind,
  text: Schema.String,
  author: Schema.optionalKey(MemoryAuthor),
  project: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(Schema.String),
  at: Schema.Number,
  recalled: Schema.Number,
  recalledAt: Schema.optionalKey(Schema.Number),
  fading: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.String),
});

export const MemoryRequest: Schema.Codec<T.MemoryRequest> = Schema.Struct({
  text: Schema.String,
  project: Schema.optionalKey(Schema.String),
});

export const MemorySourceInfo: Schema.Codec<T.MemorySourceInfo> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  on: Schema.Boolean,
  off: Schema.optionalKey(Schema.String),
  canList: Schema.Boolean,
  canForget: Schema.Boolean,
  transcripts: Schema.Boolean,
});

export const MemoryList: Schema.Codec<T.MemoryList> = Schema.Struct({
  memories: Schema.mutable(Schema.Array(Memory)),
  sources: Schema.mutable(Schema.Array(MemorySourceInfo)),
  file: Schema.optionalKey(Schema.String),
  carried: Schema.optionalKey(Schema.Number),
});

export const Commit: Schema.Codec<T.Commit> = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
  at: Schema.Number,
});

export const ChangedFile: Schema.Codec<T.ChangedFile> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  patch: Schema.optionalKey(Schema.String),
});

export const UncommittedItem: Schema.Codec<T.UncommittedItem> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
});

export const Changes: Schema.Codec<T.Changes> = Schema.Struct({
  project: Schema.String,
  base: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  commits: Schema.mutable(Schema.Array(Commit)),
  files: Schema.mutable(Schema.Array(ChangedFile)),
  uncommitted: Schema.mutable(Schema.Array(UncommittedItem)),
  conflicts: Schema.mutable(Schema.Array(Schema.String)),
  behind: Schema.Number,
});

export const TaskEdit: Schema.Codec<T.TaskEdit> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  brief: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const GraphSplitRequest: Schema.Codec<T.GraphSplitRequest> = Schema.Struct({
  goal: Schema.String,
  project: Schema.String,
  agent: Schema.optionalKey(Schema.String),
});

export const Dispatched: Schema.Codec<T.Dispatched> = Schema.Struct({
  session: Schema.optionalKey(Schema.String),
  queued: Schema.optionalKey(Schema.String),
});

export const IssueHistory: Schema.Codec<T.IssueHistory> = Schema.Struct({
  issue: Issue,
  sessions: Schema.mutable(Schema.Array(Session)),
  missingSessions: Schema.mutable(Schema.Array(Schema.String)),
});

export const IssueRefineRequest: Schema.Codec<T.IssueRefineRequest> = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(IssueUpdate),
});

export const IssueActRequest: Schema.Codec<T.IssueActRequest> = Schema.Struct({
  act: IssueAct,
  text: Schema.optionalKey(Schema.String),
  findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  sendKey: Schema.optionalKey(Schema.String),
});

export const IssueReviewRequest: Schema.Codec<T.IssueReviewRequest> = Schema.Struct({
  pass: Schema.Boolean,
  findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  text: Schema.optionalKey(Schema.String),
});

export const IssueRequest: Schema.Codec<T.IssueRequest> = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  review: Schema.optionalKey(Review),
  deliver: Schema.optionalKey(Deliverable),
});

export const RunTriggerKind: Schema.Codec<T.RunTriggerKind> = Schema.Literals(T.RunTriggerKindValues);

export const RunTrigger: Schema.Codec<T.RunTrigger> = Schema.Struct({
  kind: RunTriggerKind,
  message: Schema.optionalKey(Schema.String),
  recurrence: Schema.optionalKey(Schema.String),
  missed: Schema.optionalKey(Schema.Boolean),
});

export const Run: Schema.Codec<T.Run> = Schema.Struct({
  id: Schema.String,
  session: Schema.String,
  issue: Schema.optionalKey(Schema.String),
  triggeredBy: RunTrigger,
  heard: Schema.mutable(Schema.Array(Schema.String)),
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  outcome: Schema.optionalKey(Outcome),
  summary: Schema.optionalKey(Schema.String),
  spent: Schema.optionalKey(Spent),
});

export const CommentRequest: Schema.Codec<T.CommentRequest> = Schema.Struct({
  text: Schema.String,
  sendKey: Schema.optionalKey(Schema.String),
});

export const SayRequest: Schema.Codec<T.SayRequest> = Schema.Struct({
  text: Schema.String,
  station: Schema.optionalKey(Schema.Number),
  conversation: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const ChannelUpdate: Schema.Codec<T.ChannelUpdate> = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});

export const RecurrenceRequest: Schema.Codec<T.RecurrenceRequest> = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
  channel: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  when: RecurrenceWhen,
  tz: Schema.optionalKey(Schema.String),
});

export const ChannelRequest: Schema.Codec<T.ChannelRequest> = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});

export const KeySource: Schema.Codec<T.KeySource> = Schema.Literals(T.KeySourceValues);

export const KeyStatus: Schema.Codec<T.KeyStatus> = Schema.Struct({
  source: Schema.optionalKey(KeySource),
  hint: Schema.optionalKey(Schema.String),
});

export const AgoraAppID: Schema.Codec<T.AgoraAppID> = Schema.Struct({
  source: Schema.optionalKey(KeySource),
  value: Schema.optionalKey(Schema.String),
});

export const Area: Schema.Codec<T.Area> = Schema.Literals(T.AreaValues);

export const Language: Schema.Codec<T.Language> = Schema.Literals(T.LanguageValues);

export const VoiceASRAres: Schema.Codec<T.VoiceASRAres> = Schema.Struct({
  vendor: Schema.Literal("ares"),
});

export const Model: Schema.Codec<T.Model> = Schema.Literals(T.ModelValues);

export const VoiceASRDeepgram: Schema.Codec<T.VoiceASRDeepgram> = Schema.Struct({
  vendor: Schema.Literal("deepgram"),
  model: Model,
});

export const VoiceASRMicrosoft: Schema.Codec<T.VoiceASRMicrosoft> = Schema.Struct({
  vendor: Schema.Literal("microsoft"),
  region: Schema.String,
});

export const VoiceASR: Schema.Codec<T.VoiceASR> = Schema.Union([VoiceASRAres, VoiceASRDeepgram, VoiceASRMicrosoft]);

export const VoiceAnswerOrchestrator: Schema.Codec<T.VoiceAnswerOrchestrator> = Schema.Struct({
  vendor: Schema.Literal("orchestrator"),
});

export const VoiceAnswerAgoraModel: Schema.Codec<T.VoiceAnswerAgoraModel> = Schema.Literals(T.VoiceAnswerAgoraModelValues);

export const VoiceAnswerAgora: Schema.Codec<T.VoiceAnswerAgora> = Schema.Struct({
  vendor: Schema.Literal("agora"),
  model: VoiceAnswerAgoraModel,
});

export const VoiceAnswerDeepseek: Schema.Codec<T.VoiceAnswerDeepseek> = Schema.Struct({
  vendor: Schema.Literal("deepseek"),
  model: Schema.String,
});

export const VoiceAnswerOpenai: Schema.Codec<T.VoiceAnswerOpenai> = Schema.Struct({
  vendor: Schema.Literal("openai"),
  url: Schema.String,
  model: Schema.String,
});

export const VoiceAnswer: Schema.Codec<T.VoiceAnswer> = Schema.Union([VoiceAnswerOrchestrator, VoiceAnswerAgora, VoiceAnswerDeepseek, VoiceAnswerOpenai]);

export const VoiceTTSMinimaxModel: Schema.Codec<T.VoiceTTSMinimaxModel> = Schema.Literals(T.VoiceTTSMinimaxModelValues);

export const VoiceTTSMinimax: Schema.Codec<T.VoiceTTSMinimax> = Schema.Struct({
  vendor: Schema.Literal("minimax"),
  model: VoiceTTSMinimaxModel,
  voiceId: Schema.String,
});

export const Voice: Schema.Codec<T.Voice> = Schema.Literals(T.VoiceValues);

export const VoiceTTSOpenai: Schema.Codec<T.VoiceTTSOpenai> = Schema.Struct({
  vendor: Schema.Literal("openai"),
  voice: Voice,
});

export const VoiceTTSMicrosoft: Schema.Codec<T.VoiceTTSMicrosoft> = Schema.Struct({
  vendor: Schema.Literal("microsoft"),
  region: Schema.String,
  voiceName: Schema.String,
});

export const VoiceTTS: Schema.Codec<T.VoiceTTS> = Schema.Union([VoiceTTSMinimax, VoiceTTSOpenai, VoiceTTSMicrosoft]);

export const VoiceSettings: Schema.Codec<T.VoiceSettings> = Schema.Struct({
  area: Area,
  language: Language,
  asr: VoiceASR,
  answer: VoiceAnswer,
  tts: VoiceTTS,
  persona: Schema.String,
  greeting: Schema.String,
  failureMessage: Schema.String,
  silenceMs: Schema.Number,
  interruptMs: Schema.Number,
  idleSeconds: Schema.Number,
});

export const Dictation: Schema.Codec<T.Dictation> = Schema.Struct({
  url: Schema.String,
  model: Schema.String,
});

export const MemorySourceKind: Schema.Codec<T.MemorySourceKind> = Schema.Literals(T.MemorySourceKindValues);

export const MemorySource: Schema.Codec<T.MemorySource> = Schema.Struct({
  kind: MemorySourceKind,
  url: Schema.String,
  enabled: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  everything: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.String),
  key: KeyStatus,
});

export const SettingsStatus: Schema.Codec<T.SettingsStatus> = Schema.Struct({
  file: Schema.String,
  deepseekApiKey: KeyStatus,
  agoraAppId: AgoraAppID,
  agoraAppCertificate: KeyStatus,
  voice: VoiceSettings,
  voiceDefaults: VoiceSettings,
  asrKey: KeyStatus,
  llmKey: KeyStatus,
  ttsKey: KeyStatus,
  dictation: Dictation,
  dictationKey: KeyStatus,
  memorySources: Schema.mutable(Schema.Array(MemorySource)),
});

export const MemorySourceUpdate: Schema.Codec<T.MemorySourceUpdate> = Schema.Struct({
  kind: MemorySourceKind,
  url: Schema.String,
  enabled: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  everything: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
});

export const SettingsUpdateVoice: Schema.Codec<T.SettingsUpdateVoice> = Schema.Struct({
  area: Schema.optionalKey(Area),
  language: Schema.optionalKey(Language),
  asr: Schema.optionalKey(VoiceASR),
  answer: Schema.optionalKey(VoiceAnswer),
  tts: Schema.optionalKey(VoiceTTS),
  persona: Schema.optionalKey(Schema.String),
  greeting: Schema.optionalKey(Schema.String),
  failureMessage: Schema.optionalKey(Schema.String),
  silenceMs: Schema.optionalKey(Schema.Number),
  interruptMs: Schema.optionalKey(Schema.Number),
  idleSeconds: Schema.optionalKey(Schema.Number),
});

export const SettingsUpdate: Schema.Codec<T.SettingsUpdate> = Schema.Struct({
  deepseekApiKey: Schema.optionalKey(Schema.String),
  agoraAppId: Schema.optionalKey(Schema.String),
  agoraAppCertificate: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(SettingsUpdateVoice),
  asrKey: Schema.optionalKey(Schema.String),
  llmKey: Schema.optionalKey(Schema.String),
  ttsKey: Schema.optionalKey(Schema.String),
  dictation: Schema.optionalKey(Dictation),
  dictationKey: Schema.optionalKey(Schema.String),
  memorySources: Schema.optionalKey(Schema.mutable(Schema.Array(MemorySourceUpdate))),
});

export const Health: Schema.Codec<T.Health> = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
});

export const FactCall: Schema.Codec<T.FactCall> = Schema.Struct({
  type: Schema.Literal("call"),
  at: Schema.Number,
  state: CallState,
  reason: Schema.optionalKey(Schema.String),
});

export const FactOrchestrator: Schema.Codec<T.FactOrchestrator> = Schema.Struct({
  type: Schema.Literal("orchestrator"),
  at: Schema.Number,
  state: OrchestratorState,
});

export const FactMessage: Schema.Codec<T.FactMessage> = Schema.Struct({
  type: Schema.Literal("message"),
  at: Schema.Number,
  message: ChatMessage,
  thread: Schema.optionalKey(Schema.String),
  answers: Schema.optionalKey(Schema.String),
});

export const FactConversation: Schema.Codec<T.FactConversation> = Schema.Struct({
  type: Schema.Literal("conversation"),
  at: Schema.Number,
  conversation: Conversation,
});

export const FactOwnerMentions: Schema.Codec<T.FactOwnerMentions> = Schema.Struct({
  type: Schema.Literal("ownerMentions"),
  at: Schema.Number,
  mentions: Schema.mutable(Schema.Array(OwnerMention)),
});

export const FactHired: Schema.Codec<T.FactHired> = Schema.Struct({
  type: Schema.Literal("hired"),
  at: Schema.Number,
  session: Session,
});

export const FactStation: Schema.Codec<T.FactStation> = Schema.Struct({
  type: Schema.Literal("station"),
  at: Schema.Number,
  id: Schema.String,
  station: Schema.Number,
});

export const FactRun: Schema.Codec<T.FactRun> = Schema.Struct({
  type: Schema.Literal("run"),
  at: Schema.Number,
  id: Schema.String,
  brief: Schema.optionalKey(Schema.String),
});

export const FactDoing: Schema.Codec<T.FactDoing> = Schema.Struct({
  type: Schema.Literal("doing"),
  at: Schema.Number,
  id: Schema.String,
  action: SessionAction,
  label: Schema.String,
});

export const FactQuiet: Schema.Codec<T.FactQuiet> = Schema.Struct({
  type: Schema.Literal("quiet"),
  at: Schema.Number,
  id: Schema.String,
  since: Schema.Number,
});

export const FactRetry: Schema.Codec<T.FactRetry> = Schema.Struct({
  type: Schema.Literal("retry"),
  at: Schema.Number,
  id: Schema.String,
  attempt: Schema.Number,
  of: Schema.optionalKey(Schema.Number),
});

export const FactSpent: Schema.Codec<T.FactSpent> = Schema.Struct({
  type: Schema.Literal("spent"),
  at: Schema.Number,
  id: Schema.String,
  spent: Spent,
});

export const FactReport: Schema.Codec<T.FactReport> = Schema.Struct({
  type: Schema.Literal("report"),
  at: Schema.Number,
  id: Schema.String,
  run: Schema.optionalKey(Schema.String),
  outcome: Outcome,
  summary: Schema.String,
  runs: Schema.Number,
  spent: Schema.optionalKey(Spent),
  questions: Schema.optionalKey(Schema.mutable(Schema.Array(Question))),
  checks: Schema.optionalKey(Schema.mutable(Schema.Array(CriterionCheck))),
  answer: Schema.optionalKey(IssueAnswer),
});

export const FactConflict: Schema.Codec<T.FactConflict> = Schema.Struct({
  type: Schema.Literal("conflict"),
  at: Schema.Number,
  id: Schema.String,
  conflict: Schema.optionalKey(Conflict),
});

export const FactLeft: Schema.Codec<T.FactLeft> = Schema.Struct({
  type: Schema.Literal("left"),
  at: Schema.Number,
  id: Schema.String,
  closed: Schema.optionalKey(SessionClose),
  merged: Schema.optionalKey(Schema.Number),
});

export const FactCommits: Schema.Codec<T.FactCommits> = Schema.Struct({
  type: Schema.Literal("commits"),
  at: Schema.Number,
  commits: CommitCount,
});

export const FactIssue: Schema.Codec<T.FactIssue> = Schema.Struct({
  type: Schema.Literal("issue"),
  at: Schema.Number,
  issue: Issue,
});

export const FactIssueGone: Schema.Codec<T.FactIssueGone> = Schema.Struct({
  type: Schema.Literal("issueGone"),
  at: Schema.Number,
  id: Schema.String,
});

export const FactProgress: Schema.Codec<T.FactProgress> = Schema.Struct({
  type: Schema.Literal("progress"),
  at: Schema.Number,
  progress: Progress,
  news: Schema.optionalKey(ProgressNews),
});

export const FactRecurrence: Schema.Codec<T.FactRecurrence> = Schema.Struct({
  type: Schema.Literal("recurrence"),
  at: Schema.Number,
  recurrence: Recurrence,
});

export const FactRecurrenceGone: Schema.Codec<T.FactRecurrenceGone> = Schema.Struct({
  type: Schema.Literal("recurrenceGone"),
  at: Schema.Number,
  id: Schema.String,
});

export const Fact: Schema.Codec<T.Fact> = Schema.Union([
  FactCall,
  FactOrchestrator,
  FactMessage,
  FactConversation,
  FactOwnerMentions,
  FactHired,
  FactStation,
  FactRun,
  FactDoing,
  FactQuiet,
  FactRetry,
  FactSpent,
  FactReport,
  FactConflict,
  FactLeft,
  FactCommits,
  FactIssue,
  FactIssueGone,
  FactProgress,
  FactRecurrence,
  FactRecurrenceGone,
]);

export const SideEventSnapshot: Schema.Codec<T.SideEventSnapshot> = Schema.Struct({
  type: Schema.Literal("snapshot"),
  at: Schema.Number,
  state: WorkspaceState,
});

export const SideEventSessionEvent: Schema.Codec<T.SideEventSessionEvent> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Number,
  id: Schema.String,
  activity: SessionEvent,
});

export const SideEventNotice: Schema.Codec<T.SideEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Number,
  level: NoticeLevel,
  text: Schema.String,
});

export const SideEventRuntime: Schema.Codec<T.SideEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Number,
  info: RuntimeInfo,
});

export const SideEvent: Schema.Codec<T.SideEvent> = Schema.Union([
  FactCall,
  FactOrchestrator,
  FactMessage,
  FactConversation,
  FactOwnerMentions,
  FactHired,
  FactStation,
  FactRun,
  FactDoing,
  FactQuiet,
  FactRetry,
  FactSpent,
  FactReport,
  FactConflict,
  FactLeft,
  FactCommits,
  FactIssue,
  FactIssueGone,
  FactProgress,
  FactRecurrence,
  FactRecurrenceGone,
  SideEventSnapshot,
  SideEventSessionEvent,
  SideEventNotice,
  SideEventRuntime,
]);

export const Roots: Schema.Codec<T.Roots> = Schema.Struct({
  fact: Fact,
  event: SideEvent,
  frame: StateFrame,
  ledger: LedgerEntry,
  taskEvent: GraphEvent,
});

export const RecurrenceUpdate: Schema.Codec<T.RecurrenceUpdate> = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const MoveIssueRequest: Schema.Codec<T.MoveIssueRequest> = Schema.Struct({
  before: Schema.optionalKey(Schema.String),
});

export const IssueStatusRequest: Schema.Codec<T.IssueStatusRequest> = Schema.Struct({
  status: IssueStatus,
  text: Schema.optionalKey(Schema.String),
  keepBranch: Schema.optionalKey(Schema.Boolean),
  agent: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(IssueUpdate),
});

export const GraphActRequest: Schema.Codec<T.GraphActRequest> = Schema.Struct({
  action: GraphAction,
});

export const TaskActRequest: Schema.Codec<T.TaskActRequest> = Schema.Struct({
  action: TaskAction,
});

export const ChatReadRequest: Schema.Codec<T.ChatReadRequest> = Schema.Struct({
  number: Schema.Number,
});

export const ChooseTitleRequest: Schema.Codec<T.ChooseTitleRequest> = Schema.Struct({
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Number),
});

export const RenewRequest: Schema.Codec<T.RenewRequest> = Schema.Struct({
  channel: Schema.String,
  uid: Schema.String,
});

export const DictateRequest: Schema.Codec<T.DictateRequest> = Schema.Struct({
  audio: Schema.String,
  format: Schema.String,
});

export const Dictated: Schema.Codec<T.Dictated> = Schema.Struct({
  text: Schema.String,
});

export const VoiceSaid: Schema.Codec<T.VoiceSaid> = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String,
});

export const VoiceHeard: Schema.Codec<T.VoiceHeard> = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String,
  agent: Schema.NullOr(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const StartRequest: Schema.Codec<T.StartRequest> = Schema.Struct({
  channel: Schema.String,
  uid: Schema.String,
  about: Schema.optionalKey(Schema.String),
});

export const VerifyRequest: Schema.Codec<T.VerifyRequest> = Schema.Struct({
  code: Schema.String,
});

export const ConnectorsChannelRequest: Schema.Codec<T.ConnectorsChannelRequest> = Schema.Struct({
  channel: Schema.String,
});

export const SetOpenRequest: Schema.Codec<T.SetOpenRequest> = Schema.Struct({
  open: Schema.Boolean,
});

export const AnswerPairingRequest: Schema.Codec<T.AnswerPairingRequest> = Schema.Struct({
  allow: Schema.Boolean,
});

export const LiveEventSession: Schema.Codec<T.LiveEventSession> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Number,
  id: Schema.String,
  activity: SessionEvent,
});

export const LiveEventNotice: Schema.Codec<T.LiveEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Number,
  level: NoticeLevel,
  text: Schema.String,
});

export const LiveEventRuntime: Schema.Codec<T.LiveEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Number,
  info: RuntimeInfo,
});

export const LiveEvent: Schema.Codec<T.LiveEvent> = Schema.Union([LiveEventSession, LiveEventNotice, LiveEventRuntime]);

export const Document: Schema.Codec<T.Document> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  seq: Schema.Number,
  created: Schema.Number,
  updated: Schema.Number,
});

export const DocMarks: Schema.Codec<T.DocMarks> = Schema.Struct({
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.Boolean),
  strike: Schema.optionalKey(Schema.Boolean),
  link: Schema.optionalKey(Schema.String),
});

export const DocSpan: Schema.Codec<T.DocSpan> = Schema.Struct({
  t: Schema.String,
  marks: DocMarks,
});

export const BlockAttrs: Schema.Codec<T.BlockAttrs> = Schema.Struct({
  level: Schema.optionalKey(Schema.Number),
  checked: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.String),
  src: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  alt: Schema.optionalKey(Schema.String),
  issueId: Schema.optionalKey(Schema.String),
  memoryId: Schema.optionalKey(Schema.String),
});

const blockInputFields = {
  id: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  orderKey: Schema.String,
  type: Schema.String,
  attrs: BlockAttrs,
  text: Schema.mutable(Schema.Array(DocSpan)),
};

export const BlockInput: Schema.Codec<T.BlockInput> = Schema.Struct(blockInputFields);

export const Block: Schema.Codec<T.Block> = Schema.Struct({
  ...blockInputFields,
  docId: Schema.String,
  rev: Schema.Number,
  deleted: Schema.optionalKey(Schema.Boolean),
  updatedBy: Schema.String,
  updated: Schema.Number,
});

export const DocSnapshot: Schema.Codec<T.DocSnapshot> = Schema.Struct({
  doc: Document,
  blocks: Schema.mutable(Schema.Array(Block)),
});

export const DocRequest: Schema.Codec<T.DocRequest> = Schema.Struct({
  title: Schema.String,
});

export const DocImport: Schema.Codec<T.DocImport> = Schema.Struct({
  title: Schema.String,
  markdown: Schema.String,
});

export const DocMarkdown: Schema.Codec<T.DocMarkdown> = Schema.Struct({
  markdown: Schema.String,
});

export const DocOpInsertBlock: Schema.Codec<T.DocOpInsertBlock> = Schema.Struct({
  op: Schema.Literal("insert_block"),
  block: BlockInput,
});

export const DocOpUpdateText: Schema.Codec<T.DocOpUpdateText> = Schema.Struct({
  op: Schema.Literal("update_text"),
  blockId: Schema.String,
  baseRev: Schema.Number,
  text: Schema.mutable(Schema.Array(DocSpan)),
});

export const DocOpSetAttrs: Schema.Codec<T.DocOpSetAttrs> = Schema.Struct({
  op: Schema.Literal("set_attrs"),
  blockId: Schema.String,
  attrs: BlockAttrs,
  unset: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const DocOpSetType: Schema.Codec<T.DocOpSetType> = Schema.Struct({
  op: Schema.Literal("set_type"),
  blockId: Schema.String,
  type: Schema.String,
  attrs: BlockAttrs,
});

export const DocOpMoveBlock: Schema.Codec<T.DocOpMoveBlock> = Schema.Struct({
  op: Schema.Literal("move_block"),
  blockId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  orderKey: Schema.String,
});

export const DocOpDeleteBlock: Schema.Codec<T.DocOpDeleteBlock> = Schema.Struct({
  op: Schema.Literal("delete_block"),
  blockId: Schema.String,
});

export const DocOpRestoreBlock: Schema.Codec<T.DocOpRestoreBlock> = Schema.Struct({
  op: Schema.Literal("restore_block"),
  blockId: Schema.String,
});

export const DocOpSplitBlock: Schema.Codec<T.DocOpSplitBlock> = Schema.Struct({
  op: Schema.Literal("split_block"),
  blockId: Schema.String,
  baseRev: Schema.Number,
  offset: Schema.Number,
  newBlock: BlockInput,
});

export const DocOpMergeBlocks: Schema.Codec<T.DocOpMergeBlocks> = Schema.Struct({
  op: Schema.Literal("merge_blocks"),
  targetId: Schema.String,
  sourceId: Schema.String,
});

export const DocOp: Schema.Codec<T.DocOp> = Schema.Union([
  DocOpInsertBlock,
  DocOpUpdateText,
  DocOpSetAttrs,
  DocOpSetType,
  DocOpMoveBlock,
  DocOpDeleteBlock,
  DocOpRestoreBlock,
  DocOpSplitBlock,
  DocOpMergeBlocks,
]);

export const DocSubmit: Schema.Codec<T.DocSubmit> = Schema.Struct({
  batchId: Schema.String,
  lastSeq: Schema.Number,
  ops: Schema.mutable(Schema.Array(DocOp)),
});

export const DocOpStatus: Schema.Codec<T.DocOpStatus> = Schema.Literals(T.DocOpStatusValues);

export const DocOpResult: Schema.Codec<T.DocOpResult> = Schema.Struct({
  status: DocOpStatus,
  blockId: Schema.String,
  rev: Schema.optionalKey(Schema.Number),
  text: Schema.optionalKey(Schema.mutable(Schema.Array(DocSpan))),
  yours: Schema.optionalKey(Schema.mutable(Schema.Array(DocSpan))),
  reason: Schema.optionalKey(Schema.String),
});

export const DocAck: Schema.Codec<T.DocAck> = Schema.Struct({
  batchId: Schema.String,
  seq: Schema.Number,
  results: Schema.mutable(Schema.Array(DocOpResult)),
  blocks: Schema.mutable(Schema.Array(Block)),
});
