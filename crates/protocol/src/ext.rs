//! Hand-written helpers on the generated types, and the constants of
//! `common/shapes.ts` and the server's core.

use crate::contract::*;

/// Unix milliseconds.
pub type Millis = i64;

pub const DEFAULT_ORCHESTRATOR: &str = "orchestrator";
pub const ORCHESTRATOR_RUNTIME: &str = "vibevalley";
pub const USER_ID: &str = "user";
pub const EVERYONE: &str = "everyone";
pub const MAX_RUNNING: usize = 6;
pub const DAY_MS: Millis = 86_400_000;
/// At most one state frame per this many milliseconds (`stateEveryMs`).
pub const STATE_EVERY_MS: u64 = 200;

/// Every endpoint is a POST at its op.
pub fn path_of(op: &str) -> String {
    format!("/api/v1/{}", op.replace('.', "/"))
}

impl Execution {
    pub fn session(&self) -> &str {
        match self {
            Execution::Worker { session, .. } | Execution::Orchestrator { session, .. } => session,
        }
    }

    pub fn started_at(&self) -> Millis {
        match self {
            Execution::Worker { started_at, .. } | Execution::Orchestrator { started_at, .. } => *started_at,
        }
    }
}

impl From<ToolAction> for SessionAction {
    fn from(action: ToolAction) -> Self {
        match action {
            ToolAction::RunCommand => Self::RunCommand,
            ToolAction::ReadFile => Self::ReadFile,
            ToolAction::EditFile => Self::EditFile,
            ToolAction::Search => Self::Search,
            ToolAction::Web => Self::Web,
            ToolAction::Mcp => Self::Mcp,
            ToolAction::Wait => Self::Wait,
            ToolAction::Other => Self::Other,
        }
    }
}

impl IssueStatus {
    pub fn is_closed(self) -> bool {
        matches!(self, IssueStatus::Done | IssueStatus::Canceled)
    }
}

impl IssueStageKind {
    /// `stageWantsUser` in `packages/protocol/src/rules/stage.ts`.
    pub fn wants_user(self) -> bool {
        matches!(self, IssueStageKind::Asking | IssueStageKind::Reviewing | IssueStageKind::Stuck)
    }
}

impl IssueAction {
    pub fn act(&self) -> IssueAct {
        match self {
            IssueAction::Move { act, .. } | IssueAction::Say { act } | IssueAction::Stop { act } => *act,
        }
    }
}

impl Issue {
    pub fn executions(&self) -> impl Iterator<Item = &Execution> {
        self.assignments.iter().flat_map(|a| a.executions.iter())
    }

    /// `latestSessionIdOf` in `packages/protocol/src/rules`: the newest
    /// worker session.
    pub fn latest_session_id(&self) -> Option<&SessionId> {
        self.executions()
            .filter_map(|e| match e {
                Execution::Worker { session, .. } => Some(session),
                Execution::Orchestrator { .. } => None,
            })
            .last()
    }

    pub fn was_sent(&self) -> bool {
        self.executions().next().is_some() || self.last_run.is_some()
    }

    /// `assignedAgentOf`: the open assignment's profile.
    pub fn assigned_agent(&self) -> Option<&str> {
        self.assignments.iter().rev().find(|a| a.ended_at.is_none()).map(|a| a.agent.as_str())
    }
}

impl Phase {
    pub fn is_working(&self) -> bool {
        matches!(self, Phase::Working(_))
    }
}

/// `defaultBotReviewRounds` (`issue/creation.ts`).
pub const DEFAULT_BOT_REVIEW_ROUNDS: i64 = 3;

impl IssueMandate {
    /// `explicitMandate`.
    pub fn explicit(origin_trigger_id: &str, auto_submit_pr: bool) -> IssueMandate {
        IssueMandate {
            origin_trigger_id: (!origin_trigger_id.is_empty()).then(|| origin_trigger_id.to_string()),
            strength: MandateStrength::Explicit,
            max_bot_review_rounds: DEFAULT_BOT_REVIEW_ROUNDS,
            auto_submit_pr,
        }
    }

    /// `inferredMandate`.
    pub fn inferred(origin_trigger_id: &str) -> IssueMandate {
        IssueMandate {
            strength: MandateStrength::Inferred,
            ..IssueMandate::explicit(origin_trigger_id, false)
        }
    }
}

impl IssueStage {
    /// A new backlog issue's stage before the fold words it.
    pub fn draft(since: Millis) -> IssueStage {
        IssueStage {
            state: IssueStageKind::Draft,
            since: Some(since),
            stuck: None,
            lead: None,
            acts: vec![],
        }
    }
}

