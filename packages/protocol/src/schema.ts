// A Schema for each shape in shapes.ts, typed by it: a field added there and not here (or here and not there) does not
// compile.

import { Brand, Schema } from "effect";
import * as T from "./shapes";

/** A shape as it is on the wire: an id is a plain string there, branded only once read. */
export type Wire<A> = A extends Brand.Brand<string> ? Brand.Brand.Unbranded<A> : A extends object ? { [K in keyof A]: Wire<A[K]> } : A;
type Codec<A> = Schema.Codec<A, Wire<A>>;

export const IssueId: Codec<T.IssueId> = Schema.String.pipe(Schema.brand("IssueId"));
export const SessionId: Codec<T.SessionId> = Schema.String.pipe(Schema.brand("SessionId"));
/** An id minted, or taken from where the kind is known (a route, a row, a tool's argument for it). */
export const issueId = Brand.nominal<T.IssueId>();
export const sessionId = Brand.nominal<T.SessionId>();

export const ServerReady: Codec<T.ServerReady> = Schema.Struct({
  url: Schema.String,
  pid: Schema.Number,
});

export const GitHubStatus: Codec<T.GitHubStatus> = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  loggedIn: Schema.Boolean,
  account: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  checkedAt: Schema.Number,
});

export const Check: Codec<T.Check> = Schema.Struct({
  problem: Schema.optionalKey(Schema.String),
});

export const RuntimeQuota: Codec<T.RuntimeQuota> = Schema.Struct({
  left: Schema.optionalKey(Schema.Number),
  text: Schema.String,
});

export const AgentProblemLevel: Codec<T.AgentProblemLevel> = Schema.Literals(T.AgentIssueLevelValues);

export const AgentProblem: Codec<T.AgentProblem> = Schema.Struct({
  field: Schema.String,
  level: AgentProblemLevel,
  text: Schema.String,
});

export const PersonaMode: Codec<T.PersonaMode> = Schema.Literals(T.PersonaModeValues);

export const MCPServerStdio: Codec<T.MCPServerStdio> = Schema.Struct({
  type: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.String)),
  env: Schema.Record(Schema.String, Schema.String),
});

export const MCPServerHTTP: Codec<T.MCPServerHTTP> = Schema.Struct({
  type: Schema.Literal("http"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
});

export const MCPServer: Codec<T.MCPServer> = Schema.Union([MCPServerStdio, MCPServerHTTP]);

export const Species: Codec<T.Species> = Schema.Literals(T.SpeciesValues);

export const Outfit: Codec<T.Outfit> = Schema.Literals(T.OutfitValues);

export const Build: Codec<T.Build> = Schema.Literals(T.BuildValues);

export const Head: Codec<T.Head> = Schema.Literals(T.HeadValues);

export const Look: Codec<T.Look> = Schema.Struct({
  species: Schema.optionalKey(Species),
  outfit: Schema.optionalKey(Outfit),
  orchestrator: Schema.optionalKey(Schema.Literals(T.OrchestratorLookValues)),
  build: Build,
  head: Head,
  body: Schema.String,
  trim: Schema.String,
  hat: Schema.String,
  eye: Schema.String,
});

export const AgentFrom: Codec<T.AgentFrom> = Schema.Struct({ template: Schema.String, version: Schema.Number });

export const Agent: Codec<T.Agent> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.Literals(T.AgentRoleValues),
  duty: Schema.String,
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
  from: Schema.optionalKey(AgentFrom),
});

export const AgentTemplate: Codec<T.AgentTemplate> = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  role: Schema.Literals(T.AgentRoleValues),
  name: Schema.String,
  duty: Schema.String,
  tags: Schema.mutable(Schema.Array(Schema.String)),
  runtime: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  personaMode: PersonaMode,
  worktree: Schema.Boolean,
  look: Look,
  persona: Schema.String,
  source: Schema.Literals(T.AgentTemplateSourceValues),
  installed: Schema.mutable(Schema.Array(Schema.String)),
});

export const AgentCheckRequest: Codec<T.AgentCheckRequest> = Schema.Struct({
  agents: Schema.mutable(Schema.Array(Agent)),
});

export const AgentCheck: Codec<T.AgentCheck> = Schema.Struct({
  id: Schema.String,
  problems: Schema.mutable(Schema.Array(AgentProblem)),
});

export const RecallPreview: Codec<T.RecallPreview> = Schema.Struct({
  lines: Schema.mutable(Schema.Array(Schema.String)),
  chars: Schema.Number,
  limit: Schema.Number,
});

export const AchievementCategory: Codec<T.AchievementCategory> = Schema.Literals(T.AchievementCategoryValues);

export const AchievementDef: Codec<T.AchievementDef> = Schema.Struct({
  id: Schema.String,
  category: AchievementCategory,
  title: Schema.String,
  tierTitles: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  detail: Schema.String,
  tiers: Schema.mutable(Schema.Array(Schema.Number)),
  coins: Schema.mutable(Schema.Array(Schema.Number)),
  unit: Schema.optionalKey(Schema.String),
});

export const AchievementTier: Codec<T.AchievementTier> = Schema.Struct({
  need: Schema.Number,
  title: Schema.String,
  coins: Schema.Number,
  reached: Schema.String,
});

export const Achievement: Codec<T.Achievement> = Schema.Struct({
  id: Schema.String,
  category: AchievementCategory,
  title: Schema.String,
  detail: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  wearable: Schema.Boolean,
  tiers: Schema.mutable(Schema.Array(AchievementTier)),
});

export const AchievementStanding: Codec<T.AchievementStanding> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Number,
  count: Schema.Number,
  next: Schema.optionalKey(Schema.Number),
});

export const RuntimePreset: Codec<T.RuntimePreset> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  blurb: Schema.String,
  look: Look,
});

export const RuntimeCapability: Codec<T.RuntimeCapability> = Schema.Literals(T.RuntimeCapabilityValues);

export const RuntimeFacts: Codec<T.RuntimeFacts> = Schema.Struct({
  steer: Schema.Boolean,
  refused: Schema.Record(Schema.String, Schema.String),
  capabilities: Schema.mutable(Schema.Array(RuntimeCapability)),
  inProcess: Schema.Boolean,
});

export const CallState: Codec<T.CallState> = Schema.Literals(T.CallStateValues);

export const OrchestratorState: Codec<T.OrchestratorState> = Schema.Literals(T.OrchestratorStateValues);

export const OrchestratorNow: Codec<T.OrchestratorNow> = Schema.Struct({
  state: OrchestratorState,
  channel: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.Number),
});

export const ActorKind: Codec<T.ActorKind> = Schema.Literals(T.ActorKindValues);

export const MessageKind: Codec<T.MessageKind> = Schema.Literals(T.MessageKindValues);

export const Outcome: Codec<T.Outcome> = Schema.Literals(T.OutcomeValues);

export const Spent: Codec<T.Spent> = Schema.Struct({
  tokens: Schema.Finite,
  cny: Schema.optionalKey(Schema.Finite),
});

export const Notify: Codec<T.Notify> = Schema.Literals(T.NotifyValues);

export const Embed: Codec<T.Embed> = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  site: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
});

export const Reaction: Codec<T.Reaction> = Schema.Struct({ emoji: Schema.String, by: Schema.mutable(Schema.Array(Schema.String)) });

export const Attachment: Codec<T.Attachment> = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String, size: Schema.Number });

export const ChatMessage: Codec<T.ChatMessage> = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  channel: Schema.String,
  from: Schema.String,
  fromKind: ActorKind,
  name: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  kind: MessageKind,
  text: Schema.String,
  mentions: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  session: Schema.optionalKey(SessionId),
  run: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Outcome),
  spent: Schema.optionalKey(Spent),
  spoken: Schema.optionalKey(Schema.Boolean),
  sendKey: Schema.optionalKey(Schema.String),
  at: Schema.Number,
  revision: Schema.Number,
  replyTo: Schema.optionalKey(Schema.Number),
  edited: Schema.optionalKey(Schema.Number),
  deleted: Schema.optionalKey(Schema.Number),
  pinned: Schema.optionalKey(Schema.Number),
  reactions: Schema.optionalKey(Schema.mutable(Schema.Array(Reaction))),
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(Attachment))),
  embeds: Schema.optionalKey(Schema.mutable(Schema.Array(Embed))),
});

