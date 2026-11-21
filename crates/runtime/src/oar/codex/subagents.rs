use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use super::str_of;
use crate::oar::{EventKind, SubagentPlanStep, SubagentStatus};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Call<'a> {
    #[serde(borrow)]
    id: &'a str,
    tool: &'a str,
    status: Option<&'a str>,
    sender_thread_id: Option<&'a str>,
    #[serde(default)]
    receiver_thread_ids: Vec<&'a str>,
    prompt: Option<String>,
    #[serde(default)]
    agents_states: BTreeMap<&'a str, Value>,
}

#[derive(Deserialize)]
struct Snapshot {
    status: SubagentStatus,
    message: Option<String>,
}

#[derive(Default)]
struct Thread {
    parent: Option<String>,
    task: Option<String>,
    agent_name: Option<String>,
    turn: Option<String>,
    retired: HashSet<String>,
    ended: bool,
    last_direct: u64,
    last_snapshot: u64,
    state: Option<(SubagentStatus, Option<String>)>,
}

#[derive(Default)]
struct SeenCall {
    prompt: Option<String>,
    started: Option<u64>,
    ended: bool,
}

#[derive(Default)]
pub(super) struct Subagents {
    threads: HashMap<String, Thread>,
    calls: HashMap<(String, String), SeenCall>,
    sequence: u64,
}

fn turn_status(status: &str) -> Option<SubagentStatus> {
    match status {
        "inProgress" => Some(SubagentStatus::Running),
        "completed" => Some(SubagentStatus::Completed),
        "failed" => Some(SubagentStatus::Errored),
        "interrupted" => Some(SubagentStatus::Interrupted),
        _ => None,
    }
}

pub(super) fn read_snapshot(reply: &Value, id: &str, turn_id: Option<&str>) -> crate::oar::Result<crate::oar::SubagentSnapshot> {
    let thread = &reply["thread"];
    if str_of(thread, "id") != Some(id) {
        return Err(crate::oar::AgentError::Protocol("thread/read did not return the requested thread".into()));
    }
    let spawn = thread.pointer("/source/subAgent/thread_spawn");
    let parent_thread_id = str_of(thread, "parentThreadId").or_else(|| spawn.and_then(|s| str_of(s, "parent_thread_id")));
    let agent_name = spawn.and_then(|s| str_of(s, "agent_path")).or_else(|| str_of(thread, "agentNickname"));
    let turn = turn_id.and_then(|turn_id| thread["turns"].as_array()?.iter().find(|turn| str_of(turn, "id") == Some(turn_id)));
    let status = turn.and_then(|t| turn_status(str_of(t, "status")?));
    let message = turn
        .and_then(|t| {
            t.pointer("/error/message").and_then(Value::as_str).or_else(|| {
                t["items"]
                    .as_array()?
                    .iter()
                    .rev()
                    .filter(|item| item["type"] == "agentMessage")
                    .find_map(|item| str_of(item, "text").filter(|text| !text.is_empty()))
            })
        })
        .map(str::to_owned);
    Ok(crate::oar::SubagentSnapshot {
        parent_thread_id: parent_thread_id.map(str::to_owned),
        agent_name: agent_name.map(str::to_owned),
        status,
        message,
    })
}

type Event = (Vec<String>, EventKind);

impl Subagents {
    pub(super) fn path(&self, root: &str, thread: &str) -> Vec<String> {
        let mut path = vec![];
        let mut child = thread;
        while child != root {
            path.push(child.to_owned());
            let Some(parent) = self.threads.get(child).and_then(|t| t.parent.as_deref()) else {
                break;
            };
            child = parent;
        }
        path.reverse();
        path
    }

    fn spawn(&mut self, root: &str, parent: &str, id: &str, task: Option<&str>, agent_name: Option<&str>, out: &mut Vec<Event>) {
        if id.is_empty() || parent.is_empty() || id == root || self.path(root, parent).iter().any(|ancestor| ancestor == id) {
            return;
        }
        let t = self.threads.entry(id.to_owned()).or_default();
        if t.parent.as_deref().is_some_and(|old| old != parent)
            || (t.parent.is_some() && (t.task.is_some() || task.is_none()) && (t.agent_name.is_some() || agent_name.is_none()))
        {
            return;
        }
        t.parent = Some(parent.to_owned());
        if t.task.is_none() {
            t.task = task.map(str::to_owned);
        }
        if t.agent_name.is_none() {
            t.agent_name = agent_name.map(str::to_owned);
        }
        let task = t.task.clone();
        let agent_name = t.agent_name.clone();
        out.push((
            self.path(root, id),
            EventKind::SubagentSpawned {
                parent_thread_id: parent.to_owned(),
                thread_id: id.to_owned(),
                task,
                agent_name,
            },
        ));
    }

