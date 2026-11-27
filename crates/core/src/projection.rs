//! Pure, side-effect-free slice projections from DB domain snapshots +
//! ephemeral `LiveOverlay` (`LiveSnapshot`).
//!
//! Computes all six slices (`BoardSlice`, `SessionsSlice`, `CollabSlice`,
//! `InboxSlice`, `OpsSlice`, `FarmFrame`) without requiring a mutable shadow
//! `SpaceState` or `Fact` replay.

use std::collections::{BTreeMap, HashMap};

use vibevalley_protocol::{
    BoardSlice, CallState, Channel, Chat, CollabSlice, CommitCount, Conflict, ConnectorStatus, ContextRef, Cron, EventTokens, FarmFrame, GameEffect, InboxItem,
    InboxSlice, Issue, Machine, MediaJob, OpsSlice, Phase, Progress, Session, SessionEvent, SessionEventType, SessionId, SessionPlay, SessionSubagents,
    SessionTelemetry, SessionsSlice, Spent, ToolConnection, UserMention,
};

use crate::channel::trim_and_sort_channels;
use crate::core::{channel_summary, cron_view, media_summary, session_view};
use crate::game::farm_view;
use crate::inbox::inbox_items;
use crate::status::{apply_issue_statuses, board_summary, retain_recent_closed_and_sort};

/// Ephemeral in-memory overlay for a single running or live-updated session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveSessionOverlay {
    pub phase: Option<Phase>,
    /// `None` keeps the DB binding, `Some(None)` removes any channel binding,
    /// and `Some(Some(id))` attaches/replaces the channel binding.
    pub channel: Option<Option<String>>,
    pub brief: Option<String>,
    pub spent: Option<Spent>,
    /// `None` keeps DB subagents; `Some(v)` overrides `session.subagents = v`.
    pub subagents: Option<Option<SessionSubagents>>,
    /// `None` keeps DB tool connections; `Some(v)` overrides `session.tool_connections = Some(v)`.
    pub tool_connections: Option<Vec<ToolConnection>>,
    /// `None` keeps DB-folded telemetry; `Some(v)` overrides `session.telemetry = Some(v)`.
    pub telemetry: Option<SessionTelemetry>,
}

/// Ephemeral `LiveOverlay` snapshot combined with DB snapshots during slice projection.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveSnapshot {
    pub sessions: BTreeMap<SessionId, LiveSessionOverlay>,
    pub plays: BTreeMap<SessionId, SessionPlay>,
    pub effects: Vec<GameEffect>,
}

/// Domain inputs needed to project [`BoardSlice`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BoardInput {
    pub issues: Vec<Issue>,
    pub sessions: Vec<Session>,
    pub channels: Vec<Channel>,
    pub commits: Option<CommitCount>,
    pub repos: Vec<crate::health::RepoHealthInput>,
    pub evaluated_at: Option<i64>,
}

/// Domain inputs needed to project [`SessionsSlice`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionInput {
    pub sessions: Vec<Session>,
    pub issues: Vec<Issue>,
    pub machines: Vec<Machine>,
}

/// Domain inputs needed to project [`CollabSlice`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollabInput {
    pub chat: Option<Chat>,
    pub connectors: Vec<ConnectorStatus>,
}

/// Domain inputs needed to project [`InboxSlice`].
#[derive(Debug, Clone, PartialEq)]
pub struct InboxInput {
    pub issues: Vec<Issue>,
    pub sessions: Vec<Session>,
    pub crons: Vec<Cron>,
    pub user_mentions: Vec<UserMention>,
    pub runtime_inbox_items: Vec<InboxItem>,
    pub call: CallState,
    pub call_reason: String,
}

impl Default for InboxInput {
    fn default() -> Self {
        Self {
            issues: Vec::new(),
            sessions: Vec::new(),
            crons: Vec::new(),
            user_mentions: Vec::new(),
            runtime_inbox_items: Vec::new(),
            call: CallState::Idle,
            call_reason: String::new(),
        }
    }
}