impl Issue {
    /// A fresh issue in the backlog, asked for explicitly, delivering a change.
    pub fn new(id: impl Into<IssueId>, number: i64, title: impl Into<String>, created_at: Millis) -> Issue {
        Issue {
            constraints: None,
            id: id.into(),
            number,
            title: title.into(),
            description: String::new(),
            mandate: IssueMandate::explicit("", false),
            conflict: None,
            repo: None,
            machine_id: None,
            assignments: vec![],
            priority: Priority::Medium,
            rank: None,
            created_at,
            queued_at: None,
            closed_at: None,
            delivered: None,
            canceled: None,
            parent: None,
            blocked_by: vec![],
            cron: None,
            status: IssueStatus::Backlog,
            moves: vec![],
            pull_request: None,
            deliver: Deliverable::Change,
            reviewed_at: None,
            delivery_evidence: None,
            findings: vec![],
            questions: vec![],
            criteria: vec![],
            checks: vec![],
            refining: None,
            last_run: None,
            answer: None,
            stage: IssueStage::draft(created_at),
            attachments: vec![],
        }
    }
}

fn issue_binding(bindings: &[ContextRef]) -> Option<(&str, bool)> {
    bindings.iter().find_map(|b| match b {
        ContextRef::Issue { id, refining } => Some((id.as_str(), refining.unwrap_or(false))),
        ContextRef::Channel { .. } | ContextRef::Artifact { .. } => None,
    })
}

fn channel_binding(bindings: &[ContextRef]) -> Option<&str> {
    bindings.iter().find_map(|b| match b {
        ContextRef::Channel { id } => Some(id.as_str()),
        ContextRef::Issue { .. } | ContextRef::Artifact { .. } => None,
    })
}

fn policy_repo(policy: &ExecutionPolicy) -> Option<&str> {
    match policy {
        ExecutionPolicy::DirectCwd { repo, .. } => repo.as_deref(),
        ExecutionPolicy::ManagedWorktree { repo, .. } => Some(repo.as_str()),
        ExecutionPolicy::SandboxDir => None,
    }
}

fn policy_branch(policy: &ExecutionPolicy) -> Option<&str> {
    match policy {
        ExecutionPolicy::ManagedWorktree { branch, .. } => branch.as_deref(),
        ExecutionPolicy::DirectCwd { .. } | ExecutionPolicy::SandboxDir => None,
    }
}

fn same_binding_key(a: &ContextRef, b: &ContextRef) -> bool {
    match (a, b) {
        (ContextRef::Issue { id: x, .. }, ContextRef::Issue { id: y, .. }) => x == y,
        (ContextRef::Channel { id: x }, ContextRef::Channel { id: y }) => x == y,
        (ContextRef::Artifact { id: x }, ContextRef::Artifact { id: y }) => x == y,
        _ => false,
    }
}

macro_rules! impl_session_readers {
    ($ty:ty) => {
        impl $ty {
            pub fn issue_id(&self) -> Option<&str> {
                issue_binding(&self.bindings).map(|(id, _)| id)
            }

            pub fn is_refining(&self) -> bool {
                issue_binding(&self.bindings).is_some_and(|(_, refining)| refining)
            }

            pub fn channel_id(&self) -> Option<&str> {
                channel_binding(&self.bindings)
            }

            pub fn repo_name(&self) -> Option<&str> {
                policy_repo(&self.policy)
            }

            pub fn worktree_branch(&self) -> Option<&str> {
                policy_branch(&self.policy)
            }

            pub fn profile_id(&self) -> Option<&str> {
                self.profile.as_deref()
            }

            pub fn is_board_worker(&self) -> bool {
                self.controller == SessionController::IssueBoard || self.issue_id().is_some()
            }

            pub fn is_direct_talker(&self) -> bool {
                self.controller == SessionController::Channel
            }

            pub fn is_orchestrator(&self) -> bool {
                self.controller == SessionController::Orchestrator && self.role == Some(AgentRole::Orchestrator)
            }

            pub fn is_free_user(&self) -> bool {
                self.controller == SessionController::User && self.bindings.is_empty()
            }
        }
    };
}

impl_session_readers!(Session);
impl_session_readers!(SessionView);

impl Session {
    /// A newly created resting session without initial bindings or profile.
    pub fn new(
        id: impl Into<SessionId>,
        controller: SessionController,
        name: impl Into<String>,
        runtime: impl Into<String>,
        policy: ExecutionPolicy,
        hired_at: Millis,
    ) -> Session {
        Session {
            id: id.into(),
            controller,
            role: match controller {
                SessionController::Orchestrator => Some(AgentRole::Orchestrator),
                SessionController::IssueBoard | SessionController::Channel => Some(AgentRole::Worker),
                SessionController::User => None,
            },
            name: name.into(),
            profile: None,
            runtime: runtime.into(),
            brief: String::new(),
            cwd: None,
            policy,
            bindings: vec![],
            hired_at,
            runs: 0,
            last_run: None,
            spent: None,
            subagents: None,
            tool_connections: None,
            machine: None,
            phase: Phase::resting(),
        }
    }