export const ChannelType: Codec<T.ChannelType> = Schema.Literals(T.ChannelTypeValues);

export const SubjectKind: Codec<T.SubjectKind> = Schema.Literals(T.SubjectKindValues);

export const Channel: Codec<T.Channel> = Schema.Struct({
  id: Schema.String,
  type: ChannelType,
  default: Schema.optionalKey(Schema.Boolean),
  peer: Schema.optionalKey(Schema.String),
  orchestrator: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  position: Schema.optionalKey(Schema.Number),
  archived: Schema.optionalKey(Schema.Number),
  notify: Schema.optionalKey(Notify),
  root: Schema.optionalKey(Schema.String),
  rootNumber: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  subjectKind: Schema.optionalKey(SubjectKind),
  subjectId: Schema.optionalKey(Schema.String),
  lastNumber: Schema.optionalKey(Schema.Number),
  replies: Schema.Number,
  read: Schema.optionalKey(Schema.Number),
  unread: Schema.optionalKey(Schema.Number),
  title: Schema.optionalKey(Schema.String),
  last: Schema.optionalKey(Schema.Struct({ from: Schema.String, name: Schema.String, text: Schema.String, at: Schema.Number })),
  at: Schema.Number,
});

export const Conflict: Codec<T.Conflict> = Schema.Struct({
  base: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
});

export const SessionAction: Codec<T.SessionAction> = Schema.Literals(T.SessionActionValues);

export const Doing: Codec<T.Doing> = Schema.Struct({
  action: SessionAction,
  label: Schema.String,
  actionText: Schema.optionalKey(Schema.String),
});

export const PhaseArriving: Codec<T.PhaseArriving> = Schema.Struct({
  _tag: Schema.Literal("arriving"),
});

export const Retry: Codec<T.Retry> = Schema.Struct({
  attempt: Schema.Number,
  of: Schema.optionalKey(Schema.Number),
});

export const PhaseWorking: Codec<T.PhaseWorking> = Schema.Struct({
  _tag: Schema.Literal("working"),
  since: Schema.Number,
  doing: Doing,
  quietSince: Schema.optionalKey(Schema.Number),
  retry: Schema.optionalKey(Retry),
});

export const PhaseDone: Codec<T.PhaseDone> = Schema.Struct({
  _tag: Schema.Literal("done"),
});

export const PhaseFailed: Codec<T.PhaseFailed> = Schema.Struct({
  _tag: Schema.Literal("failed"),
});

export const PhaseResting: Codec<T.PhaseResting> = Schema.Struct({
  _tag: Schema.Literal("resting"),
});

export const SessionClose: Codec<T.SessionClose> = Schema.Literals(T.SessionCloseValues);
export const Delivery: Codec<T.Delivery> = Schema.Literals(T.DeliveryValues);
export const IssueCanceled: Codec<T.IssueCanceled> = Schema.Literals(T.IssueCanceledValues);

export const PhaseClosed: Codec<T.PhaseClosed> = Schema.Struct({
  _tag: Schema.Literal("closed"),
  at: Schema.Number,
  closed: SessionClose,
});

export const Phase: Codec<T.Phase> = Schema.Union([PhaseArriving, PhaseWorking, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

export const IssueAnswer: Codec<T.IssueAnswer> = Schema.Struct({
  conclusion: Schema.String,
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  unsure: Schema.mutable(Schema.Array(Schema.String)),
  next: Schema.mutable(Schema.Array(Schema.String)),
});

export const LastRun: Codec<T.LastRun> = Schema.Struct({
  outcome: Outcome,
  summary: Schema.String,
  at: Schema.Number,
  spent: Schema.optionalKey(Spent),
  answer: Schema.optionalKey(IssueAnswer),
});

export const SessionGraph: Codec<T.SessionGraph> = Schema.Struct({
  id: Schema.String,
  task: Schema.optionalKey(Schema.String),
});

export const ActionStep: Codec<T.ActionStep> = Schema.Struct({
  at: Schema.Number,
  action: SessionAction,
  label: Schema.String,
  actionText: Schema.optionalKey(Schema.String),
});

export const SessionPlay: Codec<T.SessionPlay> = Schema.Struct({
  station: Schema.Number,
  history: Schema.mutable(Schema.Array(ActionStep)),
  toolsThisRun: Schema.Number,
  counts: Schema.Record(Schema.String, Schema.Number),
  files: Schema.mutable(Schema.Array(Schema.String)),
  commands: Schema.mutable(Schema.Array(Schema.String)),
  runStartedAt: Schema.optionalKey(Schema.Number),
});

export const Session: Codec<T.Session> = Schema.Struct({
  id: SessionId,
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
  issue: Schema.optionalKey(IssueId),
  refining: Schema.optionalKey(Schema.Boolean),
  phaseText: Schema.optionalKey(Schema.String),
});

export const Repo: Codec<T.Repo> = Schema.Struct({
  path: Schema.String,
  commits: Schema.Number,
});

export const CommitCount: Codec<T.CommitCount> = Schema.Struct({
  total: Schema.Number,
  repos: Schema.mutable(Schema.Array(Repo)),
});

export const GraphState: Codec<T.GraphState> = Schema.Literals(T.GraphStateValues);

export const TaskState: Codec<T.TaskState> = Schema.Literals(T.TaskStateValues);

export const TaskAction: Codec<T.TaskAction> = Schema.Literals(T.TaskActionValues);

export const Task: Codec<T.Task> = Schema.Struct({
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
  session: Schema.optionalKey(SessionId),
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

export const GraphAction: Codec<T.GraphAction> = Schema.Literals(T.GraphActionValues);

export const TaskGraph: Codec<T.TaskGraph> = Schema.Struct({
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

export const Unlock: Codec<T.Unlock> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Number,
  at: Schema.Number,
});

export const AgentTally: Codec<T.AgentTally> = Schema.Struct({
  hired: Schema.Number,
  harvested: Schema.Number,
  failed: Schema.Number,
});

export const ProgressTitle: Codec<T.ProgressTitle> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Number,
});

export const Progress: Codec<T.Progress> = Schema.Struct({
  coins: Schema.Number,
  streak: Schema.Number,
  bestStreak: Schema.Number,
  counts: Schema.Record(Schema.String, Schema.Number),
  unlocked: Schema.mutable(Schema.Array(Unlock)),
  title: Schema.optionalKey(ProgressTitle),
  agents: Schema.optionalKey(Schema.Record(Schema.String, AgentTally)),
  multiplier: Schema.optionalKey(Schema.Number),
});

export const ProgressNews: Codec<T.ProgressNews> = Schema.Struct({
  coins: Schema.optionalKey(Schema.Number),
  session: Schema.optionalKey(SessionId),
  unlocked: Schema.optionalKey(Schema.mutable(Schema.Array(Unlock))),
});

export const CronWhenOnce: Codec<T.CronWhenOnce> = Schema.Struct({
  kind: Schema.Literal("once"),
  at: Schema.Number,
});

export const CronWhenEvery: Codec<T.CronWhenEvery> = Schema.Struct({
  kind: Schema.Literal("every"),
  minutes: Schema.Number,
});

export const CronWhenDaily: Codec<T.CronWhenDaily> = Schema.Struct({
  kind: Schema.Literal("daily"),
  time: Schema.String,
});

export const CronWhenWeekly: Codec<T.CronWhenWeekly> = Schema.Struct({
  kind: Schema.Literal("weekly"),
  days: Schema.mutable(Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })))),
  time: Schema.String,
});

export const CronWhenExpr: Codec<T.CronWhenExpr> = Schema.Struct({
  kind: Schema.Literal("cron"),
  expr: Schema.String,
});

export const CronWhen: Codec<T.CronWhen> = Schema.Union([CronWhenOnce, CronWhenEvery, CronWhenDaily, CronWhenWeekly, CronWhenExpr]);

export const Cron: Codec<T.Cron> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  text: Schema.String,
  channel: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  when: CronWhen,
  tz: Schema.String,
  enabled: Schema.Boolean,
  created: Schema.Number,
  lastRun: Schema.optionalKey(Schema.Number),
  by: ActorKind,
  pending: Schema.optionalKey(Schema.Boolean),
  whenText: Schema.optionalKey(Schema.String),
  nextText: Schema.optionalKey(Schema.String),
});