/// Domain inputs needed to project [`OpsSlice`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpsInput {
    pub crons: Vec<Cron>,
    pub media: Option<Vec<MediaJob>>,
}

/// Domain inputs needed to project [`FarmFrame`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FarmInput {
    pub issues: Vec<Issue>,
    pub sessions: Vec<Session>,
    pub progress: Option<Progress>,
    pub commits: Option<CommitCount>,
}

fn overlay_session(session: &Session, overlay: &LiveSessionOverlay) -> Session {
    let mut next = session.clone();
    if let Some(phase) = &overlay.phase {
        next.phase = phase.clone();
    }
    if let Some(channel) = &overlay.channel {
        match channel {
            Some(ch) => {
                next.attach_binding(ContextRef::Channel { id: ch.clone() });
            }
            None => {
                next.bindings.retain(|b| !matches!(b, ContextRef::Channel { .. }));
            }
        }
    }
    if let Some(brief) = &overlay.brief {
        next.brief.clone_from(brief);
    }
    if let Some(spent) = &overlay.spent {
        next.spent = Some(spent.clone());
    }
    if let Some(subagents) = &overlay.subagents {
        next.subagents.clone_from(subagents);
    }
    if let Some(connections) = &overlay.tool_connections {
        next.tool_connections = Some(connections.clone());
    }
    if let Some(telemetry) = &overlay.telemetry {
        next.telemetry = Some(telemetry.clone());
    }
    next
}

/// Folds token usage and context window metrics from a single [`EventTokens`] record into [`SessionTelemetry`].
pub fn merge_session_telemetry_usage(dst: &mut SessionTelemetry, tok: &EventTokens) {
    let input = tok.input.max(0);
    let cache_read = tok.cache_read.max(0);
    let output = tok.output.max(0);
    dst.input_tokens += input;
    dst.cache_read_tokens += cache_read;
    dst.output_tokens += output;
    if let Some(cw) = tok.cache_write.filter(|&v| v > 0) {
        dst.cache_write_tokens = Some(dst.cache_write_tokens.unwrap_or(0) + cw);
    }
    if let Some(r) = tok.reasoning.filter(|&v| v > 0) {
        dst.reasoning_tokens = Some(dst.reasoning_tokens.unwrap_or(0) + r);
    }
    if let Some(used) = tok.context_used.filter(|&v| v > 0) {
        dst.context_used = Some(used);
    } else {
        let fallback = input.max(cache_read);
        if fallback > 0 {
            dst.context_used = Some(fallback);
        }
    }
    if let Some(win) = tok.context_window.filter(|&v| v > 0) {
        dst.context_window = Some(win);
    }
}

/// Applies one trajectory [`SessionEvent`] onto a [`SessionTelemetry`] accumulator.
pub fn apply_session_telemetry(dst: &mut SessionTelemetry, event: &SessionEvent) -> bool {
    let mut touched = false;
    match event.r#type {
        SessionEventType::LlmRetry => {
            dst.llm_retries += 1;
            touched = true;
        }
        SessionEventType::RunError => {
            dst.run_errors += 1;
            touched = true;
        }
        _ => {}
    }
    if let Some(tok) = &event.tokens {
        merge_session_telemetry_usage(dst, tok);
        touched = true;
    }
    touched
}

/// Aggregates token usage, context saturation, retries, and errors across ordered session events.
pub fn fold_session_telemetry(events: &[SessionEvent]) -> Option<SessionTelemetry> {
    let mut dst = SessionTelemetry::default();
    let mut any = false;
    for event in events {
        if apply_session_telemetry(&mut dst, event) {
            any = true;
        }
    }
    any.then_some(dst)
}

/// Overlays ephemeral [`LiveSessionOverlay`] entries onto DB-backed sessions.
pub fn overlay_sessions(sessions: &[Session], live: &BTreeMap<SessionId, LiveSessionOverlay>) -> Vec<Session> {
    if live.is_empty() {
        return sessions.to_vec();
    }
    sessions
        .iter()
        .map(|s| match live.get(&s.id) {
            Some(overlay) => overlay_session(s, overlay),
            None => s.clone(),
        })
        .collect()
}

