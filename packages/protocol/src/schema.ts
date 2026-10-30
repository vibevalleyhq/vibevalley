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

export const GitHubStatus: Codec<T.GitHubStatus> = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  loggedIn: Schema.Boolean,
  account: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  checkedAt: Schema.Finite,
});

export const Validation: Codec<T.Validation> = Schema.Struct({
  problem: Schema.String,
});

export const RuntimeQuota: Codec<T.RuntimeQuota> = Schema.Struct({
  left: Schema.optionalKey(Schema.Finite),
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

export const AgentFrom: Codec<T.AgentFrom> = Schema.Struct({ template: Schema.String, version: Schema.Finite });

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
  version: Schema.Finite,
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

export const AgentValidateRequest: Codec<T.AgentValidateRequest> = Schema.Struct({
  agents: Schema.mutable(Schema.Array(Agent)),
});

export const AgentValidation: Codec<T.AgentValidation> = Schema.Struct({
  id: Schema.String,
  problems: Schema.mutable(Schema.Array(AgentProblem)),
});

export const RecallPreview: Codec<T.RecallPreview> = Schema.Struct({
  lines: Schema.mutable(Schema.Array(Schema.String)),
  chars: Schema.Finite,
  limit: Schema.Finite,
});

export const AchievementCategory: Codec<T.AchievementCategory> = Schema.Literals(T.AchievementCategoryValues);

export const AchievementTier: Codec<T.AchievementTier> = Schema.Struct({
  need: Schema.Finite,
  title: Schema.String,
  coins: Schema.Finite,
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
  tier: Schema.Finite,
  count: Schema.Finite,
  next: Schema.optionalKey(Schema.Finite),
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
  since: Schema.optionalKey(Schema.Finite),
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
  title: Schema.String,
  description: Schema.String,
  site: Schema.String,
  image: Schema.String,
});

export const Reaction: Codec<T.Reaction> = Schema.Struct({ emoji: Schema.String, by: Schema.mutable(Schema.Array(Schema.String)) });

export const Attachment: Codec<T.Attachment> = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String, size: Schema.Finite });

export const ArtifactBody: Codec<T.ArtifactBody> = Schema.Literals(T.ArtifactBodyValues);

export const ArtifactKind: Codec<T.ArtifactKind> = Schema.Literals(T.ArtifactKindValues);

export const ArtifactCard: Codec<T.ArtifactCard> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: ArtifactBody,
  version: Schema.Finite,
  note: Schema.String,
});

export const ArtifactVersion: Codec<T.ArtifactVersion> = Schema.Struct({
  version: Schema.Finite,
  size: Schema.Finite,
  note: Schema.String,
  by: Schema.String,
  byName: Schema.String,
  at: Schema.Finite,
  channel: Schema.String,
  number: Schema.optionalKey(Schema.Finite),
});

export const Artifact: Codec<T.Artifact> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: ArtifactBody,
  channel: Schema.optionalKey(Schema.String),
  said: Schema.optionalKey(Schema.Struct({ channel: Schema.String, number: Schema.Finite })),
  issue: Schema.optionalKey(Schema.String),
  by: Schema.String,
  byName: Schema.String,
  version: Schema.Finite,
  seq: Schema.Finite,
  versions: Schema.mutable(Schema.Array(ArtifactVersion)),
  at: Schema.Finite,
  updated: Schema.Finite,
});

export const ArtifactRequest: Codec<T.ArtifactRequest> = Schema.Struct({
  title: Schema.String,
  kind: Schema.optionalKey(ArtifactKind),
  content: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
});

export const ArtifactVersionRequest: Codec<T.ArtifactVersionRequest> = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

export const ArtifactListRequest: Codec<T.ArtifactListRequest> = Schema.Struct({
  channel: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
});

export const ArtifactReadRequest: Codec<T.ArtifactReadRequest> = Schema.Struct({
  id: Schema.String,
  version: Schema.optionalKey(Schema.Finite),
});

export const ArtifactContent: Codec<T.ArtifactContent> = Schema.Struct({ version: Schema.Finite, content: Schema.String });

export const ChatMessage: Codec<T.ChatMessage> = Schema.Struct({
  id: Schema.String,
  number: Schema.Finite,
  channel: Schema.String,
  from: Schema.String,
  fromKind: ActorKind,
  name: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  kind: MessageKind,
  text: Schema.String,
  mentions: Schema.mutable(Schema.Array(Schema.String)),
  session: Schema.optionalKey(SessionId),
  run: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Outcome),
  spent: Schema.optionalKey(Spent),
  spoken: Schema.Boolean,
  sendKey: Schema.optionalKey(Schema.String),
  at: Schema.Finite,
  revision: Schema.Finite,
  replyTo: Schema.optionalKey(Schema.Finite),
  edited: Schema.optionalKey(Schema.Finite),
  deleted: Schema.optionalKey(Schema.Finite),
  pinned: Schema.optionalKey(Schema.Finite),
  reactions: Schema.mutable(Schema.Array(Reaction)),
  attachments: Schema.mutable(Schema.Array(Attachment)),
  embeds: Schema.mutable(Schema.Array(Embed)),
  artifact: Schema.optionalKey(ArtifactCard),
});