export const OwnerMention: Codec<T.OwnerMention> = Schema.Struct({
  message: ChatMessage,
  channel: Schema.String,
  address: Schema.String,
});

export const Chat: Codec<T.Chat> = Schema.Struct({
  channels: Schema.mutable(Schema.Array(Channel)),
  ownerMentions: Schema.optionalKey(Schema.mutable(Schema.Array(OwnerMention))),
});

export const ChannelEvent: Codec<T.ChannelEvent> = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Message"), message: ChatMessage }),
  Schema.Struct({ _tag: Schema.Literal("Reset") }),
]);

export const Priority: Codec<T.Priority> = Schema.Literals(T.PriorityValues);

export const IssueGraph: Codec<T.IssueGraph> = Schema.Struct({
  state: GraphState,
  branch: Schema.optionalKey(Schema.String),
  parallel: Schema.Number,
  note: Schema.optionalKey(Schema.String),
});

export const IssueTask: Codec<T.IssueTask> = Schema.Struct({
  key: Schema.String,
  state: TaskState,
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  acceptance: Schema.optionalKey(Schema.Boolean),
  frozen: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  session: Schema.optionalKey(SessionId),
  conclusion: Schema.optionalKey(Schema.String),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  spent: Schema.optionalKey(Spent),
  tries: Schema.Number,
  failures: Schema.optionalKey(Schema.Number),
});

export const IssueStatus: Codec<T.IssueStatus> = Schema.Literals(T.IssueStatusValues);

export const PullRequestState: Codec<T.PullRequestState> = Schema.Literals(T.PullRequestStateValues);

export const PullRequest: Codec<T.PullRequest> = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  state: PullRequestState,
});

export const Finding: Codec<T.Finding> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  at: Schema.Number,
  resolved: Schema.optionalKey(Schema.Boolean),
});

export const IssueRefining: Codec<T.IssueRefining> = Schema.Struct({
  session: SessionId,
  name: Schema.String,
});

export const Question: Codec<T.Question> = Schema.Struct({
  question: Schema.String,
  options: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const CheckResult: Codec<T.CheckResult> = Schema.Literals(T.CheckResultValues);

export const CriterionCheck: Codec<T.CriterionCheck> = Schema.Struct({
  criterion: Schema.Number,
  result: CheckResult,
  proof: Schema.optionalKey(Schema.String),
});

export const Attention: Codec<T.Attention> = Schema.Literals(T.AttentionValues);
export const StuckReason: Codec<T.StuckReason> = Schema.Literals(T.StuckReasonValues);
export const IssueAct: Codec<T.IssueAct> = Schema.Literals(T.IssueActValues);

export const ActWords: Codec<T.ActWords> = Schema.Literals(T.ActWordsValues);

export const IssueAction: Codec<T.IssueAction> = Schema.Union([
  Schema.Struct({ act: IssueAct, does: Schema.Literal("move"), status: IssueStatus, words: ActWords }),
  Schema.Struct({ act: IssueAct, does: Schema.Literal("say") }),
  Schema.Struct({ act: IssueAct, does: Schema.Literal("stop") }),
]);

export const IssueAttention: Codec<T.IssueAttention> = Schema.Struct({
  state: Attention,
  since: Schema.optionalKey(Schema.Number),
  stuck: Schema.optionalKey(StuckReason),
  lead: Schema.optionalKey(IssueAct),
  acts: Schema.mutable(Schema.Array(IssueAction)),
});

export const MilestoneKind: Codec<T.MilestoneKind> = Schema.Literals(T.MilestoneKindValues);

export const Milestone: Codec<T.Milestone> = Schema.Struct({
  at: Schema.Number,
  kind: MilestoneKind,
  who: Schema.optionalKey(Schema.String),
  text: Schema.String,
});

export const IssueTimeline: Codec<T.IssueTimeline> = Schema.Struct({
  milestones: Schema.mutable(Schema.Array(Milestone)),
  spent: Schema.optionalKey(Spent),
});

export const Preview: Codec<T.Preview> = Schema.Struct({
  does: Schema.mutable(Schema.Array(Schema.String)),
});

export const IssueRun: Codec<T.IssueRun> = Schema.Struct({
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  outcome: Schema.optionalKey(Outcome),
});

export const Deliverable: Codec<T.Deliverable> = Schema.Literals(T.DeliverableValues);

export const Issue: Codec<T.Issue> = Schema.Struct({
  id: IssueId,
  number: Schema.Number,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Priority,
  rank: Schema.optionalKey(Schema.Number),
  createdAt: Schema.Number,
  queuedAt: Schema.optionalKey(Schema.Number),
  sessions: Schema.mutable(Schema.Array(SessionId)),
  closedAt: Schema.optionalKey(Schema.Number),
  delivered: Schema.optionalKey(Delivery),
  canceled: Schema.optionalKey(IssueCanceled),
  parent: Schema.optionalKey(IssueId),
  blockedBy: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  graph: Schema.optionalKey(IssueGraph),
  task: Schema.optionalKey(IssueTask),
  cron: Schema.optionalKey(Schema.String),
  status: IssueStatus,
  moves: Schema.mutable(Schema.Array(IssueStatus)),
  pullRequest: Schema.optionalKey(PullRequest),
  deliver: Deliverable,
  talk: Schema.optionalKey(Schema.String),
  reviewedAt: Schema.optionalKey(Schema.Number),
  findings: Schema.mutable(Schema.Array(Finding)),
  questions: Schema.mutable(Schema.Array(Question)),
  criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  checks: Schema.optionalKey(Schema.mutable(Schema.Array(CriterionCheck))),
  refining: Schema.optionalKey(IssueRefining),
  lastRun: Schema.optionalKey(IssueRun),
  answer: Schema.optionalKey(IssueAnswer),
  attention: IssueAttention,
});

export const ConnectorID: Codec<T.ConnectorID> = Schema.Literals(T.ConnectorIDValues);

export const ConnectorState: Codec<T.ConnectorState> = Schema.Literals(T.ConnectorStateValues);

export const ConnectorStatus: Codec<T.ConnectorStatus> = Schema.Struct({
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

export const WorkspaceState: Codec<T.WorkspaceState> = Schema.Struct({
  call: CallState,
  callReason: Schema.optionalKey(Schema.String),
  orchestrators: Schema.optionalKey(Schema.Record(Schema.String, OrchestratorNow)),
  sessions: Schema.mutable(Schema.Array(Session)),
  chat: Schema.optionalKey(Chat),
  commits: Schema.optionalKey(CommitCount),
  progress: Schema.optionalKey(Progress),
  crons: Schema.optionalKey(Schema.mutable(Schema.Array(Cron))),
  issues: Schema.optionalKey(Schema.mutable(Schema.Array(Issue))),
  connectors: Schema.optionalKey(Schema.mutable(Schema.Array(ConnectorStatus))),
});

export const SessionEventType: Codec<T.SessionEventType> = Schema.Literals(T.SessionEventTypeValues);

export const ToolAction: Codec<T.ToolAction> = Schema.Literals(T.ToolActionValues);

export const EventTokens: Codec<T.EventTokens> = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  output: Schema.Number,
});

export const SessionEvent: Codec<T.SessionEvent> = Schema.Struct({
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

export const NoticeLevel: Codec<T.NoticeLevel> = Schema.Literals(T.NoticeLevelValues);

export const Via: Codec<T.Via> = Schema.Literals(T.ViaValues);

export const InstallationAvailable: Codec<T.InstallationAvailable> = Schema.Struct({
  status: Schema.Literal("available"),
  via: Via,
  command: Schema.String,
  version: Schema.NullOr(Schema.String),
});

export const InstallationNotFound: Codec<T.InstallationNotFound> = Schema.Struct({
  status: Schema.Literal("not_found"),
});

export const InstallationChecking: Codec<T.InstallationChecking> = Schema.Struct({
  status: Schema.Literal("checking"),
});

export const InstallationUnsupported: Codec<T.InstallationUnsupported> = Schema.Struct({
  status: Schema.Literal("unsupported"),
  reason: Schema.String,
});

export const Installation: Codec<T.Installation> = Schema.Union([InstallationAvailable, InstallationNotFound, InstallationChecking, InstallationUnsupported]);

export const ModelEntry: Codec<T.ModelEntry> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  effortLevels: Schema.mutable(Schema.Array(Schema.String)),
  isDefault: Schema.Boolean,
});

export const UsageWindow: Codec<T.UsageWindow> = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.Number),
});

