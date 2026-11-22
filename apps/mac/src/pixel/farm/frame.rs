//! The part of VibeValley's `StateFrame` the pixel scenes read, decoded
//! leniently (missing fields default): the server's frame JSON is the source.

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Crop {
    #[default]
    Empty,
    Seeded,
    Sprout,
    Leafy,
    Flowering,
    Wheat,
    Carrot,
    Withered,
    Weeds,
    Dry,
    Harvested,
    Locked,
}

impl Crop {
    pub fn name(self) -> &'static str {
        match self {
            Crop::Empty => "empty",
            Crop::Seeded => "seeded",
            Crop::Sprout => "sprout",
            Crop::Leafy => "leafy",
            Crop::Flowering => "flowering",
            Crop::Wheat => "wheat",
            Crop::Carrot => "carrot",
            Crop::Withered => "withered",
            Crop::Weeds => "weeds",
            Crop::Dry => "dry",
            Crop::Harvested => "harvested",
            Crop::Locked => "locked",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Frame {
    pub seq: u64,
    pub effects: Vec<vibevalley_protocol::GameEffect>,
    pub inbox: Vec<vibevalley_protocol::InboxItem>,
    pub state: SpaceView,
    pub view: FarmView,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpaceView {
    pub call: String,
    pub sessions: Vec<Session>,
    pub issues: Vec<Issue>,
    pub progress: Option<Progress>,
    pub chat: vibevalley_protocol::Chat,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub controller: vibevalley_protocol::SessionController,
    pub role: Option<vibevalley_protocol::AgentRole>,
    pub name: String,
    pub profile: Option<String>,
    pub cwd: Option<String>,
    pub policy: vibevalley_protocol::ExecutionPolicy,
    pub bindings: Vec<vibevalley_protocol::ContextRef>,
    pub hired_at: f64,
    pub runs: i64,
    pub phase: Phase,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            id: String::new(),
            controller: vibevalley_protocol::SessionController::User,
            role: None,
            name: String::new(),
            profile: None,
            cwd: None,
            policy: vibevalley_protocol::ExecutionPolicy::SandboxDir,
            bindings: Vec::new(),
            hired_at: 0.0,
            runs: 0,
            phase: Phase::default(),
        }
    }
}

impl Session {
    pub fn issue_id(&self) -> Option<&str> {
        self.bindings.iter().find_map(|b| match b {
            vibevalley_protocol::ContextRef::Issue { id, .. } => Some(id.as_str()),
            _ => None,
        })
    }

    pub fn repo_name(&self) -> Option<&str> {
        match &self.policy {
            vibevalley_protocol::ExecutionPolicy::DirectCwd { repo, .. } => repo.as_deref(),
            vibevalley_protocol::ExecutionPolicy::ManagedWorktree { repo, .. } => Some(repo.as_str()),
            vibevalley_protocol::ExecutionPolicy::SandboxDir => None,
        }
    }

    pub fn profile_id(&self) -> Option<&str> {
        self.profile.as_deref()
    }

    /// The farm's plot key: the issue it works, else itself.
    pub fn plot_key(&self) -> &str {
        self.issue_id().unwrap_or(&self.id)
    }

    /// The action of a working session.
    pub fn doing(&self) -> Option<&str> {
        (self.phase.tag == "working").then(|| self.phase.doing.as_ref().map(|d| d.action.as_str()).unwrap_or("none"))
    }

    pub fn is_worker(&self) -> bool {
        self.controller == vibevalley_protocol::SessionController::IssueBoard
            || self.controller == vibevalley_protocol::SessionController::Channel
            || self.issue_id().is_some()
    }

    pub fn is_orchestrator(&self) -> bool {
        self.controller == vibevalley_protocol::SessionController::Orchestrator && self.role == Some(vibevalley_protocol::AgentRole::Orchestrator)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Phase {
    #[serde(rename = "_tag")]
    pub tag: String,
    pub doing: Option<Doing>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Doing {
    pub action: String,
    pub label: String,
    pub action_text: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub number: Option<u64>,
    pub title: String,
    pub repo: Option<String>,
    pub status: String,
    pub delivered: Option<String>,
    pub closed_at: Option<f64>,
    pub queued_at: Option<f64>,
    pub stage: Option<vibevalley_protocol::IssueStage>,
}

impl Issue {
    pub(super) fn harvested(&self) -> bool {
        matches!(self.delivered.as_deref(), Some("merged" | "pull_request"))
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Progress {
    pub coins: f64,
    pub streak: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FarmView {
    pub level: FarmLevel,
    pub plots: HashMap<String, PlotView>,
    pub plays: HashMap<String, Play>,
    pub achievements: Vec<vibevalley_protocol::AchievementStanding>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FarmLevel {
    pub level: f64,
    pub xp: f64,
    pub need: f64,
}

impl Default for FarmLevel {
    fn default() -> Self {
        FarmLevel {
            level: 1.0,
            xp: 0.0,
            need: 10.0,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PlotView {
    pub crop: Crop,
    pub badge: Option<Badge>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Badge {
    pub text: String,
    pub tone: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Play {
    pub station: f64,
}

impl Frame {
    pub fn parse(value: &serde_json::Value) -> Frame {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }

    /// 0..5, or -1 while every bed is taken.
    pub fn station_of(&self, s: &Session) -> i32 {
        self.view.plays.get(&s.id).map(|p| p.station.round() as i32).unwrap_or(-1)
    }

    pub fn plot_of(&self, s: &Session) -> Option<&PlotView> {
        self.view.plots.get(s.plot_key())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_vibevalleys_empty_frame_and_a_session() {
        let f = Frame::parse(&vibevalley_server::transport::bridge::fake::empty_frame(3));
        assert_eq!(f.seq, 3);
        assert!(f.state.sessions.is_empty());
        let f = Frame::parse(&json!({
            "seq": 1,
            "state": { "sessions": [{ "id": "s1", "controller": "issueBoard", "role": "worker", "profile": "a",
                "bindings": [{ "kind": "issue", "id": "i1" }],
                "phase": { "_tag": "working", "doing": { "action": "read_file", "label": "x" } } }] },
            "view": { "level": { "level": 3, "xp": 4, "need": 30 }, "plots": { "i1": { "crop": "leafy" } },
                "plays": { "s1": { "station": 2 } } }
        }));
        let s = &f.state.sessions[0];
        assert_eq!(f.station_of(s), 2);
        assert_eq!(f.plot_of(s).map(|p| p.crop), Some(Crop::Leafy));
        assert_eq!(s.doing(), Some("read_file"));
    }
}