export const ChannelType: Codec<T.ChannelType> = Schema.Literals(T.ChannelTypeValues);

export const SubjectKind: Codec<T.SubjectKind> = Schema.Literals(T.SubjectKindValues);

export const Channel: Codec<T.Channel> = Schema.Struct({
  id: Schema.String,
  type: ChannelType,
  default: Schema.Boolean,
  peer: Schema.optionalKey(Schema.String),
  orchestrator: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.String),
  category: Schema.String,
  position: Schema.optionalKey(Schema.Finite),
  archived: Schema.optionalKey(Schema.Finite),
  notify: Schema.optionalKey(Notify),
  root: Schema.optionalKey(Schema.String),
  rootNumber: Schema.optionalKey(Schema.Finite),
  name: Schema.optionalKey(Schema.String),
  description: Schema.String,
  project: Schema.optionalKey(Schema.String),
  subjectKind: Schema.optionalKey(SubjectKind),
  subjectId: Schema.optionalKey(Schema.String),
  lastNumber: Schema.optionalKey(Schema.Finite),
  replies: Schema.Finite,
  read: Schema.optionalKey(Schema.Finite),
  unread: Schema.optionalKey(Schema.Finite),
  title: Schema.String,
  last: Schema.optionalKey(Schema.Struct({ from: Schema.String, name: Schema.String, text: Schema.String, at: Schema.Finite })),
  at: Schema.Finite,
});

export const Conflict: Codec<T.Conflict> = Schema.Struct({
  base: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
});

export const SessionAction: Codec<T.SessionAction> = Schema.Literals(T.SessionActionValues);

const doingFields = {
  action: SessionAction,
  label: Schema.String,
};

export const Doing: Codec<T.Doing> = Schema.Struct(doingFields);

export const DoingView: Codec<T.DoingView> = Schema.Struct({ ...doingFields, actionText: Schema.String });

export const PhaseArriving: Codec<T.PhaseArriving> = Schema.TaggedStruct("arriving", {});

export const Retry: Codec<T.Retry> = Schema.Struct({
  attempt: Schema.Finite,
  of: Schema.optionalKey(Schema.Finite),
});

const workingFields = {
  since: Schema.Finite,
  quietSince: Schema.optionalKey(Schema.Finite),
  retry: Schema.optionalKey(Retry),
};

export const PhaseWorking: Codec<T.PhaseWorking> = Schema.TaggedStruct("working", { ...workingFields, doing: Doing });

export const PhaseWorkingView: Codec<T.PhaseWorkingView> = Schema.TaggedStruct("working", { ...workingFields, doing: DoingView });

export const PhaseDone: Codec<T.PhaseDone> = Schema.TaggedStruct("done", {});

export const PhaseFailed: Codec<T.PhaseFailed> = Schema.TaggedStruct("failed", {});

export const PhaseResting: Codec<T.PhaseResting> = Schema.TaggedStruct("resting", {});

export const SessionClose: Codec<T.SessionClose> = Schema.Literals(T.SessionCloseValues);
export const Delivery: Codec<T.Delivery> = Schema.Literals(T.DeliveryValues);
export const IssueCanceled: Codec<T.IssueCanceled> = Schema.Literals(T.IssueCanceledValues);

export const PhaseClosed: Codec<T.PhaseClosed> = Schema.TaggedStruct("closed", {
  at: Schema.Finite,
  closed: SessionClose,
});