export const Balance: Codec<T.Balance> = Schema.Struct({
  currency: Schema.String,
  amount: Schema.Number,
});

export const AccountUsageOk: Codec<T.AccountUsageOk> = Schema.Struct({
  status: Schema.Literal("ok"),
  subscription: Schema.NullOr(Schema.String),
  windows: Schema.mutable(Schema.Array(UsageWindow)),
});

export const AccountUsageBalance: Codec<T.AccountUsageBalance> = Schema.Struct({
  status: Schema.Literal("balance"),
  provider: Schema.String,
  available: Schema.Boolean,
  balances: Schema.mutable(Schema.Array(Balance)),
});

export const AccountUsageLoginRequired: Codec<T.AccountUsageLoginRequired> = Schema.Struct({
  status: Schema.Literal("login_required"),
});

export const AccountUsageUnavailable: Codec<T.AccountUsageUnavailable> = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
});

export const AccountUsage: Codec<T.AccountUsage> = Schema.Union([AccountUsageOk, AccountUsageBalance, AccountUsageLoginRequired, AccountUsageUnavailable]);

export const InventoryEntry: Codec<T.InventoryEntry> = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const RuntimeSettings: Codec<T.RuntimeSettings> = Schema.Struct({
  enabled: Schema.Boolean,
  binPath: Schema.String,
  defaultModel: Schema.String,
  defaultEffort: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  dailyBudget: Schema.optionalKey(Schema.Number),
  maxWorking: Schema.optionalKey(Schema.Number),
});

export const RuntimeInfo: Codec<T.RuntimeInfo> = Schema.Struct({
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

export const FarmLevel: Codec<T.FarmLevel> = Schema.Struct({
  level: Schema.Number,
  xp: Schema.Number,
  need: Schema.Number,
});

export const InboxKind: Codec<T.InboxKind> = Schema.Literals(T.InboxKindValues);

export const InboxFromSession: Codec<T.InboxFromSession> = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
});

export const InboxFromOrchestrator: Codec<T.InboxFromOrchestrator> = Schema.Struct({
  kind: Schema.Literal("orchestrator"),
});

export const InboxFrom: Codec<T.InboxFrom> = Schema.Union([InboxFromSession, InboxFromOrchestrator]);

export const InboxTargetSession: Codec<T.InboxTargetSession> = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
});

export const InboxTargetGraph: Codec<T.InboxTargetGraph> = Schema.Struct({
  kind: Schema.Literal("graph"),
  graph: Schema.String,
});

export const InboxTargetChat: Codec<T.InboxTargetChat> = Schema.Struct({
  kind: Schema.Literal("chat"),
  channel: Schema.String,
});

export const InboxTarget: Codec<T.InboxTarget> = Schema.Union([InboxTargetSession, InboxTargetGraph, InboxTargetChat]);

export const InboxWords: Codec<T.InboxWords> = Schema.Struct({
  label: Schema.String,
  title: Schema.String,
  body: Schema.String,
  tray: Schema.optionalKey(Schema.String),
});

export const InboxItem: Codec<T.InboxItem> = Schema.Struct({
  id: Schema.String,
  kind: InboxKind,
  from: InboxFrom,
  who: Schema.String,
  text: Schema.String,
  at: Schema.Number,
  target: InboxTarget,
  words: InboxWords,
});

export const Crop: Codec<T.Crop> = Schema.Literals(T.CropValues);

export const BadgeTone: Codec<T.BadgeTone> = Schema.Literals(T.BadgeToneValues);

export const Badge: Codec<T.Badge> = Schema.Struct({
  text: Schema.String,
  tone: BadgeTone,
});

export const PlotView: Codec<T.PlotView> = Schema.Struct({
  crop: Crop,
  badge: Schema.optionalKey(Badge),
});

export const FarmView: Codec<T.FarmView> = Schema.Struct({
  level: FarmLevel,
  plots: Schema.Record(Schema.String, PlotView),
  achievements: Schema.mutable(Schema.Array(AchievementStanding)),
});

export const GameEffectReward: Codec<T.GameEffectReward> = Schema.Struct({
  kind: Schema.Literal("reward"),
  sessionId: Schema.optionalKey(SessionId),
  coins: Schema.Number,
  streak: Schema.Number,
});

export const GameEffectPenalty: Codec<T.GameEffectPenalty> = Schema.Struct({
  kind: Schema.Literal("penalty"),
  sessionId: SessionId,
});

export const GameEffectLevelUp: Codec<T.GameEffectLevelUp> = Schema.Struct({
  kind: Schema.Literal("levelUp"),
  level: Schema.Number,
});

export const GameEffectAchievement: Codec<T.GameEffectAchievement> = Schema.Struct({
  kind: Schema.Literal("achievement"),
  achievement: Schema.String,
  tier: Schema.Number,
  title: Schema.String,
  reached: Schema.String,
  detail: Schema.String,
  coins: Schema.Number,
  oneOff: Schema.optionalKey(Schema.Boolean),
});

export const GameEffect: Codec<T.GameEffect> = Schema.Union([GameEffectReward, GameEffectPenalty, GameEffectLevelUp, GameEffectAchievement]);

export const StateFrame: Codec<T.StateFrame> = Schema.Struct({
  state: WorkspaceState,
  inbox: Schema.mutable(Schema.Array(InboxItem)),
  graphs: Schema.mutable(Schema.Array(TaskGraph)),
  view: FarmView,
  effects: Schema.mutable(Schema.Array(GameEffect)),
});

export const LedgerEntryHarvested: Codec<T.LedgerEntryHarvested> = Schema.Struct({
  kind: Schema.Literal("harvested"),
  at: Schema.Finite,
  session: SessionId,
  agent: Schema.optionalKey(Schema.String),
  project: Schema.String,
  runtime: Schema.String,
  commits: Schema.Finite,
  cny: Schema.optionalKey(Schema.Finite),
  runs: Schema.Finite,
});

export const LedgerEntryFailed: Codec<T.LedgerEntryFailed> = Schema.Struct({
  kind: Schema.Literal("failed"),
  at: Schema.Finite,
  session: SessionId,
  agent: Schema.optionalKey(Schema.String),
});