    pub(super) fn observe(&mut self, root: &str, thread: &str, method: &str, p: &Value) -> Option<Vec<Event>> {
        self.sequence += 1;
        let mut out = vec![];
        if let Some(turn) = p.pointer("/turn/id").and_then(Value::as_str).or_else(|| str_of(p, "turnId")) {
            let t = self.threads.entry(thread.into()).or_default();
            if t.retired.contains(turn) {
                return None;
            }
            match (t.turn.as_deref(), method) {
                (Some(current), "turn/started") if current != turn => {
                    t.retired.insert(current.to_owned());
                    t.turn = Some(turn.into());
                    t.ended = false;
                }
                (Some(_), "turn/started") => return None,
                (Some(current), _) if current != turn => {
                    // Non-start items may precede their turn/started. The new turn is
                    // authoritative only when the runtime announces it.
                    return None;
                }
                (Some(_), "turn/completed") if t.ended => return None,
                (None, "turn/started" | "turn/completed") => t.turn = Some(turn.into()),
                _ => {}
            }
            if method == "turn/completed" {
                t.ended = true;
            }
            if thread != root {
                let status = match method {
                    "turn/started" => Some(SubagentStatus::Running),
                    "turn/completed" => p.pointer("/turn/status").and_then(Value::as_str).and_then(turn_status),
                    _ => None,
                };
                if method == "turn/plan/updated"
                    && !t.ended
                    && let Ok(steps) = Vec::<SubagentPlanStep>::deserialize(&p["plan"])
                {
                    out.push((
                        self.path(root, thread),
                        EventKind::SubagentPlanUpdated {
                            thread_id: thread.into(),
                            turn_id: turn.into(),
                            steps,
                        },
                    ));
                } else if let Some(status) = status {
                    let message = p.pointer("/turn/error/message").and_then(Value::as_str).map(str::to_owned);
                    t.last_direct = self.sequence;
                    t.state = Some((status, message.clone()));
                    out.push((
                        self.path(root, thread),
                        EventKind::SubagentStatusChanged {
                            thread_id: thread.into(),
                            turn_id: Some(turn.into()),
                            status,
                            message,
                        },
                    ));
                }
            }
        }
        if method == "thread/started"
            && let Some(parent) = str_of(p, "parentThreadId")
                .or_else(|| p.pointer("/thread/parentThreadId").and_then(Value::as_str))
                .or_else(|| p.pointer("/thread/source/subAgent/thread_spawn/parent_thread_id").and_then(Value::as_str))
                .or_else(|| p.pointer("/thread/source/subagent/parentThreadId").and_then(Value::as_str))
        {
            self.spawn(root, parent, thread, None, None, &mut out);
        }
        let item = &p["item"];
        if matches!(method, "item/started" | "item/completed")
            && item["type"] == "subAgentActivity"
            && item["kind"] == "started"
            && let Some(child) = str_of(item, "agentThreadId")
        {
            self.spawn(root, thread, child, None, str_of(item, "agentPath"), &mut out);
        }
        if matches!(method, "item/started" | "item/completed")
            && item["type"] == "collabAgentToolCall"
            && let Ok(call) = Call::deserialize(item)
        {
            self.collaboration(root, thread, call, method == "item/completed", &mut out);
        }
        Some(out)
    }