export const Phase: Codec<T.Phase> = Schema.Union([PhaseArriving, PhaseWorking, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

export const PhaseView: Codec<T.PhaseView> = Schema.Union([PhaseArriving, PhaseWorkingView, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

export const IssueAnswer: Codec<T.IssueAnswer> = Schema.Struct({
  conclusion: Schema.String,
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  unsure: Schema.mutable(Schema.Array(Schema.String)),
  next: Schema.mutable(Schema.Array(Schema.String)),
});

export const LastRun: Codec<T.LastRun> = Schema.Struct({
  outcome: Outcome,
  summary: Schema.String,
  at: Schema.Finite,
  spent: Schema.optionalKey(Spent),
  answer: Schema.optionalKey(IssueAnswer),
});

export const SessionGraph: Codec<T.SessionGraph> = Schema.Struct({
  id: Schema.String,
  task: Schema.optionalKey(Schema.String),
});

export const ActionStep: Codec<T.ActionStep> = Schema.Struct({ at: Schema.Finite, ...doingFields });

export const ActionStepView: Codec<T.ActionStepView> = Schema.Struct({ at: Schema.Finite, ...doingFields, actionText: Schema.String });

const playFields = {
  station: Schema.Finite,
  toolsThisRun: Schema.Finite,
  counts: Schema.Record(Schema.String, Schema.Finite),
  files: Schema.mutable(Schema.Array(Schema.String)),
  commands: Schema.mutable(Schema.Array(Schema.String)),
  runStartedAt: Schema.optionalKey(Schema.Finite),
};

export const SessionPlay: Codec<T.SessionPlay> = Schema.Struct({ ...playFields, history: Schema.mutable(Schema.Array(ActionStep)) });

export const SessionPlayView: Codec<T.SessionPlayView> = Schema.Struct({ ...playFields, history: Schema.mutable(Schema.Array(ActionStepView)) });

const sessionFields = {
  id: SessionId,
  name: Schema.String,
  agent: Schema.String,
  runtime: Schema.String,
  brief: Schema.String,
  project: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  conflict: Schema.optionalKey(Conflict),
  hiredAt: Schema.Finite,
  runs: Schema.Finite,
  lastRun: Schema.optionalKey(LastRun),
  spent: Schema.optionalKey(Spent),
  graph: Schema.optionalKey(SessionGraph),
  channel: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(IssueId),
  refining: Schema.Boolean,
};

export const Session: Codec<T.Session> = Schema.Struct({ ...sessionFields, phase: Phase, play: Schema.optionalKey(SessionPlay) });

export const SessionView: Codec<T.SessionView> = Schema.Struct({
  ...sessionFields,
  phase: PhaseView,
  play: Schema.optionalKey(SessionPlayView),
  phaseText: Schema.String,
});

export const Repo: Codec<T.Repo> = Schema.Struct({
  path: Schema.String,
  commits: Schema.Finite,
});

export const CommitCount: Codec<T.CommitCount> = Schema.Struct({
  total: Schema.Finite,
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
  scope: Schema.mutable(Schema.Array(Schema.String)),
  acceptance: Schema.Boolean,
  frozen: Schema.mutable(Schema.Array(Schema.String)),
  state: TaskState,
  session: Schema.optionalKey(SessionId),
  conclusion: Schema.String,
  commits: Schema.mutable(Schema.Array(Schema.String)),
  spent: Schema.optionalKey(Spent),
  tries: Schema.Finite,
  failures: Schema.optionalKey(Schema.Finite),
  blockedBy: Schema.mutable(Schema.Array(Schema.String)),
  stateText: Schema.String,
  actions: Schema.mutable(Schema.Array(TaskAction)),
  actionText: Schema.Record(Schema.String, Schema.String),
  canEdit: Schema.Boolean,
  canRemove: Schema.Boolean,
});

export const GraphAction: Codec<T.GraphAction> = Schema.Literals(T.GraphActionValues);

export const TaskGraph: Codec<T.TaskGraph> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  project: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  state: GraphState,
  stateTag: Schema.String,
  actionText: Schema.Record(Schema.String, Schema.String),
  actions: Schema.mutable(Schema.Array(GraphAction)),
  tasks: Schema.mutable(Schema.Array(Task)),
  parallel: Schema.Finite,
  note: Schema.String,
  createdAt: Schema.Finite,
  layers: Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(Schema.String)))),
  asksForYou: Schema.Boolean,
  spent: Schema.optionalKey(Spent),
  settled: Schema.optionalKey(Schema.Finite),
});

export const Unlock: Codec<T.Unlock> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Finite,
  at: Schema.Finite,
});

export const AgentTally: Codec<T.AgentTally> = Schema.Struct({
  hired: Schema.Finite,
  harvested: Schema.Finite,
  failed: Schema.Finite,
});

export const ProgressTitle: Codec<T.ProgressTitle> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Finite,
});

export const Progress: Codec<T.Progress> = Schema.Struct({
  coins: Schema.Finite,
  streak: Schema.Finite,
  bestStreak: Schema.Finite,
  counts: Schema.Record(Schema.String, Schema.Finite),
  unlocked: Schema.mutable(Schema.Array(Unlock)),
  title: Schema.optionalKey(ProgressTitle),
  agents: Schema.Record(Schema.String, AgentTally),
  multiplier: Schema.optionalKey(Schema.Finite),
});

export const ProgressNews: Codec<T.ProgressNews> = Schema.Struct({
  coins: Schema.optionalKey(Schema.Finite),
  session: Schema.optionalKey(SessionId),
  unlocked: Schema.mutable(Schema.Array(Unlock)),
});

export const CronWhenOnce: Codec<T.CronWhenOnce> = Schema.Struct({
  kind: Schema.Literal("once"),
  at: Schema.Finite,
});