export const LedgerEntryConflicted: Codec<T.LedgerEntryConflicted> = Schema.Struct({
  kind: Schema.Literal("conflicted"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryTold: Codec<T.LedgerEntryTold> = Schema.Struct({
  kind: Schema.Literal("told"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryReviewed: Codec<T.LedgerEntryReviewed> = Schema.Struct({
  kind: Schema.Literal("reviewed"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryGraph: Codec<T.LedgerEntryGraph> = Schema.Struct({
  kind: Schema.Literal("graph"),
  at: Schema.Finite,
  graph: Schema.String,
  merged: Schema.Finite,
  parallel: Schema.Boolean,
});

export const LedgerEntryHandoff: Codec<T.LedgerEntryHandoff> = Schema.Struct({
  kind: Schema.Literal("handoff"),
  at: Schema.Finite,
  session: SessionId,
  to: Schema.String,
});

export const LedgerEntryCalled: Codec<T.LedgerEntryCalled> = Schema.Struct({
  kind: Schema.Literal("called"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryHired: Codec<T.LedgerEntryHired> = Schema.Struct({
  kind: Schema.Literal("hired"),
  at: Schema.Finite,
  session: SessionId,
  agent: Schema.optionalKey(Schema.String),
});

export const LedgerEntryMomentKind: Codec<T.LedgerEntryMomentKind> = Schema.Literals(T.LedgerEntryMomentKindValues);

export const LedgerEntryMoment: Codec<T.LedgerEntryMoment> = Schema.Struct({
  kind: LedgerEntryMomentKind,
  at: Schema.Finite,
});

export const LedgerEntryLevel: Codec<T.LedgerEntryLevel> = Schema.Struct({
  kind: Schema.Literal("level"),
  at: Schema.Finite,
  level: Schema.Finite,
});

export const LedgerEntryTitled: Codec<T.LedgerEntryTitled> = Schema.Struct({
  kind: Schema.Literal("titled"),
  at: Schema.Finite,
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Finite),
});

export const LedgerEntry: Codec<T.LedgerEntry> = Schema.Union([
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

export const GraphEventKind: Codec<T.GraphEventKind> = Schema.Literals(T.GraphEventKindValues);

export const TaskFieldChange: Codec<T.TaskFieldChange> = Schema.Struct({
  field: Schema.String,
  from: Schema.String,
  to: Schema.String,
});

export const GraphEvent: Codec<T.GraphEvent> = Schema.Struct({
  id: Schema.String,
  graph: Schema.String,
  task: Schema.optionalKey(Schema.String),
  kind: GraphEventKind,
  actor: ActorKind,
  session: Schema.optionalKey(SessionId),
  detail: Schema.optionalKey(Schema.String),
  changes: Schema.optionalKey(Schema.mutable(Schema.Array(TaskFieldChange))),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  at: Schema.Number,
  text: Schema.optionalKey(Schema.String),
  actorText: Schema.optionalKey(Schema.String),
});

export const LanDevice: Codec<T.LanDevice> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  pairedAt: Schema.Number,
  lastSeen: Schema.optionalKey(Schema.Number),
});

export const LanPaired: Codec<T.LanPaired> = Schema.Struct({
  device: Schema.String,
  key: Schema.String,
  hostName: Schema.String,
});

export const LanPairRequest: Codec<T.LanPairRequest> = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
});

export const LanPairing: Codec<T.LanPairing> = Schema.Struct({
  code: Schema.String,
  link: Schema.String,
  expiresAt: Schema.Number,
  asking: Schema.optionalKey(Schema.String),
});

export const LanStatus: Codec<T.LanStatus> = Schema.Struct({
  open: Schema.Boolean,
  hostName: Schema.String,
  url: Schema.optionalKey(Schema.String),
  problem: Schema.optionalKey(Schema.String),
  pairing: Schema.optionalKey(LanPairing),
  devices: Schema.mutable(Schema.Array(LanDevice)),
});

export const ConnectorLogin: Codec<T.ConnectorLogin> = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  appId: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
});

export const VoiceAgent: Codec<T.VoiceAgent> = Schema.Struct({
  agentId: Schema.String,
});

export const AgoraGrant: Codec<T.AgoraGrant> = Schema.Struct({
  appId: Schema.String,
  channel: Schema.String,
  uid: Schema.String,
  token: Schema.String,
});

export const DayCount: Codec<T.DayCount> = Schema.Struct({
  day: Schema.String,
  commits: Schema.Number,
});

export const Author: Codec<T.Author> = Schema.Struct({
  name: Schema.String,
  commits: Schema.Number,
});

export const ProjectActivity: Codec<T.ProjectActivity> = Schema.Struct({
  project: Schema.String,
  at: Schema.Number,
  days: Schema.mutable(Schema.Array(DayCount)),
  authors: Schema.mutable(Schema.Array(Author)),
  total: Schema.Number,
  first: Schema.optionalKey(Schema.Number),
  last: Schema.optionalKey(Schema.Number),
});

export const LanguageCount: Codec<T.LanguageCount> = Schema.Struct({
  name: Schema.String,
  files: Schema.Number,
  code: Schema.Number,
  comments: Schema.Number,
  blanks: Schema.Number,
});

export const ProjectLanguages: Codec<T.ProjectLanguages> = Schema.Struct({
  project: Schema.String,
  at: Schema.Number,
  languages: Schema.mutable(Schema.Array(LanguageCount)),
});

export const ProjectStack: Codec<T.ProjectStack> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  test: Schema.optionalKey(Schema.String),
  lint: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(Schema.String),
});

export const TemplateBlank: Codec<T.TemplateBlank> = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
});

export const IssueTemplate: Codec<T.IssueTemplate> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.String,
  text: Schema.String,
  blank: Schema.optionalKey(TemplateBlank),
});

export const TemplateKind: Codec<T.TemplateKind> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  templates: Schema.mutable(Schema.Array(IssueTemplate)),
});

export const ProjectTemplates: Codec<T.ProjectTemplates> = Schema.Struct({
  project: Schema.String,
  stack: ProjectStack,
  recent: Schema.mutable(Schema.Array(Schema.String)),
  kinds: Schema.mutable(Schema.Array(TemplateKind)),
});

export const IssueUpdate: Codec<T.IssueUpdate> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  deliver: Schema.optionalKey(Deliverable),
  before: Schema.optionalKey(Schema.String),
});

export const PullRequestCapability: Codec<T.PullRequestCapability> = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.String,
});

export const ProjectSummary: Codec<T.ProjectSummary> = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  git: Schema.Boolean,
  last: Schema.optionalKey(Schema.Number),
  maxSessions: Schema.Number,
  pullRequest: PullRequestCapability,
});

export const NewProject: Codec<T.NewProject> = Schema.Struct({
  name: Schema.String,
  github: Schema.optionalKey(Schema.String),
});

export const Skill: Codec<T.Skill> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
});

export const OrchestratorEvalRequest: Codec<T.OrchestratorEvalRequest> = Schema.Struct({
  agent: Schema.optionalKey(Schema.String),
  on: Schema.Number,
  want: Schema.String,
});

export const OrchestratorEval: Codec<T.OrchestratorEval> = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
});

export const ArchiveFile: Codec<T.ArchiveFile> = Schema.Struct({
  name: Schema.String,
  at: Schema.Number,
  chars: Schema.Number,
});

export const ArchiveHit: Codec<T.ArchiveHit> = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  text: Schema.String,
});

export const ArchiveListing: Codec<T.ArchiveListing> = Schema.Struct({
  files: Schema.mutable(Schema.Array(ArchiveFile)),
  hits: Schema.mutable(Schema.Array(ArchiveHit)),
});

export const MemoryKind: Codec<T.MemoryKind> = Schema.Literals(T.MemoryKindValues);

/** A memory's fields; a found one (MemoryFound) has them and more. */
const memoryFields = {
  id: Schema.String,
  agent: Schema.String,
  kind: MemoryKind,
  text: Schema.String,
  author: Schema.optionalKey(ActorKind),
  project: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(SessionId),
  at: Schema.Number,
  recalled: Schema.Number,
  recalledAt: Schema.optionalKey(Schema.Number),
  fading: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.String),
};

export const Memory: Codec<T.Memory> = Schema.Struct(memoryFields);

export const MemoryRequest: Codec<T.MemoryRequest> = Schema.Struct({
  text: Schema.String,
  project: Schema.optionalKey(Schema.String),
});

export const MemoryScope: Codec<T.MemoryScope> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("project"), project: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);

export const MemoryFound: Codec<T.MemoryFound> = Schema.Struct({ ...memoryFields, source: Schema.String, score: Schema.Number, scope: MemoryScope });

export const MemorySearch: Codec<T.MemorySearch> = Schema.Struct({
  found: Schema.mutable(Schema.Array(MemoryFound)),
  coverage: Schema.mutable(Schema.Array(Schema.String)),
});

export const MemorySourceInfo: Codec<T.MemorySourceInfo> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  on: Schema.Boolean,
  off: Schema.optionalKey(Schema.String),
  canList: Schema.Boolean,
  canForget: Schema.Boolean,
  transcripts: Schema.Boolean,
});

export const MemoryList: Codec<T.MemoryList> = Schema.Struct({
  memories: Schema.mutable(Schema.Array(Memory)),
  sources: Schema.mutable(Schema.Array(MemorySourceInfo)),
  file: Schema.optionalKey(Schema.String),
  carried: Schema.optionalKey(Schema.Number),
});

export const Commit: Codec<T.Commit> = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
  at: Schema.Number,
});

export const ChangedFile: Codec<T.ChangedFile> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  patch: Schema.optionalKey(Schema.String),
});

export const UncommittedItem: Codec<T.UncommittedItem> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
});

