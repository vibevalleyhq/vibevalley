use super::*;
use crate::{Completion, FinishReason, Message, ModelClient, Role, Tool, ToolSpec, Usage};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::{collections::VecDeque, time::Duration};
use vibevalley_durable::{SubmissionStatus, TaskStatus};

struct Fixture {
    evidence: Mutex<String>,
    replies: Mutex<VecDeque<crate::Result<Completion>>>,
    requests: Mutex<Vec<ChatRequest>>,
    runs: Mutex<usize>,
}
impl Fixture {
    fn new(replies: Vec<crate::Result<Completion>>) -> Arc<Self> {
        Arc::new(Self {
            evidence: Mutex::new("actual diff".into()),
            replies: Mutex::new(replies.into()),
            requests: Default::default(),
            runs: Default::default(),
        })
    }
}
struct Model(Arc<Fixture>);
impl ModelClient for Model {
    fn complete(&self, r: &ChatRequest, on: &mut dyn FnMut(Delta)) -> crate::Result<Completion> {
        self.0.requests.lock().unwrap().push(r.clone());
        let reply = self.0.replies.lock().unwrap().pop_front().expect("unexpected model request")?;
        if let Some(t) = &reply.message.content {
            on(Delta::Text(t.clone()))
        }
        Ok(reply)
    }
}
struct Count(Arc<Fixture>);
impl Tool for Count {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "count".into(),
            description: "count".into(),
            parameters: json!({"type":"object"}),
        }
    }
    fn execute(&self, _: &Value) -> ToolOutput {
        *self.0.runs.lock().unwrap() += 1;
        ToolOutput::ok("counted")
    }
}
struct Env(Arc<Fixture>);
impl Environment for Env {
    fn brain(&self, _: &str, provider: &str) -> Result<Arc<Brain>> {
        let mut b = Brain::new(Arc::new(Model(self.0.clone())), provider, "system");
        b.tools.push(Box::new(Count(self.0.clone())));
        Ok(Arc::new(b))
    }
    fn review(&self, request: ReviewRequest<'_>) -> Result<Option<OutcomeReview>> {
        Ok(request.explicit().map(|review| OutcomeReview {
            deliverables: self.0.evidence.lock().unwrap().clone(),
            ..review
        }))
    }
}
fn reply(text: &str, calls: Vec<ToolCall>) -> crate::Result<Completion> {
    Ok(Completion {
        message: Message {
            role: Role::Assistant,
            content: Some(text.into()),
            reasoning: Some("internal-only reason".into()),
            tool_call_id: None,
            tool_calls: calls,
        },
        finish: FinishReason::Stop,
        usage: Usage {
            input: 500,
            output: 50,
            cache_read: 0,
        },
    })
}
fn call(args: Value) -> crate::Result<Completion> {
    reply(
        "",
        vec![ToolCall {
            id: "one".into(),
            name: "count".into(),
            arguments: args.to_string(),
        }],
    )
}
fn req() -> Request<'static> {
    Request {
        conversation: "one",
        provider: "deepseek-flash",
        request_id: "req",
        source: "user",
        prompt: "count twice",
        system: "system",
        ..Default::default()
    }
}
fn setup(store: Store, env: Arc<Fixture>) -> (Generation, Scheduler) {
    let s = Scheduler::new(store.clone(), 2);
    (Generation::new(store, Arc::new(Env(env))), s)
}
fn wait_until(store: &Store, id: &str, condition: impl Fn(&Task) -> bool) -> Task {
    let changes = store.subscribe_tasks().unwrap();
    loop {
        let t = store.read(|tx| tx.task(id)).unwrap();
        if condition(&t) {
            return t;
        }
        changes.recv_timeout(Duration::from_secs(4)).expect("phase transition");
    }
}