export const CronWhenEvery: Codec<T.CronWhenEvery> = Schema.Struct({
  kind: Schema.Literal("every"),
  minutes: Schema.Finite,
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

const cronFields = {
  id: Schema.String,
  name: Schema.String,
  text: Schema.String,
  channel: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  when: CronWhen,
  tz: Schema.String,
  enabled: Schema.Boolean,
  created: Schema.Finite,
  lastRun: Schema.optionalKey(Schema.Finite),
  by: ActorKind,
  pending: Schema.Boolean,
};

export const Cron: Codec<T.Cron> = Schema.Struct(cronFields);

export const CronView: Codec<T.CronView> = Schema.Struct({ ...cronFields, whenText: Schema.String, nextText: Schema.String });

export const OwnerMention: Codec<T.OwnerMention> = Schema.Struct({
  message: ChatMessage,
  channel: Schema.String,
  address: Schema.String,
});

export const Chat: Codec<T.Chat> = Schema.Struct({
  channels: Schema.mutable(Schema.Array(Channel)),
  ownerMentions: Schema.mutable(Schema.Array(OwnerMention)),
});

export const ChannelEvent: Codec<T.ChannelEvent> = Schema.Union([Schema.TaggedStruct("Message", { message: ChatMessage }), Schema.TaggedStruct("Reset", {})]);

export const Priority: Codec<T.Priority> = Schema.Literals(T.PriorityValues);

export const IssueGraph: Codec<T.IssueGraph> = Schema.Struct({
  state: GraphState,
  branch: Schema.optionalKey(Schema.String),
  parallel: Schema.Finite,
  note: Schema.optionalKey(Schema.String),
});

export const IssueTask: Codec<T.IssueTask> = Schema.Struct({
  key: Schema.String,
  state: TaskState,
  check: Schema.optionalKey(Schema.String),
  scope: Schema.mutable(Schema.Array(Schema.String)),
  acceptance: Schema.Boolean,
  frozen: Schema.mutable(Schema.Array(Schema.String)),
  session: Schema.optionalKey(SessionId),
  conclusion: Schema.optionalKey(Schema.String),
  commits: Schema.mutable(Schema.Array(Schema.String)),
  spent: Schema.optionalKey(Spent),
  tries: Schema.Finite,
  failures: Schema.optionalKey(Schema.Finite),
});

export const IssueStatus: Codec<T.IssueStatus> = Schema.Literals(T.IssueStatusValues);

export const PullRequestState: Codec<T.PullRequestState> = Schema.Literals(T.PullRequestStateValues);

export const PullRequest: Codec<T.PullRequest> = Schema.Struct({
  url: Schema.String,
  number: Schema.Finite,
  state: PullRequestState,
});

export const Finding: Codec<T.Finding> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
  resolved: Schema.Boolean,
});

export const IssueRefining: Codec<T.IssueRefining> = Schema.Struct({
  session: SessionId,
  name: Schema.String,
});

export const Question: Codec<T.Question> = Schema.Struct({
  question: Schema.String,
  options: Schema.mutable(Schema.Array(Schema.String)),
});

export const CheckResult: Codec<T.CheckResult> = Schema.Literals(T.CheckResultValues);

export const CriterionCheck: Codec<T.CriterionCheck> = Schema.Struct({
  criterion: Schema.Finite,
  result: CheckResult,
  proof: Schema.String,
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
  since: Schema.optionalKey(Schema.Finite),
  stuck: Schema.optionalKey(StuckReason),
  lead: Schema.optionalKey(IssueAct),
  acts: Schema.mutable(Schema.Array(IssueAction)),
});

export const MilestoneKind: Codec<T.MilestoneKind> = Schema.Literals(T.MilestoneKindValues);

export const Milestone: Codec<T.Milestone> = Schema.Struct({
  at: Schema.Finite,
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
  startedAt: Schema.Finite,
  endedAt: Schema.optionalKey(Schema.Finite),
  outcome: Schema.optionalKey(Outcome),
});

export const Deliverable: Codec<T.Deliverable> = Schema.Literals(T.DeliverableValues);

export const Issue: Codec<T.Issue> = Schema.Struct({
  id: IssueId,
  number: Schema.Finite,
  title: Schema.String,
  description: Schema.String,
  project: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  priority: Priority,
  rank: Schema.optionalKey(Schema.Finite),
  createdAt: Schema.Finite,
  queuedAt: Schema.optionalKey(Schema.Finite),
  sessions: Schema.mutable(Schema.Array(SessionId)),
  closedAt: Schema.optionalKey(Schema.Finite),
  delivered: Schema.optionalKey(Delivery),
  canceled: Schema.optionalKey(IssueCanceled),
  parent: Schema.optionalKey(IssueId),
  blockedBy: Schema.mutable(Schema.Array(Schema.String)),
  graph: Schema.optionalKey(IssueGraph),
  task: Schema.optionalKey(IssueTask),
  cron: Schema.optionalKey(Schema.String),
  status: IssueStatus,
  moves: Schema.mutable(Schema.Array(IssueStatus)),
  pullRequest: Schema.optionalKey(PullRequest),
  deliver: Deliverable,
  talk: Schema.optionalKey(Schema.String),
  reviewedAt: Schema.optionalKey(Schema.Finite),
  findings: Schema.mutable(Schema.Array(Finding)),
  questions: Schema.mutable(Schema.Array(Question)),
  criteria: Schema.mutable(Schema.Array(Schema.String)),
  checks: Schema.mutable(Schema.Array(CriterionCheck)),
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
  qr: Schema.String,
  pairCode: Schema.String,
  channel: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.Finite),
  lastInbound: Schema.optionalKey(Schema.Finite),
  pausedUntil: Schema.optionalKey(Schema.Finite),
  pending: Schema.Finite,
  error: Schema.String,
});

const workspaceFields = {
  call: CallState,
  callReason: Schema.String,
  orchestrators: Schema.Record(Schema.String, OrchestratorNow),
  chat: Schema.optionalKey(Chat),
  commits: Schema.optionalKey(CommitCount),
  progress: Schema.optionalKey(Progress),
  issues: Schema.mutable(Schema.Array(Issue)),
  connectors: Schema.mutable(Schema.Array(ConnectorStatus)),
};