export const Changes: Codec<T.Changes> = Schema.Struct({
  project: Schema.String,
  base: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  commits: Schema.mutable(Schema.Array(Commit)),
  files: Schema.mutable(Schema.Array(ChangedFile)),
  uncommitted: Schema.mutable(Schema.Array(UncommittedItem)),
  conflicts: Schema.mutable(Schema.Array(Schema.String)),
  behind: Schema.Number,
});

export const TaskEdit: Codec<T.TaskEdit> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  brief: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const GraphSplitRequest: Codec<T.GraphSplitRequest> = Schema.Struct({
  goal: Schema.String,
  project: Schema.String,
  agent: Schema.optionalKey(Schema.String),
});

export const Dispatched: Codec<T.Dispatched> = Schema.Struct({
  session: Schema.optionalKey(SessionId),
  queued: Schema.optionalKey(Schema.String),
});

export const IssueHistory: Codec<T.IssueHistory> = Schema.Struct({
  issue: Issue,
  sessions: Schema.mutable(Schema.Array(Session)),
  missingSessions: Schema.mutable(Schema.Array(SessionId)),
});

export const IssueRefineRequest: Codec<T.IssueRefineRequest> = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(IssueUpdate),
});

export const IssueRequest: Codec<T.IssueRequest> = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  deliver: Schema.optionalKey(Deliverable),
});

export const RunTriggerKind: Codec<T.RunTriggerKind> = Schema.Literals(T.RunTriggerKindValues);

export const RunTrigger: Codec<T.RunTrigger> = Schema.Struct({
  kind: RunTriggerKind,
  message: Schema.optionalKey(Schema.String),
  cron: Schema.optionalKey(Schema.String),
  missed: Schema.optionalKey(Schema.Boolean),
});

export const Run: Codec<T.Run> = Schema.Struct({
  id: Schema.String,
  session: SessionId,
  issue: Schema.optionalKey(IssueId),
  triggeredBy: RunTrigger,
  heard: Schema.mutable(Schema.Array(Schema.String)),
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  outcome: Schema.optionalKey(Outcome),
  summary: Schema.optionalKey(Schema.String),
  spent: Schema.optionalKey(Spent),
});

export const CommentRequest: Codec<T.CommentRequest> = Schema.Struct({
  text: Schema.String,
  sendKey: Schema.optionalKey(Schema.String),
});

export const SayRequest: Codec<T.SayRequest> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  replyTo: Schema.optionalKey(Schema.Number),
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  station: Schema.optionalKey(Schema.Number),
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const ChannelUpdate: Codec<T.ChannelUpdate> = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  orchestrator: Schema.optionalKey(Schema.String),
});

export const CronRequest: Codec<T.CronRequest> = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
  channel: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  when: CronWhen,
  tz: Schema.optionalKey(Schema.String),
});

export const ChannelRequest: Codec<T.ChannelRequest> = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});

export const KeySource: Codec<T.KeySource> = Schema.Literals(T.KeySourceValues);

export const KeyStatus: Codec<T.KeyStatus> = Schema.Struct({
  source: Schema.optionalKey(KeySource),
  hint: Schema.optionalKey(Schema.String),
});

export const AgoraAppID: Codec<T.AgoraAppID> = Schema.Struct({
  source: Schema.optionalKey(KeySource),
  value: Schema.optionalKey(Schema.String),
});

export const Area: Codec<T.Area> = Schema.Literals(T.AreaValues);

export const Language: Codec<T.Language> = Schema.Literals(T.LanguageValues);

export const VoiceASRAres: Codec<T.VoiceASRAres> = Schema.Struct({
  vendor: Schema.Literal("ares"),
});

export const Model: Codec<T.Model> = Schema.Literals(T.ModelValues);

export const VoiceASRDeepgram: Codec<T.VoiceASRDeepgram> = Schema.Struct({
  vendor: Schema.Literal("deepgram"),
  model: Model,
});

export const VoiceASRMicrosoft: Codec<T.VoiceASRMicrosoft> = Schema.Struct({
  vendor: Schema.Literal("microsoft"),
  region: Schema.String,
});

export const VoiceASR: Codec<T.VoiceASR> = Schema.Union([VoiceASRAres, VoiceASRDeepgram, VoiceASRMicrosoft]);

export const VoiceAnswerOrchestrator: Codec<T.VoiceAnswerOrchestrator> = Schema.Struct({
  vendor: Schema.Literal("orchestrator"),
});

export const VoiceAnswerAgoraModel: Codec<T.VoiceAnswerAgoraModel> = Schema.Literals(T.VoiceAnswerAgoraModelValues);

export const VoiceAnswerAgora: Codec<T.VoiceAnswerAgora> = Schema.Struct({
  vendor: Schema.Literal("agora"),
  model: VoiceAnswerAgoraModel,
});

export const VoiceAnswerDeepseek: Codec<T.VoiceAnswerDeepseek> = Schema.Struct({
  vendor: Schema.Literal("deepseek"),
  model: Schema.String,
});

export const VoiceAnswerOpenai: Codec<T.VoiceAnswerOpenai> = Schema.Struct({
  vendor: Schema.Literal("openai"),
  url: Schema.String,
  model: Schema.String,
});

export const VoiceAnswer: Codec<T.VoiceAnswer> = Schema.Union([VoiceAnswerOrchestrator, VoiceAnswerAgora, VoiceAnswerDeepseek, VoiceAnswerOpenai]);

export const VoiceTTSMinimaxModel: Codec<T.VoiceTTSMinimaxModel> = Schema.Literals(T.VoiceTTSMinimaxModelValues);

export const VoiceTTSMinimax: Codec<T.VoiceTTSMinimax> = Schema.Struct({
  vendor: Schema.Literal("minimax"),
  model: VoiceTTSMinimaxModel,
  voiceId: Schema.String,
});

export const Voice: Codec<T.Voice> = Schema.Literals(T.VoiceValues);

export const VoiceTTSOpenai: Codec<T.VoiceTTSOpenai> = Schema.Struct({
  vendor: Schema.Literal("openai"),
  voice: Voice,
});

export const VoiceTTSMicrosoft: Codec<T.VoiceTTSMicrosoft> = Schema.Struct({
  vendor: Schema.Literal("microsoft"),
  region: Schema.String,
  voiceName: Schema.String,
});

export const VoiceTTS: Codec<T.VoiceTTS> = Schema.Union([VoiceTTSMinimax, VoiceTTSOpenai, VoiceTTSMicrosoft]);

