use vibevalley_protocol::{Session, SessionSubagents, SubagentStatus, SubagentStep, SubagentStepStatus, SubagentThread, SubagentWait};
use vibevalley_runtime::oar::{Event, EventKind, SubagentStatus as ObservedStatus};

use super::journal::tool_detail;

pub(super) fn relevant(event: &Event) -> bool {
    match &event.kind {
        EventKind::TurnStarted { .. } | EventKind::TurnFinished { .. } | EventKind::SessionEnded => event.agent_path.is_empty(),
        EventKind::SubagentPlanUpdated { .. }
        | EventKind::SubagentMessage { .. }
        | EventKind::SubagentSpawned { .. }
        | EventKind::SubagentWait { .. }
        | EventKind::SubagentStatusChanged { .. } => true,
        EventKind::ToolCallStarted { .. } => !event.agent_path.is_empty(),
        _ => false,
    }
}

pub(super) fn observe(session: &Session, run: &str, root: &str, event: &Event) -> Option<SessionSubagents> {
    let at = i64::try_from(event.at_ms).unwrap_or(i64::MAX);
    let previous = session.subagents.as_ref();
    let mut summary = previous
        .filter(|s| s.run == run && s.root_thread_id == root)
        .cloned()
        .unwrap_or_else(|| SessionSubagents {
            run: run.to_owned(),
            root_thread_id: root.to_owned(),
            disconnected_at: None,
            threads: vec![],
            waits: vec![],
        });
    match &event.kind {
        EventKind::TurnStarted { .. } if event.agent_path.is_empty() => {}
        EventKind::TurnFinished { reason, .. } if event.agent_path.is_empty() => {
            if matches!(
                reason,
                vibevalley_runtime::oar::StopReason::Error | vibevalley_runtime::oar::StopReason::Aborted
            ) {
                summary.disconnected_at.get_or_insert(at);
            }
            summary.waits.clear();
        }
        EventKind::SessionEnded => {
            summary.disconnected_at.get_or_insert(at);
        }
        EventKind::SubagentPlanUpdated { thread_id, turn_id, steps } => {
            let target = thread(&mut summary, thread_id, at);
            target.turn_id = Some(turn_id.clone());
            let steps = steps
                .iter()
                .map(|s| SubagentStep {
                    step: bounded(&s.step),
                    status: match s.status {
                        vibevalley_runtime::oar::SubagentPlanStatus::Pending => SubagentStepStatus::Pending,
                        vibevalley_runtime::oar::SubagentPlanStatus::InProgress => SubagentStepStatus::InProgress,
                        vibevalley_runtime::oar::SubagentPlanStatus::Completed => SubagentStepStatus::Completed,
                    },
                })
                .collect::<Vec<_>>();
            if target.steps.as_ref() != Some(&steps) {
                target.steps = Some(steps);
                target.updated_at = at;
            }
        }
        EventKind::SubagentSpawned {
            parent_thread_id,
            thread_id,
            task,
            agent_name,
        } => {
            let thread = thread(&mut summary, thread_id, at);
            thread.parent_thread_id.get_or_insert_with(|| parent_thread_id.clone());
            if let Some(name) = agent_name.as_deref().filter(|s| !s.is_empty()) {
                thread.agent_name = Some(bounded(name));
            }
            if let Some(task) = task.as_deref().filter(|s| !s.is_empty()) {
                thread.task = Some(bounded(task));
            }
        }
        EventKind::SubagentWait {
            thread_id,
            call_id,
            targets,
            waiting,
        } => {
            summary.waits.retain(|w| w.thread_id != *thread_id || w.call_id != *call_id);
            if *waiting {
                if thread_id != root {
                    thread(&mut summary, thread_id, at);
                }
                for target in targets.iter().filter(|t| t.as_str() != root) {
                    thread(&mut summary, target, at);
                }
                summary.waits.push(SubagentWait {
                    thread_id: thread_id.clone(),
                    call_id: call_id.clone(),
                    targets: targets.clone(),
                });
            }
        }
        EventKind::SubagentMessage { thread_id, turn_id, text } => {
            let thread = thread(&mut summary, thread_id, at);
            if thread.turn_id.as_ref().is_some_and(|turn| turn != turn_id) {
                return None;
            }
            thread.turn_id = Some(turn_id.clone());
            let text = bounded(text);
            if thread.last_activity.as_ref() != Some(&text) || thread.last_action.is_some() {
                thread.last_activity = Some(text);
                thread.last_action = None;
                thread.updated_at = at;
            }
        }
        EventKind::SubagentStatusChanged {
            thread_id,
            turn_id,
            status,
            message,
        } => {
            let thread = thread(&mut summary, thread_id, at);
            if let Some(turn) = turn_id
                && thread.turn_id.as_ref() != Some(turn)
            {
                thread.turn_id = Some(turn.clone());
                thread.steps = None;
                thread.last_activity = None;
                thread.last_action = None;
                thread.updated_at = at;
            }
            let status = wire_status(*status);
            let message = message.as_deref().filter(|s| !s.is_empty()).map(bounded);
            if thread.status != Some(status) || message.as_ref().is_some_and(|m| thread.last_activity.as_ref() != Some(m)) {
                thread.updated_at = at;
                thread.status = Some(status);
                if message.is_some() {
                    thread.last_activity = message;
                    thread.last_action = None;
                }
            }
        }
        EventKind::ToolCallStarted { name, input, .. } => {
            let id = event.agent_path.last()?;
            let detail = tool_detail(input, session.cwd.as_deref().unwrap_or_default());
            let thread = thread(&mut summary, id, at);
            let action = super::journal::tool_action(name, input);
            thread.last_action = Some(action);
            thread.last_activity = if !detail.is_empty() {
                Some(bounded(&detail))
            } else if action == vibevalley_protocol::ToolAction::Other {
                Some(bounded(name))
            } else {
                None
            };
            thread.updated_at = at;
        }
        _ => return None,
    }
    let next = (!summary.threads.is_empty() || !summary.waits.is_empty()).then_some(summary);
    (next.as_ref() != previous).then_some(next).flatten()
}