export const WorkspaceState: Codec<T.WorkspaceState> = Schema.Struct({
  ...workspaceFields,
  sessions: Schema.mutable(Schema.Array(Session)),
  crons: Schema.mutable(Schema.Array(Cron)),
});

export const WorkspaceView: Codec<T.WorkspaceView> = Schema.Struct({
  ...workspaceFields,
  sessions: Schema.mutable(Schema.Array(SessionView)),
  crons: Schema.mutable(Schema.Array(CronView)),
});

export const SessionEventType: Codec<T.SessionEventType> = Schema.Literals(T.SessionEventTypeValues);

export const ToolAction: Codec<T.ToolAction> = Schema.Literals(T.ToolActionValues);

export const EventTokens: Codec<T.EventTokens> = Schema.Struct({
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  output: Schema.Finite,
});

export const SessionEvent: Codec<T.SessionEvent> = Schema.Struct({
  seq: Schema.Finite,
  revision: Schema.Finite,
  time: Schema.Finite,
  type: SessionEventType,
  run: Schema.optionalKey(Schema.String),
  call: Schema.optionalKey(Schema.Finite),
  under: Schema.optionalKey(Schema.Finite),
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
  usedPercent: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.Finite),
});

export const Balance: Codec<T.Balance> = Schema.Struct({
  currency: Schema.String,
  amount: Schema.Finite,
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
  description: Schema.String,
  source: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const RuntimeSettings: Codec<T.RuntimeSettings> = Schema.Struct({
  enabled: Schema.Boolean,
  binPath: Schema.String,
  defaultModel: Schema.String,
  defaultEffort: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  dailyBudget: Schema.optionalKey(Schema.Finite),
  maxWorking: Schema.optionalKey(Schema.Finite),
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
  spentToday: Schema.optionalKey(Schema.Finite),
  quota: Schema.optionalKey(RuntimeQuota),
  stop: Schema.String,
  checkedAt: Schema.Finite,
});

export const FarmLevel: Codec<T.FarmLevel> = Schema.Struct({
  level: Schema.Finite,
  xp: Schema.Finite,
  need: Schema.Finite,
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
  tray: Schema.String,
});

export const InboxItem: Codec<T.InboxItem> = Schema.Struct({
  id: Schema.String,
  kind: InboxKind,
  from: InboxFrom,
  who: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
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
  coins: Schema.Finite,
  streak: Schema.Finite,
});

export const GameEffectPenalty: Codec<T.GameEffectPenalty> = Schema.Struct({
  kind: Schema.Literal("penalty"),
  sessionId: SessionId,
});

export const GameEffectLevelUp: Codec<T.GameEffectLevelUp> = Schema.Struct({
  kind: Schema.Literal("levelUp"),
  level: Schema.Finite,
});

export const GameEffectAchievement: Codec<T.GameEffectAchievement> = Schema.Struct({
  kind: Schema.Literal("achievement"),
  achievement: Schema.String,
  tier: Schema.Finite,
  title: Schema.String,
  reached: Schema.String,
  detail: Schema.String,
  coins: Schema.Finite,
  oneOff: Schema.Boolean,
});

export const GameEffect: Codec<T.GameEffect> = Schema.Union([GameEffectReward, GameEffectPenalty, GameEffectLevelUp, GameEffectAchievement]);

export const StateFrame: Codec<T.StateFrame> = Schema.Struct({
  state: WorkspaceView,
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
  detail: Schema.String,
  changes: Schema.mutable(Schema.Array(TaskFieldChange)),
  commits: Schema.mutable(Schema.Array(Schema.String)),
  at: Schema.Finite,
  text: Schema.String,
  actorText: Schema.String,
});

export const LanDevice: Codec<T.LanDevice> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  pairedAt: Schema.Finite,
  lastSeen: Schema.optionalKey(Schema.Finite),
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
  expiresAt: Schema.Finite,
  asking: Schema.optionalKey(Schema.String),
});

export const LanStatus: Codec<T.LanStatus> = Schema.Struct({
  open: Schema.Boolean,
  hostName: Schema.String,
  url: Schema.optionalKey(Schema.String),
  problem: Schema.String,
  pairing: Schema.optionalKey(LanPairing),
  devices: Schema.mutable(Schema.Array(LanDevice)),
});

export const ConnectorLogin: Codec<T.ConnectorLogin> = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  appId: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
});

export const VoiceCall: Codec<T.VoiceCall> = Schema.Struct({
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
  commits: Schema.Finite,
});

export const Author: Codec<T.Author> = Schema.Struct({
  name: Schema.String,
  commits: Schema.Finite,
});

export const ProjectActivity: Codec<T.ProjectActivity> = Schema.Struct({
  project: Schema.String,
  at: Schema.Finite,
  days: Schema.mutable(Schema.Array(DayCount)),
  authors: Schema.mutable(Schema.Array(Author)),
  total: Schema.Finite,
  first: Schema.optionalKey(Schema.Finite),
  last: Schema.optionalKey(Schema.Finite),
});

export const LanguageCount: Codec<T.LanguageCount> = Schema.Struct({
  name: Schema.String,
  files: Schema.Finite,
  code: Schema.Finite,
  comments: Schema.Finite,
  blanks: Schema.Finite,
});