/// Retains recent closed issues, sorts by [`crate::issue_order`], and derives
/// `status`, `refining`, `stage`, and `moves` from `sessions`.
pub fn derive_issues(issues: &[Issue], sessions: &[Session]) -> Vec<Issue> {
    let mut out = issues.to_vec();
    retain_recent_closed_and_sort(&mut out);
    apply_issue_statuses(&mut out, sessions);
    out
}

/// Projects [`BoardSlice`] directly from [`BoardInput`] + [`LiveSnapshot`].
pub fn project_board(input: &BoardInput, live: &LiveSnapshot, seq: i64) -> BoardSlice {
    let sessions = overlay_sessions(&input.sessions, &live.sessions);
    let issues = derive_issues(&input.issues, &sessions);
    let summary = board_summary(&issues, &sessions, &input.channels, input.evaluated_at);
    let repo_health = if input.repos.is_empty() {
        Vec::new()
    } else {
        crate::health::assess_repos_health(&input.repos, &issues, &[], input.evaluated_at.unwrap_or(0))
    };
    BoardSlice {
        seq,
        issues,
        board_summary: Some(summary),
        commits: input.commits.clone(),
        repo_health,
    }
}

/// Projects [`SessionsSlice`] directly from [`SessionInput`] + [`LiveSnapshot`].
pub fn project_sessions(input: &SessionInput, live: &LiveSnapshot, seq: i64) -> SessionsSlice {
    let sessions = overlay_sessions(&input.sessions, &live.sessions);
    let conflicts: HashMap<&str, Option<&Conflict>> = input.issues.iter().map(|i| (i.id.as_str(), i.conflict.as_ref())).collect();
    SessionsSlice {
        seq,
        sessions: sessions
            .iter()
            .map(|h| session_view(h, h.issue_id().and_then(|i| conflicts.get(i).copied().flatten())))
            .collect(),
        machines: input.machines.clone(),
    }
}

/// Projects [`CollabSlice`] directly from [`CollabInput`].
pub fn project_collab(input: &CollabInput, seq: i64) -> CollabSlice {
    let chat = input.chat.as_ref().map(|c| {
        let mut channels = c.channels.clone();
        trim_and_sort_channels(&mut channels);
        Chat {
            channels,
            user_mentions: c.user_mentions.clone(),
        }
    });
    let summary = channel_summary(chat.as_ref().map_or(&[][..], |c| &c.channels[..]));
    CollabSlice {
        seq,
        chat,
        channel_summary: Some(summary),
        connectors: input.connectors.clone(),
    }
}

/// Projects [`InboxSlice`] directly from [`InboxInput`] + [`LiveSnapshot`].
pub fn project_inbox(input: &InboxInput, live: &LiveSnapshot, seq: i64) -> InboxSlice {
    let sessions = overlay_sessions(&input.sessions, &live.sessions);
    let issues = derive_issues(&input.issues, &sessions);
    let items = inbox_items(&issues, &sessions, &input.crons, &input.user_mentions, &input.runtime_inbox_items);
    InboxSlice {
        seq,
        items,
        call: input.call,
        call_reason: input.call_reason.clone(),
    }
}

/// Projects [`OpsSlice`] directly from [`OpsInput`].
pub fn project_ops(input: &OpsInput, seq: i64) -> OpsSlice {
    OpsSlice {
        seq,
        crons: input.crons.iter().map(cron_view).collect(),
        media: input.media.clone(),
        media_summary: Some(media_summary(input.media.as_deref())),
    }
}