fn thread<'a>(summary: &'a mut SessionSubagents, id: &str, at: i64) -> &'a mut SubagentThread {
    let index = summary.threads.iter().position(|t| t.thread_id == id).unwrap_or_else(|| {
        summary.threads.push(SubagentThread {
            thread_id: id.into(),
            agent_name: None,
            parent_thread_id: None,
            turn_id: None,
            steps: None,
            task: None,
            status: None,
            last_activity: None,
            last_action: None,
            updated_at: at,
        });
        summary.threads.len() - 1
    });
    &mut summary.threads[index]
}

fn wire_status(status: ObservedStatus) -> SubagentStatus {
    match status {
        ObservedStatus::PendingInit => SubagentStatus::PendingInit,
        ObservedStatus::Running => SubagentStatus::Running,
        ObservedStatus::Completed => SubagentStatus::Completed,
        ObservedStatus::Interrupted => SubagentStatus::Interrupted,
        ObservedStatus::Errored => SubagentStatus::Errored,
        ObservedStatus::Shutdown => SubagentStatus::Shutdown,
        ObservedStatus::NotFound => SubagentStatus::NotFound,
    }
}

pub(super) fn read_back(
    summary: &mut SessionSubagents,
    mut read: impl FnMut(&str, Option<&str>) -> vibevalley_runtime::oar::Result<vibevalley_runtime::oar::SubagentSnapshot>,
    confirmed_at: impl Fn() -> i64,
) -> bool {
    let mut changed = false;
    for thread in &mut summary.threads {
        let snapshot = match read(&thread.thread_id, thread.turn_id.as_deref()) {
            Ok(snapshot) => snapshot,
            Err(vibevalley_runtime::oar::AgentError::Unsupported { .. } | vibevalley_runtime::oar::AgentError::Io(_)) => break,
            Err(_) => continue,
        };
        let before = thread.clone();
        if let Some(parent) = snapshot.parent_thread_id {
            thread.parent_thread_id = Some(parent);
        }
        if let Some(name) = snapshot.agent_name {
            thread.agent_name = Some(bounded(&name));
        }
        if thread.turn_id.is_some()
            && let Some(status) = snapshot.status.map(wire_status)
            && (final_status(status) || !thread.status.is_some_and(final_status))
        {
            thread.status = Some(status);
            if let Some(message) = snapshot.message {
                thread.last_activity = Some(bounded(&message));
                thread.last_action = None;
            }
        }
        if *thread != before {
            thread.updated_at = confirmed_at();
            changed = true;
        }
    }
    changed
}

fn final_status(status: SubagentStatus) -> bool {
    !matches!(status, SubagentStatus::PendingInit | SubagentStatus::Running)
}

fn bounded(text: &str) -> String {
    text.chars().take(512).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_readback_binds_results_to_the_observed_child_turn_and_preserves_gaps() {
        let mut summary = SessionSubagents {
            run: "r1".into(),
            root_thread_id: "root".into(),
            disconnected_at: Some(15),
            threads: vec![],
            waits: vec![],
        };
        thread(&mut summary, "observed", 10).turn_id = Some("turn-a".into());
        thread(&mut summary, "unavailable", 11).status = Some(SubagentStatus::Running);
        thread(&mut summary, "no-turn", 12);
        let done = thread(&mut summary, "done", 13);
        done.turn_id = Some("finished".into());
        done.status = Some(SubagentStatus::Errored);
        assert!(read_back(
            &mut summary,
            |id, turn| {
                if id == "unavailable" {
                    return Err(vibevalley_runtime::oar::AgentError::Protocol("thread unavailable".into()));
                }
                let expected_turn = match id {
                    "observed" => Some("turn-a"),
                    "done" => Some("finished"),
                    _ => None,
                };
                assert_eq!(turn, expected_turn);
                Ok(vibevalley_runtime::oar::SubagentSnapshot {
                    parent_thread_id: Some("root".into()),
                    agent_name: Some(format!("/root/{id}")),
                    status: Some(if id == "done" { ObservedStatus::Running } else { ObservedStatus::Completed }),
                    message: Some("last public reply".into()),
                })
            },
            || 25
        ));
        assert_eq!(summary.disconnected_at, Some(15));
        assert_eq!(summary.threads[0].status, Some(SubagentStatus::Completed));
        assert_eq!(summary.threads[0].last_activity.as_deref(), Some("last public reply"));
        assert_eq!(summary.threads[1].updated_at, 11);
        assert_eq!(summary.threads[1].status, Some(SubagentStatus::Running));
        assert_eq!(summary.threads[2].agent_name.as_deref(), Some("/root/no-turn"));
        assert!(summary.threads[2].status.is_none());
        assert!(summary.threads[2].last_activity.is_none());
        assert_eq!(summary.threads[3].status, Some(SubagentStatus::Errored));
    }
}