export const ProjectLanguages: Codec<T.ProjectLanguages> = Schema.Struct({
  project: Schema.String,
  at: Schema.Finite,
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
  start: Schema.Finite,
  end: Schema.Finite,
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
  last: Schema.optionalKey(Schema.Finite),
  maxSessions: Schema.Finite,
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
  on: Schema.Finite,
  want: Schema.String,
});

export const OrchestratorEval: Codec<T.OrchestratorEval> = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
});

export const ArchiveFile: Codec<T.ArchiveFile> = Schema.Struct({
  name: Schema.String,
  at: Schema.Finite,
  chars: Schema.Finite,
});

export const ArchiveHit: Codec<T.ArchiveHit> = Schema.Struct({
  file: Schema.String,
  line: Schema.Finite,
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
  at: Schema.Finite,
  recalled: Schema.Finite,
  recalledAt: Schema.optionalKey(Schema.Finite),
  fading: Schema.Boolean,
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

export const MemoryFound: Codec<T.MemoryFound> = Schema.Struct({ ...memoryFields, source: Schema.String, score: Schema.Finite, scope: MemoryScope });

export const MemorySearch: Codec<T.MemorySearch> = Schema.Struct({
  found: Schema.mutable(Schema.Array(MemoryFound)),
  coverage: Schema.mutable(Schema.Array(Schema.String)),
});

export const MemorySourceInfo: Codec<T.MemorySourceInfo> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  on: Schema.Boolean,
  off: Schema.String,
  canList: Schema.Boolean,
  canForget: Schema.Boolean,
  transcripts: Schema.Boolean,
});

export const MemoryList: Codec<T.MemoryList> = Schema.Struct({
  memories: Schema.mutable(Schema.Array(Memory)),
  sources: Schema.mutable(Schema.Array(MemorySourceInfo)),
  file: Schema.optionalKey(Schema.String),
  carried: Schema.optionalKey(Schema.Finite),
});

export const Commit: Codec<T.Commit> = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
  at: Schema.Finite,
});

export const ChangedFile: Codec<T.ChangedFile> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.Finite,
  removed: Schema.Finite,
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
  behind: Schema.Finite,
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
  startedAt: Schema.Finite,
  endedAt: Schema.optionalKey(Schema.Finite),
  outcome: Schema.optionalKey(Outcome),
  summary: Schema.String,
  spent: Schema.optionalKey(Spent),
});

export const CommentRequest: Codec<T.CommentRequest> = Schema.Struct({
  text: Schema.String,
  sendKey: Schema.optionalKey(Schema.String),
});

export const SayRequest: Codec<T.SayRequest> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  replyTo: Schema.optionalKey(Schema.Finite),
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  station: Schema.optionalKey(Schema.Finite),
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
  silenceMs: Schema.Finite,
  interruptMs: Schema.Finite,
  idleSeconds: Schema.Finite,
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
  everything: Schema.Boolean,
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
  silenceMs: Schema.optionalKey(Schema.Finite),
  interruptMs: Schema.optionalKey(Schema.Finite),
  idleSeconds: Schema.optionalKey(Schema.Finite),
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

export const MossVerifyRequest: Codec<T.MossVerifyRequest> = Schema.Struct({ key: Schema.optionalKey(Schema.String) });

export const Health: Codec<T.Health> = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
});

export const FactCall: Codec<T.FactCall> = Schema.Struct({
  type: Schema.Literal("call"),
  at: Schema.Finite,
  state: CallState,
  reason: Schema.String,
});

export const FactOrchestrator: Codec<T.FactOrchestrator> = Schema.Struct({
  type: Schema.Literal("orchestrator"),
  at: Schema.Finite,
  agent: Schema.String,
  state: OrchestratorState,
  channel: Schema.optionalKey(Schema.String),
});

export const FactMessage: Codec<T.FactMessage> = Schema.Struct({
  type: Schema.Literal("message"),
  at: Schema.Finite,
  message: ChatMessage,
  thread: Schema.optionalKey(Schema.String),
  answers: Schema.optionalKey(SessionId),
});

export const FactChannel: Codec<T.FactChannel> = Schema.Struct({
  type: Schema.Literal("channel"),
  at: Schema.Finite,
  channel: Channel,
});

export const FactOwnerMentions: Codec<T.FactOwnerMentions> = Schema.Struct({
  type: Schema.Literal("ownerMentions"),
  at: Schema.Finite,
  mentions: Schema.mutable(Schema.Array(OwnerMention)),
});

export const FactHired: Codec<T.FactHired> = Schema.Struct({
  type: Schema.Literal("hired"),
  at: Schema.Finite,
  session: Session,
});

export const FactStation: Codec<T.FactStation> = Schema.Struct({
  type: Schema.Literal("station"),
  at: Schema.Finite,
  id: SessionId,
  station: Schema.Finite,
});

export const FactRun: Codec<T.FactRun> = Schema.Struct({
  type: Schema.Literal("run"),
  at: Schema.Finite,
  id: SessionId,
  brief: Schema.optionalKey(Schema.String),
});

export const FactDoing: Codec<T.FactDoing> = Schema.Struct({
  type: Schema.Literal("doing"),
  at: Schema.Finite,
  id: SessionId,
  action: SessionAction,
  label: Schema.String,
});

