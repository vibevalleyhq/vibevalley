//! Assembled slice state for [`super::scene::DioramaScene`], fed incrementally
//! by per-domain server slices (`SliceKind::Farm`, `Board`, `Sessions`, `Inbox`,
//! `Collab`).

use std::collections::BTreeMap;

use vibevalley_protocol::{
    BoardSlice, CallState, Chat, CollabSlice, FarmFrame, FarmLevel, FarmView, GameEffect, InboxItem, InboxSlice, Issue, PhaseView, PlotView, Progress,
    SessionController, SessionView, SessionsSlice,
};

pub trait SessionExt {
    /// The farm's plot key: the issue it works, else itself.
    fn plot_key(&self) -> &str;
    /// The action of a working session.
    fn doing(&self) -> Option<&'static str>;
    fn is_worker(&self) -> bool;
}

impl SessionExt for SessionView {
    fn plot_key(&self) -> &str {
        self.issue_id().unwrap_or(&self.id)
    }

    fn doing(&self) -> Option<&'static str> {
        match &self.phase {
            PhaseView::Working(w) => Some(w.doing.action.as_str()),
            PhaseView::Done(_) | PhaseView::Failed(_) | PhaseView::Resting(_) | PhaseView::Closed(_) => None,
        }
    }

    fn is_worker(&self) -> bool {
        self.controller == SessionController::IssueBoard || self.controller == SessionController::Channel || self.issue_id().is_some()
    }
}

#[derive(Debug, Clone)]
pub struct Frame {
    pub seq: u64,
    pub effects: Vec<GameEffect>,
    pub inbox: Vec<InboxItem>,
    pub call: CallState,
    pub sessions: Vec<SessionView>,
    pub issues: Vec<Issue>,
    pub progress: Option<Progress>,
    pub chat: Chat,
    pub view: FarmView,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            seq: 0,
            effects: Vec::new(),
            inbox: Vec::new(),
            call: CallState::Idle,
            sessions: Vec::new(),
            issues: Vec::new(),
            progress: None,
            chat: Chat::default(),
            view: FarmView {
                level: FarmLevel { level: 1, xp: 0, need: 10 },
                plots: BTreeMap::new(),
                plays: BTreeMap::new(),
                decorations: Vec::new(),
            },
        }
    }
}

impl Frame {
    #[cfg(test)]
    pub fn from_bundle(bundle: vibevalley_protocol::SliceBundle) -> Self {
        let mut frame = Self {
            seq: bundle.seq.max(0) as u64,
            ..Self::default()
        };
        frame.apply_board(bundle.board);
        frame.apply_sessions(bundle.sessions);
        frame.apply_collab(bundle.collab);
        frame.apply_inbox(bundle.inbox);
        frame.apply_farm(bundle.farm);
        frame
    }

    pub fn apply_board(&mut self, board: BoardSlice) {
        self.seq = self.seq.max(board.seq.max(0) as u64);
        self.issues = board.issues;
    }

    pub fn apply_sessions(&mut self, sessions: SessionsSlice) {
        self.seq = self.seq.max(sessions.seq.max(0) as u64);
        self.sessions = sessions.sessions;
    }

    pub fn apply_collab(&mut self, collab: CollabSlice) {
        self.seq = self.seq.max(collab.seq.max(0) as u64);
        self.chat = collab.chat.unwrap_or_default();
    }

    pub fn apply_inbox(&mut self, inbox: InboxSlice) {
        self.seq = self.seq.max(inbox.seq.max(0) as u64);
        self.inbox = inbox.items;
        self.call = inbox.call;
    }

    pub fn apply_farm(&mut self, farm: FarmFrame) {
        self.seq = self.seq.max(farm.seq.max(0) as u64);
        self.view = farm.view;
        self.progress = farm.progress;
        self.effects = farm.effects;
    }

    /// 0..5, or -1 while every bed is taken.
    pub fn station_of(&self, s: &SessionView) -> i32 {
        self.view.plays.get(&s.id).map(|p| p.station as i32).unwrap_or(-1)
    }

    pub fn plot_of(&self, s: &SessionView) -> Option<&PlotView> {
        self.view.plots.get(s.plot_key())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_protocol::{AgentRole, ContextRef, Crop, DoingView, ExecutionPolicy, PhaseWorkingView, SessionAction, SessionPlayView};

    #[test]
    fn reads_empty_bundle_and_incremental_slices() {
        let f = Frame::from_bundle(vibevalley_server::gateway::bridge::fake::empty_bundle(3));
        assert_eq!(f.seq, 3);
        assert!(f.sessions.is_empty());

        let mut frame = Frame::default();
        frame.apply_sessions(SessionsSlice {
            seq: 1,
            sessions: vec![SessionView {
                id: "s1".into(),
                controller: SessionController::IssueBoard,
                role: Some(AgentRole::Worker),
                name: "owl".into(),
                profile: Some("a".into()),
                runtime: "claude".into(),
                brief: String::new(),
                cwd: None,
                policy: ExecutionPolicy::SandboxDir,
                bindings: vec![ContextRef::Issue {
                    id: "i1".into(),
                    refining: None,
                }],
                hired_at: 0,
                runs: 1,
                last_run: None,
                spent: None,
                telemetry: None,
                subagents: None,
                tool_connections: None,
                machine: None,
                phase: PhaseView::Working(PhaseWorkingView {
                    since: 1,
                    quiet_since: None,
                    retry: None,
                    doing: DoingView {
                        action: SessionAction::ReadFile,
                        label: "x".into(),
                        action_text: "x".into(),
                    },
                }),
                phase_text: "working".into(),
            }],
            machines: vec![],
        });
        let mut plots = BTreeMap::new();
        plots.insert(
            "i1".into(),
            PlotView {
                crop: Crop::Leafy,
                badge: None,
            },
        );
        let mut plays = BTreeMap::new();
        plays.insert(
            "s1".into(),
            SessionPlayView {
                station: 2,
                ..Default::default()
            },
        );
        frame.apply_farm(FarmFrame {
            seq: 2,
            view: FarmView {
                level: FarmLevel { level: 3, xp: 4, need: 30 },
                plots,
                plays,
                decorations: Vec::new(),
            },
            progress: None,
            effects: vec![],
        });
        assert_eq!(frame.seq, 2);
        let s = &frame.sessions[0];
        assert_eq!(frame.station_of(s), 2);
        assert_eq!(frame.plot_of(s).map(|p| p.crop), Some(Crop::Leafy));
        assert_eq!(s.doing(), Some("read_file"));
    }
}