export const VoiceSettings: Codec<T.VoiceSettings> = Schema.Struct({
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

export const DictationVia: Codec<T.DictationVia> = Schema.Literals(T.DictationViaValues);

export const Dictation: Codec<T.Dictation> = Schema.Struct({
  via: DictationVia,
  url: Schema.String,
  model: Schema.String,
});

export const MemorySourceKind: Codec<T.MemorySourceKind> = Schema.Literals(T.MemorySourceKindValues);

export const MemorySource: Codec<T.MemorySource> = Schema.Struct({
  kind: MemorySourceKind,
  url: Schema.String,
  enabled: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  everything: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.String),
  key: KeyStatus,
});

export const Locale: Codec<T.Locale> = Schema.Literals(T.LocaleValues);

export const SettingsStatus: Codec<T.SettingsStatus> = Schema.Struct({
  file: Schema.String,
  home: Schema.String,
  version: Schema.String,
  locale: Locale,
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
  dictationReady: Schema.Boolean,
  mossKey: KeyStatus,
  memorySources: Schema.mutable(Schema.Array(MemorySource)),
});

export const MemorySourceUpdate: Codec<T.MemorySourceUpdate> = Schema.Struct({
  kind: MemorySourceKind,
  url: Schema.String,
  enabled: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  everything: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
});

export const SettingsUpdateVoice: Codec<T.SettingsUpdateVoice> = Schema.Struct({
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

export const SettingsUpdate: Codec<T.SettingsUpdate> = Schema.Struct({
  locale: Schema.optionalKey(Locale),
  deepseekApiKey: Schema.optionalKey(Schema.String),
  agoraAppId: Schema.optionalKey(Schema.String),
  agoraAppCertificate: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(SettingsUpdateVoice),
  asrKey: Schema.optionalKey(Schema.String),
  llmKey: Schema.optionalKey(Schema.String),
  ttsKey: Schema.optionalKey(Schema.String),
  dictation: Schema.optionalKey(Dictation),
  dictationKey: Schema.optionalKey(Schema.String),
  mossKey: Schema.optionalKey(Schema.String),
  memorySources: Schema.optionalKey(Schema.mutable(Schema.Array(MemorySourceUpdate))),
});

export const MossCheckRequest: Codec<T.MossCheckRequest> = Schema.Struct({ key: Schema.optionalKey(Schema.String) });

export const Health: Codec<T.Health> = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
});

export const FactCall: Codec<T.FactCall> = Schema.Struct({
  type: Schema.Literal("call"),
  at: Schema.Number,
  state: CallState,
  reason: Schema.optionalKey(Schema.String),
});

export const FactOrchestrator: Codec<T.FactOrchestrator> = Schema.Struct({
  type: Schema.Literal("orchestrator"),
  at: Schema.Number,
  agent: Schema.String,
  state: OrchestratorState,
  channel: Schema.optionalKey(Schema.String),
});

export const FactMessage: Codec<T.FactMessage> = Schema.Struct({
  type: Schema.Literal("message"),
  at: Schema.Number,
  message: ChatMessage,
  thread: Schema.optionalKey(Schema.String),
  answers: Schema.optionalKey(SessionId),
});

export const FactChannel: Codec<T.FactChannel> = Schema.Struct({
  type: Schema.Literal("channel"),
  at: Schema.Number,
  channel: Channel,
});

export const FactOwnerMentions: Codec<T.FactOwnerMentions> = Schema.Struct({
  type: Schema.Literal("ownerMentions"),
  at: Schema.Number,
  mentions: Schema.mutable(Schema.Array(OwnerMention)),
});

export const FactHired: Codec<T.FactHired> = Schema.Struct({
  type: Schema.Literal("hired"),
  at: Schema.Number,
  session: Session,
});

export const FactStation: Codec<T.FactStation> = Schema.Struct({
  type: Schema.Literal("station"),
  at: Schema.Number,
  id: SessionId,
  station: Schema.Number,
});

export const FactRun: Codec<T.FactRun> = Schema.Struct({
  type: Schema.Literal("run"),
  at: Schema.Number,
  id: SessionId,
  brief: Schema.optionalKey(Schema.String),
});

export const FactDoing: Codec<T.FactDoing> = Schema.Struct({
  type: Schema.Literal("doing"),
  at: Schema.Number,
  id: SessionId,
  action: SessionAction,
  label: Schema.String,
});

export const FactQuiet: Codec<T.FactQuiet> = Schema.Struct({
  type: Schema.Literal("quiet"),
  at: Schema.Number,
  id: SessionId,
  since: Schema.Number,
});

export const FactRetry: Codec<T.FactRetry> = Schema.Struct({
  type: Schema.Literal("retry"),
  at: Schema.Number,
  id: SessionId,
  attempt: Schema.Number,
  of: Schema.optionalKey(Schema.Number),
});

export const FactSpent: Codec<T.FactSpent> = Schema.Struct({
  type: Schema.Literal("spent"),
  at: Schema.Number,
  id: SessionId,
  spent: Spent,
});

export const FactReport: Codec<T.FactReport> = Schema.Struct({
  type: Schema.Literal("report"),
  at: Schema.Number,
  id: SessionId,
  run: Schema.optionalKey(Schema.String),
  outcome: Outcome,
  summary: Schema.String,
  runs: Schema.Number,
  spent: Schema.optionalKey(Spent),
  questions: Schema.optionalKey(Schema.mutable(Schema.Array(Question))),
  checks: Schema.optionalKey(Schema.mutable(Schema.Array(CriterionCheck))),
  answer: Schema.optionalKey(IssueAnswer),
});

export const FactConflict: Codec<T.FactConflict> = Schema.Struct({
  type: Schema.Literal("conflict"),
  at: Schema.Number,
  id: SessionId,
  conflict: Schema.optionalKey(Conflict),
});

export const FactLeft: Codec<T.FactLeft> = Schema.Struct({
  type: Schema.Literal("left"),
  at: Schema.Number,
  id: SessionId,
  closed: Schema.optionalKey(SessionClose),
  merged: Schema.optionalKey(Schema.Number),
});

export const FactCommits: Codec<T.FactCommits> = Schema.Struct({
  type: Schema.Literal("commits"),
  at: Schema.Number,
  commits: CommitCount,
});

export const FactIssue: Codec<T.FactIssue> = Schema.Struct({
  type: Schema.Literal("issue"),
  at: Schema.Number,
  issue: Issue,
});

export const FactChannelGone: Codec<T.FactChannelGone> = Schema.Struct({
  type: Schema.Literal("channelGone"),
  at: Schema.Number,
  id: Schema.String,
});

export const FactIssueGone: Codec<T.FactIssueGone> = Schema.Struct({
  type: Schema.Literal("issueGone"),
  at: Schema.Number,
  id: IssueId,
});

export const FactProgress: Codec<T.FactProgress> = Schema.Struct({
  type: Schema.Literal("progress"),
  at: Schema.Number,
  progress: Progress,
  news: Schema.optionalKey(ProgressNews),
});

export const FactCron: Codec<T.FactCron> = Schema.Struct({
  type: Schema.Literal("cron"),
  at: Schema.Number,
  cron: Cron,
});

export const FactCronGone: Codec<T.FactCronGone> = Schema.Struct({
  type: Schema.Literal("cronGone"),
  at: Schema.Number,
  id: Schema.String,
});

export const FactConnector: Codec<T.FactConnector> = Schema.Struct({
  type: Schema.Literal("connector"),
  at: Schema.Number,
  status: ConnectorStatus,
});

export const Fact: Codec<T.Fact> = Schema.Union([
  FactCall,
  FactOrchestrator,
  FactMessage,
  FactChannel,
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
  FactChannelGone,
  FactProgress,
  FactCron,
  FactCronGone,
  FactConnector,
]);

export const SideEventSnapshot: Codec<T.SideEventSnapshot> = Schema.Struct({
  type: Schema.Literal("snapshot"),
  at: Schema.Number,
  state: WorkspaceState,
});

export const SideEventSessionEvent: Codec<T.SideEventSessionEvent> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Number,
  id: Schema.String,
  activity: SessionEvent,
});

export const SideEventNotice: Codec<T.SideEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Number,
  level: NoticeLevel,
  text: Schema.String,
});

export const SideEventRuntime: Codec<T.SideEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Number,
  info: RuntimeInfo,
});

export const SideEvent: Codec<T.SideEvent> = Schema.Union([
  FactCall,
  FactOrchestrator,
  FactMessage,
  FactChannel,
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
  FactChannelGone,
  FactProgress,
  FactCron,
  FactCronGone,
  FactConnector,
  SideEventSnapshot,
  SideEventSessionEvent,
  SideEventNotice,
  SideEventRuntime,
]);

export const Roots: Codec<T.Roots> = Schema.Struct({
  fact: Fact,
  event: SideEvent,
  frame: StateFrame,
  ledger: LedgerEntry,
  taskEvent: GraphEvent,
});

export const CronUpdate: Codec<T.CronUpdate> = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const IssueReviewRequest: Codec<T.IssueReviewRequest> = Schema.Struct({
  pass: Schema.Boolean,
  findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  text: Schema.optionalKey(Schema.String),
});

export const IssueFilter: Codec<T.IssueFilter> = Schema.Struct({
  status: Schema.optionalKey(IssueStatus),
  text: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  closed: Schema.optionalKey(Schema.Boolean),
  wantsOwner: Schema.optionalKey(Schema.Boolean),
});

export const TaskDraft: Codec<T.TaskDraft> = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  brief: Schema.String,
  needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  acceptance: Schema.optionalKey(Schema.Boolean),
});

export const IssueSplitRequest: Codec<T.IssueSplitRequest> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  tasks: Schema.mutable(Schema.Array(TaskDraft)),
});

export const IssueStatusRequest: Codec<T.IssueStatusRequest> = Schema.Struct({
  status: IssueStatus,
  text: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(IssueUpdate),
});