export const FactQuiet: Codec<T.FactQuiet> = Schema.Struct({
  type: Schema.Literal("quiet"),
  at: Schema.Finite,
  id: SessionId,
  since: Schema.Finite,
});

export const FactRetry: Codec<T.FactRetry> = Schema.Struct({
  type: Schema.Literal("retry"),
  at: Schema.Finite,
  id: SessionId,
  attempt: Schema.Finite,
  of: Schema.optionalKey(Schema.Finite),
});

export const FactSpent: Codec<T.FactSpent> = Schema.Struct({
  type: Schema.Literal("spent"),
  at: Schema.Finite,
  id: SessionId,
  spent: Spent,
});

export const FactReport: Codec<T.FactReport> = Schema.Struct({
  type: Schema.Literal("report"),
  at: Schema.Finite,
  id: SessionId,
  run: Schema.optionalKey(Schema.String),
  outcome: Outcome,
  summary: Schema.String,
  runs: Schema.Finite,
  spent: Schema.optionalKey(Spent),
  questions: Schema.mutable(Schema.Array(Question)),
  checks: Schema.mutable(Schema.Array(CriterionCheck)),
  answer: Schema.optionalKey(IssueAnswer),
});

export const FactConflict: Codec<T.FactConflict> = Schema.Struct({
  type: Schema.Literal("conflict"),
  at: Schema.Finite,
  id: SessionId,
  conflict: Schema.optionalKey(Conflict),
});

export const FactLeft: Codec<T.FactLeft> = Schema.Struct({
  type: Schema.Literal("left"),
  at: Schema.Finite,
  id: SessionId,
  closed: Schema.optionalKey(SessionClose),
  merged: Schema.optionalKey(Schema.Finite),
});

export const FactCommits: Codec<T.FactCommits> = Schema.Struct({
  type: Schema.Literal("commits"),
  at: Schema.Finite,
  commits: CommitCount,
});

export const FactIssue: Codec<T.FactIssue> = Schema.Struct({
  type: Schema.Literal("issue"),
  at: Schema.Finite,
  issue: Issue,
});

export const FactChannelGone: Codec<T.FactChannelGone> = Schema.Struct({
  type: Schema.Literal("channelGone"),
  at: Schema.Finite,
  id: Schema.String,
});

export const FactIssueGone: Codec<T.FactIssueGone> = Schema.Struct({
  type: Schema.Literal("issueGone"),
  at: Schema.Finite,
  id: IssueId,
});

export const FactProgress: Codec<T.FactProgress> = Schema.Struct({
  type: Schema.Literal("progress"),
  at: Schema.Finite,
  progress: Progress,
  news: Schema.optionalKey(ProgressNews),
});

export const FactCron: Codec<T.FactCron> = Schema.Struct({
  type: Schema.Literal("cron"),
  at: Schema.Finite,
  cron: Cron,
});

export const FactCronGone: Codec<T.FactCronGone> = Schema.Struct({
  type: Schema.Literal("cronGone"),
  at: Schema.Finite,
  id: Schema.String,
});

export const FactConnector: Codec<T.FactConnector> = Schema.Struct({
  type: Schema.Literal("connector"),
  at: Schema.Finite,
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
  at: Schema.Finite,
  state: WorkspaceState,
});

export const SideEventSessionEvent: Codec<T.SideEventSessionEvent> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Finite,
  id: Schema.String,
  activity: SessionEvent,
});

export const SideEventNotice: Codec<T.SideEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Finite,
  level: NoticeLevel,
  text: Schema.String,
});

export const SideEventRuntime: Codec<T.SideEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Finite,
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
  limit: Schema.optionalKey(Schema.Finite),
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
  number: Schema.Finite,
});

export const ChooseTitleRequest: Codec<T.ChooseTitleRequest> = Schema.Struct({
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Finite),
});

const renewRequestFields = { channel: Schema.String, uid: Schema.String };

export const VoiceGrantRenew: Codec<T.VoiceGrantRenew> = Schema.Struct(renewRequestFields);

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
  agent: Schema.optionalKey(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const VoiceCallStart: Codec<T.VoiceCallStart> = Schema.Struct({ ...renewRequestFields, about: Schema.optionalKey(Schema.String) });

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
  at: Schema.Finite,
  id: Schema.String,
  activity: SessionEvent,
});

export const LiveEventNotice: Codec<T.LiveEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Finite,
  level: NoticeLevel,
  text: Schema.String,
});

export const LiveEventRuntime: Codec<T.LiveEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Finite,
  info: RuntimeInfo,
});

export const LiveEvent: Codec<T.LiveEvent> = Schema.Union([LiveEventSession, LiveEventNotice, LiveEventRuntime]);

export const SpanMarks: Codec<T.SpanMarks> = Schema.Struct({
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.Boolean),
  strike: Schema.optionalKey(Schema.Boolean),
  link: Schema.optionalKey(Schema.String),
});

export const TextSpan: Codec<T.TextSpan> = Schema.Struct({
  t: Schema.String,
  marks: SpanMarks,
});