    /// Attaches or updates a context binding; returns true if `self.bindings` changed.
    pub fn attach_binding(&mut self, binding: ContextRef) -> bool {
        if self.bindings.contains(&binding) {
            return false;
        }
        self.bindings.retain(|existing| !same_binding_key(existing, &binding));
        self.bindings.push(binding);
        true
    }

    /// Removes any context binding sharing the target identity; returns true if removed.
    pub fn detach_binding(&mut self, binding: &ContextRef) -> bool {
        let before = self.bindings.len();
        self.bindings.retain(|existing| !same_binding_key(existing, binding));
        self.bindings.len() != before
    }
}

impl Phase {
    pub fn done() -> Phase {
        Phase::Done(PhaseDone {})
    }

    pub fn failed() -> Phase {
        Phase::Failed(PhaseFailed {})
    }

    pub fn resting() -> Phase {
        Phase::Resting(PhaseResting {})
    }

    pub fn working(since: Millis, action: SessionAction, label: impl Into<String>) -> Phase {
        Phase::Working(PhaseWorking {
            since,
            quiet_since: None,
            retry: None,
            doing: Doing { action, label: label.into() },
        })
    }
}

impl Fact {
    pub fn issue_changed(at: Millis, issue: Issue) -> Fact {
        Fact::IssueChanged(FactIssueChanged { at, issue })
    }

    pub fn issue_removed(at: Millis, id: impl Into<IssueId>) -> Fact {
        Fact::IssueRemoved(FactIssueRemoved { at, id: id.into() })
    }

    pub fn session_changed(at: Millis, session: Session) -> Fact {
        Fact::SessionChanged(FactSessionChanged { at, session })
    }

    pub fn session_left(at: Millis, id: impl Into<SessionId>, closed: Option<SessionClose>) -> Fact {
        Fact::SessionLeft(FactSessionLeft {
            at,
            id: id.into(),
            closed,
            merged: None,
        })
    }

    pub fn session_phase_changed(at: Millis, id: impl Into<SessionId>, phase: Phase, channel: Option<String>) -> Fact {
        Fact::SessionPhaseChanged(FactSessionPhaseChanged {
            at,
            id: id.into(),
            phase,
            channel,
            spent: None,
            brief: None,
        })
    }

    pub fn runtime_inbox_changed(at: Millis, items: Vec<InboxItem>) -> Fact {
        Fact::RuntimeInboxChanged(FactRuntimeInboxChanged { at, items })
    }

    pub fn machine_changed(at: Millis, machine: Machine) -> Fact {
        Fact::MachineChanged(FactMachineChanged { at, machine })
    }

    pub fn machine_removed(at: Millis, id: impl Into<String>) -> Fact {
        Fact::MachineRemoved(FactMachineRemoved { at, id: id.into() })
    }

    /// When it happened.
    pub fn at(&self) -> Millis {
        match self {
            Fact::CallChanged(f) => f.at,
            Fact::SessionToolChanged(f) => f.at,
            Fact::SessionToolsReset(f) => f.at,
            Fact::SessionSubagentsChanged(f) => f.at,
            Fact::SessionPhaseChanged(f) => f.at,
            Fact::MessageChanged(f) => f.at,
            Fact::ChannelChanged(f) => f.at,
            Fact::UserMentionsChanged(f) => f.at,
            Fact::SessionChanged(f) => f.at,
            Fact::SessionReported(f) => f.at,
            Fact::SessionLeft(f) => f.at,
            Fact::ProgressChanged(f) => f.at,
            Fact::IssueChanged(f) => f.at,
            Fact::IssueRemoved(f) => f.at,
            Fact::ChannelRemoved(f) => f.at,
            Fact::CronChanged(f) => f.at,
            Fact::CronRemoved(f) => f.at,
            Fact::ConnectorChanged(f) => f.at,
            Fact::MachineChanged(f) => f.at,
            Fact::MachineRemoved(f) => f.at,
            Fact::MediaChanged(f) => f.at,
            Fact::RuntimeInboxChanged(f) => f.at,
        }
    }
}

/// A new issue's priority when none is said.
impl Default for Priority {
    fn default() -> Self {
        Priority::Medium
    }
}

/// A new issue delivers a change unless it says otherwise.
impl Default for Deliverable {
    fn default() -> Self {
        Deliverable::Change
    }
}
