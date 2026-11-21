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
        }
    }
}

impl Session {
    /// A helper's session, resting, on no issue.
    pub fn worker(id: impl Into<SessionId>, name: impl Into<String>, hired_at: Millis) -> Session {
        Session {
            id: id.into(),
            role: AgentRole::Worker,
            name: name.into(),
            agent: String::new(),
            runtime: String::new(),
            brief: String::new(),
            repo: None,
            branch: None,
            worktree: None,
            hired_at,
            runs: 0,
            phase: Phase::resting(),
            last_run: None,
            spent: None,
            channel: None,
            issue: None,
            refining: false,
            subagents: None,
            tool_connections: None,
            machine: None,
        }
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
            Fact::MediaChanged(f) => f.at,
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

/// A PKM page's normalized slug from its title: trimmed, lower case,
/// whitespace collapsed to `-`, `/` (or `\`) as `__`.
pub fn pkm_slug(title: &str) -> String {
    let s = title.trim().replace('\\', "/").replace('/', "__");
    s.split_whitespace().collect::<Vec<_>>().join("-").to_lowercase()
}