/// Projects [`FarmFrame`] directly from [`FarmInput`] + [`LiveSnapshot`].
pub fn project_farm(input: &FarmInput, live: &LiveSnapshot, seq: i64) -> FarmFrame {
    let sessions = overlay_sessions(&input.sessions, &live.sessions);
    let issues = derive_issues(&input.issues, &sessions);
    let view = farm_view(&issues, &sessions, Some(&live.plays), input.commits.as_ref(), input.progress.as_ref());
    FarmFrame {
        seq,
        view,
        progress: input.progress.clone(),
        effects: live.effects.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{board_slice, collab_slice, empty_space_state, farm_frame, inbox_slice, ops_slice, reduce, sessions_slice};
    use vibevalley_protocol::*;

    fn assert_state_parity(state: &SpaceState, effects: Vec<GameEffect>, seq: i64) {
        let live = LiveSnapshot {
            sessions: BTreeMap::new(),
            plays: state.plays.clone().unwrap_or_default(),
            effects: effects.clone(),
        };
        let board_in = BoardInput {
            issues: state.issues.clone(),
            sessions: state.sessions.clone(),
            channels: state.chat.as_ref().map_or_else(Vec::new, |c| c.channels.clone()),
            commits: state.commits.clone(),
            ..Default::default()
        };
        let session_in = SessionInput {
            sessions: state.sessions.clone(),
            issues: state.issues.clone(),
            machines: state.machines.clone(),
        };
        let collab_in = CollabInput {
            chat: state.chat.clone(),
            connectors: state.connectors.clone(),
        };
        let inbox_in = InboxInput {
            issues: state.issues.clone(),
            sessions: state.sessions.clone(),
            crons: state.crons.clone(),
            user_mentions: state.chat.as_ref().map_or_else(Vec::new, |c| c.user_mentions.clone()),
            runtime_inbox_items: state.runtime_inbox_items.clone(),
            call: state.call,
            call_reason: state.call_reason.clone(),
        };
        let ops_in = OpsInput {
            crons: state.crons.clone(),
            media: state.media.clone(),
        };
        let farm_in = FarmInput {
            issues: state.issues.clone(),
            sessions: state.sessions.clone(),
            progress: state.progress.clone(),
            commits: state.commits.clone(),
        };

        assert_eq!(project_board(&board_in, &live, seq), board_slice(state, seq));
        assert_eq!(project_sessions(&session_in, &live, seq), sessions_slice(state, seq));
        assert_eq!(project_collab(&collab_in, seq), collab_slice(state, seq));
        assert_eq!(project_inbox(&inbox_in, &live, seq), inbox_slice(state, seq));
        assert_eq!(project_ops(&ops_in, seq), ops_slice(state, seq));
        assert_eq!(project_farm(&farm_in, &live, seq), farm_frame(state, effects, seq));
    }

    #[test]
    fn empty_inputs_match_empty_space_state() {
        let state = empty_space_state();
        assert_state_parity(&state, vec![], 0);
    }

    #[test]
    fn golden_scenarios_match_space_state_at_every_fold() {
        for name in ["board", "sessions_and_farm", "chat_crons_and_rest", "families", "reviewed_and_answers"] {
            let path = format!("{}/../protocol/golden/projection/{name}.json", env!("CARGO_MANIFEST_DIR"));
            let golden: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let mut state = empty_space_state();
            let mut seq = 0;
            let mut all_effects = vec![];
            assert_state_parity(&state, vec![], seq);

            for fold in golden["folds"].as_array().unwrap() {
                let fact: Fact = serde_json::from_value(fold["fact"].clone()).unwrap();
                let before = state.clone();
                let dirty = reduce(&mut state, &fact);
                if !dirty.is_empty() {
                    seq += 1;
                    all_effects.extend(crate::game::effects_of(&before, &fact));
                    assert_state_parity(&state, all_effects.clone(), seq);
                }
            }
        }
    }

    #[test]
    fn live_session_overlay_drives_working_issue_and_farm_without_mutating_db_session() {
        let mut db_issue = Issue::new("i1", 1, "Fix login", 100);
        db_issue.queued_at = Some(100);
        db_issue.assignments.push(Assignment {
            id: "a1".into(),
            issue: "i1".into(),
            agent: "laozhou".into(),
            assigned_at: 110,
            ended_at: None,
            executions: vec![Execution::Worker {
                session: "w1".into(),
                started_at: 110,
            }],
        });

        let mut db_session = Session::new(
            "w1",
            SessionController::IssueBoard,
            "Laozhou",
            "claude",
            ExecutionPolicy::ManagedWorktree {
                repo: "demo".into(),
                branch: Some("issue-1".into()),
            },
            110,
        );
        db_session.profile = Some("laozhou".into());
        db_session.bindings.push(ContextRef::Issue {
            id: "i1".into(),
            refining: None,
        });

        let mut state = empty_space_state();
        reduce(&mut state, &Fact::issue_changed(100, db_issue.clone()));
        reduce(&mut state, &Fact::session_changed(110, db_session.clone()));
        let live_phase = Phase::Working(PhaseWorking {
            since: 200,
            quiet_since: Some(300),
            retry: None,
            doing: Doing {
                action: SessionAction::EditFile,
                label: "auth.rs".into(),
            },
        });
        let spent = Spent {
            tokens: 1200,
            cny: Some(JsNumber::from(0.05)),
        };
        reduce(
            &mut state,
            &Fact::SessionPhaseChanged(FactSessionPhaseChanged {
                at: 200,
                id: "w1".into(),
                phase: live_phase.clone(),
                channel: Some("general".into()),
                brief: Some("updated brief".into()),
                spent: Some(spent.clone()),
            }),
        );
        let subagents = SessionSubagents {
            run: "r1".into(),
            root_thread_id: "root".into(),
            disconnected_at: None,
            threads: vec![],
            waits: vec![],
        };
        reduce(
            &mut state,
            &Fact::SessionSubagentsChanged(FactSessionSubagentsChanged {
                at: 210,
                id: "w1".into(),
                subagents: Some(subagents.clone()),
            }),
        );
        let tool = ToolConnection {
            server: "mcp".into(),
            status: ToolConnectionStatus::Ready,
            reason: None,
        };
        reduce(
            &mut state,
            &Fact::SessionToolChanged(FactSessionToolChanged {
                at: 220,
                id: "w1".into(),
                connection: tool.clone(),
            }),
        );

        let mut live = LiveSnapshot {
            plays: state.plays.clone().unwrap_or_default(),
            effects: vec![GameEffect::LevelUp(GameEffectLevelUp { level: 2 })],
            ..LiveSnapshot::default()
        };
        live.sessions.insert(
            "w1".into(),
            LiveSessionOverlay {
                phase: Some(live_phase),
                channel: Some(Some("general".into())),
                brief: Some("updated brief".into()),
                spent: Some(spent),
                subagents: Some(Some(subagents)),
                tool_connections: Some(vec![tool]),
                telemetry: None,
            },
        );

        let board = project_board(
            &BoardInput {
                issues: vec![db_issue.clone()],
                sessions: vec![db_session.clone()],
                channels: vec![],
                commits: None,
                ..Default::default()
            },
            &live,
            42,
        );
        assert_eq!(board, board_slice(&state, 42));
        assert_eq!(board.issues[0].status, IssueStatus::InProgress);
        assert_eq!(board.issues[0].stage.state, IssueStageKind::Stuck);
        assert_eq!(board.issues[0].stage.stuck, Some(StuckReason::Quiet));

        let sessions = project_sessions(
            &SessionInput {
                sessions: vec![db_session.clone()],
                issues: vec![db_issue.clone()],
                machines: vec![],
            },
            &live,
            42,
        );
        assert_eq!(sessions, sessions_slice(&state, 42));

        let inbox = project_inbox(
            &InboxInput {
                issues: vec![db_issue.clone()],
                sessions: vec![db_session.clone()],
                crons: vec![],
                user_mentions: vec![],
                runtime_inbox_items: vec![],
                call: state.call,
                call_reason: state.call_reason.clone(),
            },
            &live,
            42,
        );
        assert_eq!(inbox, inbox_slice(&state, 42));

        let farm = project_farm(
            &FarmInput {
                issues: vec![db_issue],
                sessions: vec![db_session],
                progress: None,
                commits: None,
            },
            &live,
            42,
        );
        assert_eq!(farm, farm_frame(&state, live.effects.clone(), 42));
    }

    #[test]
    fn collab_and_board_handle_channel_eviction_and_closed_issue_retention() {
        let mut state = empty_space_state();
        for idx in 0..105 {
            let mut ch = Channel {
                id: format!("t-{idx:03}"),
                r#type: ChannelType::Thread,
                default: false,
                peer: None,
                orchestrator: (idx == 0).then(|| "orch-custom".into()),
                members: None,
                parent: Some("general".into()),
                category: String::new(),
                position: None,
                archived: None,
                notify: Notify::All,
                root: None,
                root_number: None,
                name: None,
                description: String::new(),
                repo: None,
                subject_kind: None,
                subject_id: None,
                last_number: Some(idx),
                replies: 0,
                read: None,
                unread: (idx % 3 == 0).then_some(1),
                title: format!("Thread {idx}"),
                last: None,
                at: idx,
            };
            if idx == 0 {
                ch.r#type = ChannelType::Channel;
                ch.parent = None;
            }
            reduce(&mut state, &Fact::ChannelChanged(FactChannelChanged { at: idx, channel: ch }));
        }
        for idx in 0..55 {
            let mut issue = Issue::new(format!("i-{idx:03}"), idx + 1, format!("Closed {idx}"), idx);
            issue.closed_at = Some(1_000 + idx);
            issue.delivered = Some(Landing::Merged);
            reduce(&mut state, &Fact::issue_changed(1_000 + idx, issue));
        }

        assert_state_parity(&state, vec![], 99);
    }

    #[test]
    fn fold_session_telemetry_aggregates_usage_context_retries_and_errors() {
        let base_event = |seq: i64, r#type: SessionEventType| SessionEvent {
            seq,
            revision: 1,
            time: seq * 1000,
            r#type,
            run: Some("r1".into()),
            call: None,
            under: None,
            thread_id: None,
            text: String::new(),
            action: None,
            action_text: None,
            tool: None,
            input: None,
            output: None,
            ok: None,
            tokens: None,
            connection: None,
            permission: None,
            interaction: None,
            interaction_resolution: None,
        };

        assert_eq!(fold_session_telemetry(&[base_event(1, SessionEventType::UserMessage)]), None);

        let mut u1 = base_event(2, SessionEventType::LlmUsage);
        u1.tokens = Some(EventTokens {
            input: 10_000,
            cache_read: 4_000,
            output: 1_200,
            cache_write: Some(500),
            reasoning: Some(300),
            context_used: Some(14_000),
            context_window: Some(200_000),
        });
        let retry = base_event(3, SessionEventType::LlmRetry);
        let err = base_event(4, SessionEventType::RunError);
        let mut u2 = base_event(5, SessionEventType::LlmUsage);
        u2.tokens = Some(EventTokens {
            input: 20_000,
            cache_read: 12_000,
            output: 800,
            cache_write: None,
            reasoning: Some(200),
            context_used: Some(32_000),
            context_window: Some(200_000),
        });

        let got = fold_session_telemetry(&[u1, retry, err, u2]).expect("telemetry");
        assert_eq!(got.input_tokens, 30_000);
        assert_eq!(got.cache_read_tokens, 16_000);
        assert_eq!(got.output_tokens, 2_000);
        assert_eq!(got.cache_write_tokens, Some(500));
        assert_eq!(got.reasoning_tokens, Some(500));
        assert_eq!(got.context_used, Some(32_000));
        assert_eq!(got.context_window, Some(200_000));
        assert_eq!(got.llm_retries, 1);
        assert_eq!(got.run_errors, 1);
    }
}