export const GraphActRequest: Codec<T.GraphActRequest> = Schema.Struct({
  action: GraphAction,
});

export const TaskActRequest: Codec<T.TaskActRequest> = Schema.Struct({
  action: TaskAction,
});

export const ChatReadRequest: Codec<T.ChatReadRequest> = Schema.Struct({
  number: Schema.Number,
});

export const ChooseTitleRequest: Codec<T.ChooseTitleRequest> = Schema.Struct({
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Number),
});

export const RenewRequest: Codec<T.RenewRequest> = Schema.Struct({
  channel: Schema.String,
  uid: Schema.String,
});

export const DictateRequest: Codec<T.DictateRequest> = Schema.Struct({
  audio: Schema.String,
  format: Schema.String,
});

export const Dictated: Codec<T.Dictated> = Schema.Struct({
  text: Schema.String,
});

export const VoiceSaid: Codec<T.VoiceSaid> = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String,
});

export const VoiceHeard: Codec<T.VoiceHeard> = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String,
  agent: Schema.NullOr(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const StartRequest: Codec<T.StartRequest> = Schema.Struct({
  channel: Schema.String,
  uid: Schema.String,
  about: Schema.optionalKey(Schema.String),
});

export const VerifyRequest: Codec<T.VerifyRequest> = Schema.Struct({
  code: Schema.String,
});

export const ConnectorsChannelRequest: Codec<T.ConnectorsChannelRequest> = Schema.Struct({
  channel: Schema.String,
});

export const SetOpenRequest: Codec<T.SetOpenRequest> = Schema.Struct({
  open: Schema.Boolean,
});

export const AnswerPairingRequest: Codec<T.AnswerPairingRequest> = Schema.Struct({
  allow: Schema.Boolean,
});

export const LiveEventSession: Codec<T.LiveEventSession> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Number,
  id: Schema.String,
  activity: SessionEvent,
});

export const LiveEventNotice: Codec<T.LiveEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Number,
  level: NoticeLevel,
  text: Schema.String,
});

export const LiveEventRuntime: Codec<T.LiveEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Number,
  info: RuntimeInfo,
});

export const LiveEvent: Codec<T.LiveEvent> = Schema.Union([LiveEventSession, LiveEventNotice, LiveEventRuntime]);

export const Document: Codec<T.Document> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  seq: Schema.Number,
  created: Schema.Number,
  updated: Schema.Number,
});

export const DocMarks: Codec<T.DocMarks> = Schema.Struct({
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.Boolean),
  strike: Schema.optionalKey(Schema.Boolean),
  link: Schema.optionalKey(Schema.String),
});

export const DocSpan: Codec<T.DocSpan> = Schema.Struct({
  t: Schema.String,
  marks: DocMarks,
});

export const BlockAttrs: Codec<T.BlockAttrs> = Schema.Struct({
  level: Schema.optionalKey(Schema.Number),
  checked: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.String),
  src: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  alt: Schema.optionalKey(Schema.String),
  issueId: Schema.optionalKey(IssueId),
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

export const BlockInput: Codec<T.BlockInput> = Schema.Struct(blockInputFields);

export const Block: Codec<T.Block> = Schema.Struct({
  ...blockInputFields,
  docId: Schema.String,
  rev: Schema.Number,
  deleted: Schema.optionalKey(Schema.Boolean),
  updatedBy: Schema.String,
  updated: Schema.Number,
});

export const DocSnapshot: Codec<T.DocSnapshot> = Schema.Struct({
  doc: Document,
  blocks: Schema.mutable(Schema.Array(Block)),
});

export const DocRequest: Codec<T.DocRequest> = Schema.Struct({
  title: Schema.String,
});

export const DocImport: Codec<T.DocImport> = Schema.Struct({
  title: Schema.String,
  markdown: Schema.String,
});

export const DocMarkdown: Codec<T.DocMarkdown> = Schema.Struct({
  markdown: Schema.String,
});

export const DocOpInsertBlock: Codec<T.DocOpInsertBlock> = Schema.Struct({
  op: Schema.Literal("insert_block"),
  block: BlockInput,
});

export const DocOpUpdateText: Codec<T.DocOpUpdateText> = Schema.Struct({
  op: Schema.Literal("update_text"),
  blockId: Schema.String,
  baseRev: Schema.Number,
  text: Schema.mutable(Schema.Array(DocSpan)),
});

export const DocOpSetAttrs: Codec<T.DocOpSetAttrs> = Schema.Struct({
  op: Schema.Literal("set_attrs"),
  blockId: Schema.String,
  attrs: BlockAttrs,
  unset: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const DocOpSetType: Codec<T.DocOpSetType> = Schema.Struct({
  op: Schema.Literal("set_type"),
  blockId: Schema.String,
  type: Schema.String,
  attrs: BlockAttrs,
});

export const DocOpMoveBlock: Codec<T.DocOpMoveBlock> = Schema.Struct({
  op: Schema.Literal("move_block"),
  blockId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  orderKey: Schema.String,
});

export const DocOpDeleteBlock: Codec<T.DocOpDeleteBlock> = Schema.Struct({
  op: Schema.Literal("delete_block"),
  blockId: Schema.String,
});

export const DocOpRestoreBlock: Codec<T.DocOpRestoreBlock> = Schema.Struct({
  op: Schema.Literal("restore_block"),
  blockId: Schema.String,
});

export const DocOpSplitBlock: Codec<T.DocOpSplitBlock> = Schema.Struct({
  op: Schema.Literal("split_block"),
  blockId: Schema.String,
  baseRev: Schema.Number,
  offset: Schema.Number,
  newBlock: BlockInput,
});

export const DocOpMergeBlocks: Codec<T.DocOpMergeBlocks> = Schema.Struct({
  op: Schema.Literal("merge_blocks"),
  targetId: Schema.String,
  sourceId: Schema.String,
});

export const DocOp: Codec<T.DocOp> = Schema.Union([
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

export const DocSubmit: Codec<T.DocSubmit> = Schema.Struct({
  batchId: Schema.String,
  lastSeq: Schema.Number,
  ops: Schema.mutable(Schema.Array(DocOp)),
});

export const DocOpStatus: Codec<T.DocOpStatus> = Schema.Literals(T.DocOpStatusValues);

export const DocBlockCreate: Codec<T.DocBlockCreate> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Number),
  text: Schema.String,
});

export const DocBlockUpdate: Codec<T.DocBlockUpdate> = Schema.Struct({
  block: Schema.String,
  baseRev: Schema.Number,
  text: Schema.String,
});

export const DocOpResult: Codec<T.DocOpResult> = Schema.Struct({
  status: DocOpStatus,
  blockId: Schema.String,
  rev: Schema.optionalKey(Schema.Number),
  text: Schema.optionalKey(Schema.mutable(Schema.Array(DocSpan))),
  yours: Schema.optionalKey(Schema.mutable(Schema.Array(DocSpan))),
  reason: Schema.optionalKey(Schema.String),
});

export const DocAck: Codec<T.DocAck> = Schema.Struct({
  batchId: Schema.String,
  seq: Schema.Number,
  results: Schema.mutable(Schema.Array(DocOpResult)),
  blocks: Schema.mutable(Schema.Array(Block)),
});

export const MessageEdit: Codec<T.MessageEdit> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const NotifyRequest: Codec<T.NotifyRequest> = Schema.Struct({ id: Schema.String, notify: Notify });

export const ReactionToggle: Codec<T.ReactionToggle> = Schema.Struct({ id: Schema.String, emoji: Schema.String });

export const AttachmentUpload: Codec<T.AttachmentUpload> = Schema.Struct({ name: Schema.String, type: Schema.String, data: Schema.String });

export const MessageSearch: Codec<T.MessageSearch> = Schema.Struct({ text: Schema.String, channel: Schema.optionalKey(Schema.String) });

export const ChannelUnread: Codec<T.ChannelUnread> = Schema.Struct({
  channel: Schema.String,
  unread: Schema.Number,
  mentionsYou: Schema.Boolean,
  latest: Schema.optionalKey(Schema.String),
});

export const MessageHit: Codec<T.MessageHit> = Schema.Struct({ message: ChatMessage, channel: Schema.String, address: Schema.String });