    fn collaboration(&mut self, root: &str, thread: &str, call: Call<'_>, completed: bool, out: &mut Vec<Event>) {
        let sender = call.sender_thread_id.unwrap_or(thread);
        let seen = self.calls.entry((sender.into(), call.id.into())).or_default();
        if seen.ended || (!completed && seen.started.is_some()) {
            return;
        }
        if completed {
            seen.ended = true;
        } else {
            seen.started = Some(self.sequence);
        }
        let start = seen.started;
        let prompt = if completed {
            call.prompt.or_else(|| seen.prompt.take())
        } else {
            seen.prompt.clone_from(&call.prompt);
            call.prompt
        };
        if call.tool == "spawnAgent" && !matches!(call.status, Some("failed" | "interrupted")) {
            for child in &call.receiver_thread_ids {
                self.spawn(root, sender, child, prompt.as_deref(), None, out);
            }
        }
        if call.tool == "wait" {
            out.push((
                self.path(root, sender),
                EventKind::SubagentWait {
                    thread_id: sender.into(),
                    call_id: call.id.into(),
                    targets: call.receiver_thread_ids.iter().map(|s| (*s).into()).collect(),
                    waiting: !completed,
                },
            ));
        }
        for (id, value) in call.agents_states {
            if id == root || id.is_empty() {
                continue;
            }
            let Ok(snapshot) = Snapshot::deserialize(&value) else { continue };
            let t = self.threads.entry(id.into()).or_default();
            // The snapshot identifies a thread, never its turn. A call that
            // predates newer direct evidence cannot speak for that new turn.
            let bound = start.unwrap_or(0);
            if t.last_direct > bound || t.last_snapshot > bound {
                continue;
            }
            let was_terminal = t
                .state
                .as_ref()
                .is_some_and(|(status, _)| !matches!(status, SubagentStatus::Running | SubagentStatus::PendingInit));
            let restarting = matches!(call.tool, "resumeAgent" | "followupTask" | "sendInput");
            if t.ended
                && !restarting
                && matches!(
                    snapshot.status,
                    SubagentStatus::Errored | SubagentStatus::Completed | SubagentStatus::Interrupted
                )
                && t.state.as_ref().is_some_and(|(status, _)| *status != snapshot.status)
            {
                continue;
            }
            if was_terminal && matches!(snapshot.status, SubagentStatus::Running | SubagentStatus::PendingInit) && !restarting {
                continue;
            }
            t.last_snapshot = bound;
            if t.state
                .as_ref()
                .is_some_and(|(status, message)| *status == snapshot.status && (snapshot.message.is_none() || *message == snapshot.message))
            {
                continue;
            }
            t.state = Some((snapshot.status, snapshot.message.clone()));
            out.push((
                self.path(root, id),
                EventKind::SubagentStatusChanged {
                    thread_id: id.into(),
                    turn_id: None,
                    status: snapshot.status,
                    message: snapshot.message,
                },
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::oar::codex::Projector;
    use crate::oar::{EventKind, SubagentPlanStatus, SubagentStatus, ToolAction, tool_action};
    use proptest::prelude::*;
    use serde_json::{Value, json};

    fn call(caller: &str, id: &str, name: &str, targets: &[&str], states: Value) -> Value {
        json!({"threadId":caller,"item":{"type":"collabAgentToolCall","id":id,"senderThreadId":caller,"tool":name,"receiverThreadIds":targets,"agentsStates":states,"prompt":"Find the change"}})
    }
    fn turn(id: &str, vendor_turn: &str, status: &str) -> Value {
        json!({"threadId":id,"turn":{"id":vendor_turn,"status":status}})
    }
    proptest! {
        #[test]
        fn regression_codex_wait_and_send_never_claim_another_agents_child(before in prop::collection::vec(any::<bool>(), 0..16), after in prop::collection::vec(any::<bool>(), 0..16)) {
            let mut p = Projector::new("root");
            let observe = |p: &mut Projector, flags: &[bool]| -> bool {
                flags.iter().enumerate().all(|(i, wait)| {
                    let tool = if *wait { "wait" } else { "sendMessage" };
                    let item = call("b", &format!("c{i}"), tool, &["c"], json!({}));
                    !p.notification("item/started", &item).iter().any(|(_, e)| matches!(e, EventKind::SubagentSpawned { .. }))
                })
            };
            prop_assert!(observe(&mut p, &before));
            prop_assert_eq!(p.path(&json!({"threadId":"c"})), ["c"]);
            let spawn = call("a", "spawn", "spawnAgent", &["c"], json!({}));
            let ev = p.notification("item/completed", &spawn);
            let parent = ev.iter().find_map(|(_, e)| match e {
                EventKind::SubagentSpawned { parent_thread_id, thread_id, task, .. } => Some((parent_thread_id.as_str(),thread_id.as_str(),task.as_deref())),
                _ => None,
            });
            prop_assert_eq!(parent, Some(("a","c",Some("Find the change"))));
            prop_assert!(observe(&mut p, &after));
            let grandparent = json!({"thread":{"id":"a","parentThreadId":"ancestor"}});
            p.notification("thread/started", &grandparent);
            prop_assert_eq!(p.path(&json!({"threadId":"c"})), ["ancestor", "a", "c"]);
        }
    }
    proptest! {
        #[test]
        fn regression_codex_duplicate_terminal_delivery_settles_once(copies in 1usize..12) {
            let mut p = Projector::new("root");
            p.notification("turn/started", &turn("child","work","inProgress"));
            let mut results = vec![];
            for _ in 0..copies {
                results.extend(p.notification("turn/completed",&turn("child","work","failed")));
            }
            let terminal = results.iter().filter(|(_,e)| matches!(e,EventKind::SubagentStatusChanged{status:SubagentStatus::Errored,..})).count();
            prop_assert_eq!(terminal, 1);
            prop_assert!(results.iter().all(|(path,_)| path == &["child"]));
        }
    }

    #[test]
    fn regression_codex_observes_snapshots_without_assigning_the_senders_turn() {
        let mut p = Projector::new("root");
        let started = call("root", "w", "wait", &["worker"], json!({"worker":{"status":"running"}}));
        let ev = p.notification("item/started", &started);
        assert!(ev.iter().any(|(path,e)| path.is_empty() && matches!(e, EventKind::SubagentWait { thread_id, call_id, targets, waiting:true } if thread_id=="root" && call_id=="w" && targets==&["worker"])));
        assert!(ev.iter().any(|(path, e)| path == &["worker"]
            && matches!(
                e,
                EventKind::SubagentStatusChanged {
                    turn_id: None,
                    status: SubagentStatus::Running,
                    ..
                }
            )));
        let mut finished = call(
            "root",
            "w",
            "wait",
            &["worker"],
            json!({"worker":{"status":"errored","message":"test failed"},"future":{"status":"new-vendor-status"}}),
        );
        finished["turnId"] = json!("parent-turn");
        let ev = p.notification("item/completed", &finished);
        assert!(ev.iter().any(|(_, e)| matches!(e, EventKind::SubagentWait { waiting: false, .. })));
        assert!(ev.iter().any(|(_,e)| matches!(e, EventKind::SubagentStatusChanged {thread_id, turn_id:None,status:SubagentStatus::Errored,message:Some(msg)} if thread_id=="worker" && msg=="test failed")));
        assert!(!ev.iter().any(|(_, e)| matches!(e, EventKind::SubagentSpawned { .. })));
    }
    #[test]
    fn regression_codex_stale_wait_snapshot_and_old_turn_cannot_overwrite_new_work() {
        let mut p = Projector::new("root");
        p.notification("turn/started", &turn("worker", "old", "inProgress"));
        p.notification("item/started", &call("root", "w", "wait", &["worker"], json!({})));
        p.notification("turn/completed", &turn("worker", "old", "completed"));
        let ev = p.notification("turn/started", &turn("worker", "new", "inProgress"));
        assert!(matches!(&ev[..], [(_, EventKind::SubagentStatusChanged{turn_id:Some(turn),status:SubagentStatus::Running,..})] if turn=="new"));
        let late = p.notification(
            "item/completed",
            &call("root", "w", "wait", &["worker"], json!({"worker":{"status":"completed"}})),
        );
        assert!(!late.iter().any(|(_, e)| matches!(e, EventKind::SubagentStatusChanged { .. })));
        assert!(p.notification("turn/completed", &turn("worker", "old", "failed")).is_empty());
        assert!(
            p.notification("item/agentMessage/delta", &json!({"threadId":"worker","turnId":"old","delta":"stale"}))
                .is_empty()
        );
        let plan = p.notification(
            "turn/plan/updated",
            &json!({"threadId":"worker","turnId":"new","plan":[{"step":"review changes","status":"inProgress"}]}),
        );
        assert!(
            matches!(&plan[..], [(path,EventKind::SubagentPlanUpdated{steps,..})] if path == &["worker"] && steps[0].status == SubagentPlanStatus::InProgress)
        );
    }

    #[test]
    fn regression_codex_tools_keep_original_name_and_domain_action() {
        let mut p = Projector::new("root");
        for (kind, raw, expected) in [
            ("commandExecution", "commandExecution", ToolAction::RunCommand),
            ("fileChange", "fileChange", ToolAction::EditFile),
            ("webSearch", "webSearch", ToolAction::Web),
            ("mcpToolCall", "mcp:fs/stat", ToolAction::Mcp),
            ("collabAgentToolCall", "collabAgentToolCall", ToolAction::Wait),
        ] {
            let tool = if kind == "collabAgentToolCall" { "wait" } else { "stat" };
            let ev = p.notification(
                "item/started",
                &json!({"threadId":"worker","item":{"id":kind,"type":kind,"tool":tool,"server":"fs"}}),
            );
            assert!(
                ev.iter()
                    .any(|(_, e)| matches!(e,EventKind::ToolCallStarted{name,input,..} if name==raw && tool_action(name,input)==expected))
            );
        }
    }
}