#[test]
fn duplicate_turn_after_restart_uses_original_task_and_one_result() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("server.db");
    let env = Fixture::new(vec![call(json!({})), reply("complete", vec![])]);
    let (engine, s) = setup(Store::open(&path).unwrap(), env.clone());
    engine.register(&s);
    s.recover().unwrap();
    let (sub, t, _) = engine.submit(req()).unwrap();
    let done = s.wait(&t.id, Duration::from_secs(5)).unwrap();
    assert_eq!(done.result["output"], "complete", "{:?}", done);
    assert_eq!(engine.store.read(|tx| tx.submission(&sub.id)).unwrap().status, SubmissionStatus::Done);
    s.close();
    drop(engine);
    drop(s);
    let (again, s) = setup(Store::open(&path).unwrap(), env.clone());
    again.register(&s);
    s.recover().unwrap();
    let (prior, same, duplicate) = again.submit(req()).unwrap();
    assert!(duplicate);
    assert_eq!(prior.id, sub.id);
    assert_eq!(same.id, t.id);
    assert_eq!(*env.runs.lock().unwrap(), 1);
    assert_eq!(env.requests.lock().unwrap().len(), 2);
    assert_eq!(
        again
            .store
            .read(|tx| tx.entries("one", 1))
            .unwrap()
            .iter()
            .filter(|e| e.kind == "pi.user")
            .count(),
        1
    );
}
#[test]
fn budget_preserves_inflight_tools_and_wakes_on_raise() {
    let env = Fixture::new(vec![call(json!({})), reply("done", vec![])]);
    let (engine, s) = setup(Store::memory().unwrap(), env.clone());
    engine.register(&s);
    let (_, t, _) = engine.submit(req()).unwrap();
    governance::set_budget(&engine.store, &s, "one", None, 1).unwrap();
    s.recover().unwrap();
    let sleeping = wait_until(&engine.store, &t.id, |t| t.status == TaskStatus::Sleeping);
    assert_eq!(sleeping.wait_signal_name, governance::BUDGET_SIGNAL);
    assert_eq!(*env.runs.lock().unwrap(), 1);
    governance::set_budget(&engine.store, &s, "one", Some(&t.id), 0).unwrap();
    assert_eq!(s.wait(&t.id, Duration::from_secs(5)).unwrap().result["output"], "done");
}
#[test]
fn approval_survives_restart_hard_denials_cannot_be_overridden() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("server.db");
    let env = Fixture::new(vec![call(json!({"path":"doc.txt"})), reply("done", vec![])]);
    let (mut engine, s) = setup(Store::open(&path).unwrap(), env.clone());
    engine.permissions.builtin_default = governance::Policy::AlwaysAsk;
    engine.register(&s);
    s.recover().unwrap();
    let (_, t, _) = engine.submit(req()).unwrap();
    wait_until(&engine.store, &t.id, |t| t.status == TaskStatus::Sleeping);
    s.close();
    drop(engine);
    drop(s);
    let (mut g, s) = setup(Store::open(&path).unwrap(), env.clone());
    g.permissions.builtin_default = governance::Policy::AlwaysAsk;
    g.register(&s);
    s.recover().unwrap();
    let decision = |id: &str| Decision {
        tool_call_id: id.into(),
        approved: true,
        reason: String::new(),
    };
    assert!(governance::resolve(&g.store, &s, "one", &t.id, decision("another")).is_err());
    governance::resolve(&g.store, &s, "one", &t.id, decision("one")).unwrap();
    assert_eq!(s.wait(&t.id, Duration::from_secs(5)).unwrap().result["output"], "done");
    assert_eq!(*env.runs.lock().unwrap(), 1);
    let env = Fixture::new(vec![call(json!({"query":"drop table"})), reply("blocked", vec![])]);
    let (mut g, s) = setup(Store::memory().unwrap(), env.clone());
    g.permissions.builtin_default = governance::Policy::Auto;
    g.register(&s);
    let (_, t, _) = g.submit(req()).unwrap();
    g.store
        .write(|tx| tx.append_entry("one", "pi.tool_result", &json!({"output":"drop table","ok":true,"toolCallId":"earlier"})))
        .unwrap();
    s.recover().unwrap();
    s.wait(&t.id, Duration::from_secs(5)).unwrap();
    assert_eq!(*env.runs.lock().unwrap(), 0);
    assert!(governance::resolve(&g.store, &s, "one", &t.id, decision("one")).is_err());
}
#[test]
fn rubric_only_sees_deliverables_and_revises() {
    let env = Fixture::new(vec![
        reply("draft", vec![]),
        reply(r#"{"satisfied":false,"summary":"miss","unmetItems":["test"]}"#, vec![]),
        reply("revised", vec![]),
        reply(r#"{"satisfied":true,"summary":"ok"}"#, vec![]),
    ]);
    let (g, s) = setup(Store::memory().unwrap(), env.clone());
    g.register(&s);
    s.recover().unwrap();
    let (_, t, _) = g
        .submit(Request {
            rubric: Some(Rubric {
                markdown: "test".into(),
                max_iterations: 2,
            }),
            ..req()
        })
        .unwrap();
    let result = s.wait(&t.id, Duration::from_secs(5)).unwrap().result;
    assert_eq!(result["iterations"], 2);
    assert_eq!(result["rubricVerdict"]["satisfied"], true);
    let seen = env.requests.lock().unwrap();
    assert!(seen[1].tools.is_empty());
    assert_eq!(seen[1].messages.len(), 2);
    assert!(seen[1].messages[1].content.as_ref().unwrap().contains("actual diff"));
    assert!(!json!(seen[1].messages).to_string().contains("internal-only"));
    assert!(json!(seen[2].messages).to_string().contains("Outcome grader rejected"));
}
#[test]
fn stale_soft_compaction_and_one_overflow_retry() {
    let env = Fixture::new(vec![Err(BrainError::ContextOverflow("too long".into())), reply("recovered", vec![])]);
    let (g, s) = setup(Store::memory().unwrap(), env.clone());
    g.register(&s);
    let (_, t, _) = g.submit(req()).unwrap();
    for n in 0..5 {
        transcript::system_delta(&g.store, "one", &format!("delta {n}"), &[]).unwrap();
    }
    let prior = Transcript::load(&g.store, "one").unwrap();
    assert_eq!(prior.provider_affinity, "deepseek-flash");
    g.compactor.compact("one", Level::Manual, Some(3)).unwrap();
    s.recover().unwrap();
    let done = s.wait(&t.id, Duration::from_secs(5)).unwrap();
    assert_eq!(done.result["output"], "recovered", "{done:?}");
    assert_eq!(env.requests.lock().unwrap().len(), 2);
}

#[test]
fn regression_budget_pauses_the_grader_and_resume_uses_the_original_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("db");
    let env = Fixture::new(vec![reply("candidate", vec![]), reply(r#"{"satisfied":true,"summary":"matches"}"#, vec![])]);
    let (g, s) = setup(Store::open(&file).unwrap(), env.clone());
    g.register(&s);
    let (_, task, _) = g
        .submit(Request {
            rubric: Some(Rubric {
                markdown: "verify the file".into(),
                max_iterations: 2,
            }),
            ..req()
        })
        .unwrap();
    governance::set_budget(&g.store, &s, "one", None, 1).unwrap();
    s.recover().unwrap();
    let paused = wait_until(&g.store, &task.id, |t| t.status == TaskStatus::Sleeping);
    assert_eq!(paused.wait_signal_name, governance::BUDGET_SIGNAL);
    assert_eq!(paused.phase_name, YIELD_CHECK);
    assert_eq!(env.requests.lock().unwrap().len(), 1);
    s.close();
    drop((g, s));
    *env.evidence.lock().unwrap() = "new, unreviewed content".into();
    let (g, s) = setup(Store::open(&file).unwrap(), env.clone());
    g.register(&s);
    s.recover().unwrap();
    governance::set_budget(&g.store, &s, "one", Some(&task.id), 0).unwrap();
    let done = s.wait(&task.id, Duration::from_secs(5)).unwrap();
    assert_eq!(done.result["rubricVerdict"]["satisfied"], true, "{done:?}");
    let reqs = env.requests.lock().unwrap();
    assert_eq!(reqs.len(), 2);
    assert!(reqs[1].tools.is_empty());
    let input: Value = serde_json::from_str(reqs[1].messages[1].content.as_deref().unwrap()).unwrap();
    assert_eq!(input["deliverables"], "actual diff");
    s.close();
}