export const BlockAttrs: Codec<T.BlockAttrs> = Schema.Struct({
  level: Schema.optionalKey(Schema.Finite),
  checked: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.String),
  src: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  alt: Schema.optionalKey(Schema.String),
  issueId: Schema.optionalKey(IssueId),
  memoryId: Schema.optionalKey(Schema.String),
});

export const BlockType: Codec<T.BlockType> = Schema.Literals(T.BlockTypeValues);

const blockInputFields = {
  id: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  orderKey: Schema.String,
  type: BlockType,
  attrs: BlockAttrs,
  text: Schema.mutable(Schema.Array(TextSpan)),
};

export const BlockInput: Codec<T.BlockInput> = Schema.Struct(blockInputFields);

export const Block: Codec<T.Block> = Schema.Struct({
  ...blockInputFields,
  artifactId: Schema.String,
  rev: Schema.Finite,
  deleted: Schema.optionalKey(Schema.Boolean),
  updatedBy: Schema.String,
  updated: Schema.Finite,
});

export const BlockSnapshot: Codec<T.BlockSnapshot> = Schema.Struct({
  artifact: Artifact,
  blocks: Schema.mutable(Schema.Array(Block)),
});

export const ArtifactMarkdown: Codec<T.ArtifactMarkdown> = Schema.Struct({
  markdown: Schema.String,
});

export const BlockOpInsertBlock: Codec<T.BlockOpInsertBlock> = Schema.Struct({
  op: Schema.Literal("insert_block"),
  block: BlockInput,
});

export const BlockOpUpdateText: Codec<T.BlockOpUpdateText> = Schema.Struct({
  op: Schema.Literal("update_text"),
  blockId: Schema.String,
  baseRev: Schema.Finite,
  text: Schema.mutable(Schema.Array(TextSpan)),
});

export const BlockOpSetAttrs: Codec<T.BlockOpSetAttrs> = Schema.Struct({
  op: Schema.Literal("set_attrs"),
  blockId: Schema.String,
  attrs: BlockAttrs,
  unset: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const BlockOpSetType: Codec<T.BlockOpSetType> = Schema.Struct({
  op: Schema.Literal("set_type"),
  blockId: Schema.String,
  type: BlockType,
  attrs: BlockAttrs,
});

export const BlockOpMoveBlock: Codec<T.BlockOpMoveBlock> = Schema.Struct({
  op: Schema.Literal("move_block"),
  blockId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  orderKey: Schema.String,
});

export const BlockOpDeleteBlock: Codec<T.BlockOpDeleteBlock> = Schema.Struct({
  op: Schema.Literal("delete_block"),
  blockId: Schema.String,
});

export const BlockOpRestoreBlock: Codec<T.BlockOpRestoreBlock> = Schema.Struct({
  op: Schema.Literal("restore_block"),
  blockId: Schema.String,
});

export const BlockOpSplitBlock: Codec<T.BlockOpSplitBlock> = Schema.Struct({
  op: Schema.Literal("split_block"),
  blockId: Schema.String,
  baseRev: Schema.Finite,
  offset: Schema.Finite,
  newBlock: BlockInput,
});

export const BlockOpMergeBlocks: Codec<T.BlockOpMergeBlocks> = Schema.Struct({
  op: Schema.Literal("merge_blocks"),
  targetId: Schema.String,
  sourceId: Schema.String,
});

export const BlockOp: Codec<T.BlockOp> = Schema.Union([
  BlockOpInsertBlock,
  BlockOpUpdateText,
  BlockOpSetAttrs,
  BlockOpSetType,
  BlockOpMoveBlock,
  BlockOpDeleteBlock,
  BlockOpRestoreBlock,
  BlockOpSplitBlock,
  BlockOpMergeBlocks,
]);

export const BlockSubmit: Codec<T.BlockSubmit> = Schema.Struct({
  batchId: Schema.String,
  lastSeq: Schema.Finite,
  ops: Schema.mutable(Schema.Array(BlockOp)),
});

export const BlockOpStatus: Codec<T.BlockOpStatus> = Schema.Literals(T.BlockOpStatusValues);

export const BlockCreate: Codec<T.BlockCreate> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Finite),
  text: Schema.String,
});

export const BlockUpdate: Codec<T.BlockUpdate> = Schema.Struct({
  block: Schema.String,
  baseRev: Schema.Finite,
  text: Schema.String,
});

export const BlockOpResult: Codec<T.BlockOpResult> = Schema.Struct({
  status: BlockOpStatus,
  blockId: Schema.String,
  rev: Schema.optionalKey(Schema.Finite),
  text: Schema.optionalKey(Schema.mutable(Schema.Array(TextSpan))),
  yours: Schema.optionalKey(Schema.mutable(Schema.Array(TextSpan))),
  reason: Schema.optionalKey(Schema.String),
});

export const BlockAck: Codec<T.BlockAck> = Schema.Struct({
  batchId: Schema.String,
  seq: Schema.Finite,
  results: Schema.mutable(Schema.Array(BlockOpResult)),
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
  unread: Schema.Finite,
  mentionsYou: Schema.Boolean,
  latest: Schema.optionalKey(Schema.String),
});

export const MessageHit: Codec<T.MessageHit> = Schema.Struct({ message: ChatMessage, channel: Schema.String, address: Schema.String });
