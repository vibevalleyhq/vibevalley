use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::model::{fold_stream, request_body};
use crate::price::{charge_usd, deepseek_price};
use crate::tool::{Bash, EditFile};
use crate::*;

/// Answers with the completions it was given, in order, and records the
/// requests it saw.
struct Scripted {
    answers: Mutex<VecDeque<Result<Completion>>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl Scripted {
    fn new(answers: Vec<Completion>) -> Arc<Scripted> {
        Arc::new(Scripted {
            answers: Mutex::new(answers.into_iter().map(Ok).collect()),
            seen: Mutex::new(vec![]),
        })
    }
}

impl ModelClient for Scripted {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
        self.seen.lock().unwrap().push(request.clone());
        let answer = self.answers.lock().unwrap().pop_front().expect("an answer left")?;
        if let Some(t) = &answer.message.content {
            on(Delta::Text(t.clone()));
        }
        Ok(answer)
    }
}

fn say(text: &str) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: Some(text.into()),
            reasoning: None,
            tool_calls: vec![],
            tool_call_id: None,
        },
        finish: FinishReason::Stop,
        usage: Usage {
            input: 100,
            output: 10,
            cache_read: 0,
        },
    }
}

fn call(id: &str, name: &str, args: Value) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: None,
            reasoning: Some("I should use a tool".into()),
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: args.to_string(),
            }],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage {
            input: 100,
            output: 5,
            cache_read: 50,
        },
    }
}

/// Counts its runs; replay-safe or not as told.
struct Counter {
    runs: Arc<Mutex<u32>>,
    safe: bool,
}

impl Tool for Counter {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "count".into(),
            description: "counts".into(),
            parameters: json!({"type": "object"}),
        }
    }
    fn replay_safe(&self) -> bool {
        self.safe
    }
    fn execute(&self, _: &Value) -> ToolOutput {
        *self.runs.lock().unwrap() += 1;
        ToolOutput::ok("counted")
    }
}

fn brain(client: Arc<Scripted>, tools: Vec<Box<dyn Tool>>) -> Brain {
    let mut b = Brain::new(client, "deepseek-flash", "You are a test.");
    b.tools = tools;
    b
}

#[test]
fn a_turn_with_a_tool_call_runs_the_tool_and_answers() {
    let dir = tempfile::tempdir().unwrap();
    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![call("c1", "count", json!({})), say("done")]);
    let mut conv = Conversation::open(
        dir.path().join("c.jsonl"),
        brain(
            client.clone(),
            vec![Box::new(Counter {
                runs: runs.clone(),
                safe: false,
            })],
        ),
    )
    .unwrap();
    let mut events = vec![];
    let outcome = conv.send("please count", &mut |e| events.push(e)).unwrap();
    assert_eq!(outcome, TurnOutcome::Completed);
    assert_eq!(*runs.lock().unwrap(), 1);
    // The second request carried the tool call (with its reasoning) and the result.
    let seen = client.seen.lock().unwrap();
    let second: Vec<Value> = seen[1].messages.iter().map(Message::to_wire).collect();
    assert_eq!(second[0]["role"], "system");
    assert_eq!(second[1]["content"], "please count");
    assert_eq!(second[2]["content"], Value::Null);
    assert_eq!(second[2]["reasoning_content"], "I should use a tool");
    assert_eq!(second[2]["tool_calls"][0]["function"]["name"], "count");
    assert_eq!(second[3]["role"], "tool");
    assert_eq!(second[3]["tool_call_id"], "c1");
    match events.last().unwrap() {
        BrainEvent::TurnFinished { usage, text, .. } => {
            assert_eq!(text, "done");
            assert_eq!(usage.input, 200);
            assert_eq!(usage.cache_read, 50);
        }
        e => panic!("{e:?}"),
    }
    assert!(events.iter().any(|e| matches!(e, BrainEvent::ToolStarted { name, .. } if name == "count")));
}

#[test]
fn the_transcript_survives_a_reopen_and_feeds_the_next_turn() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.jsonl");
    let client = Scripted::new(vec![say("first answer"), say("second answer")]);
    Conversation::open(&path, brain(client.clone(), vec![]))
        .unwrap()
        .send("one", &mut |_| {})
        .unwrap();
    let mut again = Conversation::open(&path, brain(client.clone(), vec![])).unwrap();
    again.send("two", &mut |_| {}).unwrap();
    let seen = client.seen.lock().unwrap();
    let texts: Vec<Option<String>> = seen[1].messages.iter().map(|m| m.content.clone()).collect();
    assert_eq!(
        texts,
        vec![
            Some("You are a test.".into()),
            Some("one".into()),
            Some("first answer".into()),
            Some("two".into())
        ]
    );
}

/// Writes the transcript a crash would leave: the turn started, the model
/// asked for a tool, the tool started, nothing more.
fn crashed_mid_tool(path: &std::path::Path) {
    let entries = [
        Entry::TurnStarted { input: "count it".into() },
        Entry::Message {
            message: call("c1", "count", json!({})).message,
            usage: None,
        },
        Entry::ToolStarted { id: "c1".into() },
    ];
    let text: String = entries.iter().map(|e| serde_json::to_string(e).unwrap() + "\n").collect();
    std::fs::write(path, text + "{\"entry\":\"message\",\"mess").unwrap();
}

#[test]
fn an_unfinished_turn_resumes_and_does_not_rerun_a_tool_that_changes_things() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.jsonl");
    crashed_mid_tool(&path);
    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![say("I checked; carrying on")]);
    let mut conv = Conversation::open(
        &path,
        brain(
            client.clone(),
            vec![Box::new(Counter {
                runs: runs.clone(),
                safe: false,
            })],
        ),
    )
    .unwrap();
    assert_eq!(conv.unfinished_turn().as_deref(), Some("count it"));
    assert!(matches!(conv.send("new input", &mut |_| {}), Err(BrainError::Busy)));
    let outcome = conv.resume(&mut |_| {}).unwrap().unwrap();
    assert_eq!(outcome, TurnOutcome::Completed);
    assert_eq!(*runs.lock().unwrap(), 0, "a tool that changes things is not replayed");
    let seen = client.seen.lock().unwrap();
    let last = seen[0].messages.last().unwrap();
    assert_eq!(last.role, Role::Tool);
    assert!(last.content.as_ref().unwrap().contains("interrupted"));
    assert!(conv.unfinished_turn().is_none());
    assert!(conv.resume(&mut |_| {}).is_none());
}

#[test]
fn a_read_only_tool_cut_off_mid_run_is_run_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.jsonl");
    crashed_mid_tool(&path);
    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![say("ok")]);
    let mut conv = Conversation::open(
        &path,
        brain(
            client,
            vec![Box::new(Counter {
                runs: runs.clone(),
                safe: true,
            })],
        ),
    )
    .unwrap();
    conv.resume(&mut |_| {}).unwrap().unwrap();
    assert_eq!(*runs.lock().unwrap(), 1);
}

#[test]
fn abort_stops_before_the_next_step() {
    let dir = tempfile::tempdir().unwrap();
    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![call("c1", "count", json!({})), say("never")]);
    let mut conv = Conversation::open(
        dir.path().join("c.jsonl"),
        brain(
            client.clone(),
            vec![Box::new(Counter {
                runs: runs.clone(),
                safe: false,
            })],
        ),
    )
    .unwrap();
    let abort = conv.abort_handle();
    let outcome = conv
        .send("go", &mut |e| {
            if matches!(e, BrainEvent::ToolFinished { .. }) {
                abort.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        })
        .unwrap();
    assert_eq!(outcome, TurnOutcome::Aborted);
    assert_eq!(client.seen.lock().unwrap().len(), 1);
    assert!(conv.unfinished_turn().is_none());
}

#[test]
fn a_big_prompt_is_compacted_and_the_current_turn_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.jsonl");
    let mut big = call("c1", "count", json!({}));
    big.usage.input = 150_000;
    let client = Scripted::new(vec![say("old answer"), big, say("SUMMARY TEXT"), say("finished")]);
    let runs = Arc::new(Mutex::new(0));
    let mut conv = Conversation::open(&path, brain(client.clone(), vec![Box::new(Counter { runs, safe: true })])).unwrap();
    conv.send("old question", &mut |_| {}).unwrap();
    let mut compacted = false;
    conv.send("new question", &mut |e| compacted |= e == BrainEvent::Compacted).unwrap();
    assert!(compacted);
    let seen = client.seen.lock().unwrap();
    // Request 3 was the summary request; request 4 continues from the summary.
    assert!(seen[2].messages.last().unwrap().content.as_ref().unwrap().starts_with("Summarize"));
    let after: Vec<String> = seen[3].messages.iter().filter_map(|m| m.content.clone()).collect();
    assert!(after[1].contains("SUMMARY TEXT"), "{after:?}");
    assert!(after.iter().any(|t| t == "new question"));
    assert!(!after.iter().any(|t| t == "old question"));
    // Reopened, the transcript reads the same way.
    drop(seen);
    let reopened = Conversation::open(&path, brain(Scripted::new(vec![]), vec![])).unwrap();
    assert!(reopened.entries().iter().any(|e| matches!(e, Entry::Compacted { .. })));
}

#[test]
fn a_deepseek_stream_folds_into_text_reasoning_tool_calls_and_usage() {
    let stream = [
        r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Let me "}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"look."}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"content":"Checking "}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\"pa"}}]}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"th\":\"a.txt\"}"}}]}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls","usage":{"prompt_tokens":1200,"completion_tokens":40,"prompt_cache_hit_tokens":1000}}]}"#,
        "data: [DONE]",
    ]
    .join("\n\n");
    let mut deltas = vec![];
    let c = fold_stream(Cursor::new(stream), &mut |d| deltas.push(d)).unwrap();
    assert_eq!(c.finish, FinishReason::ToolCalls);
    assert_eq!(c.message.reasoning.as_deref(), Some("Let me look."));
    assert_eq!(c.message.content.as_deref(), Some("Checking "));
    assert_eq!(
        c.message.tool_calls,
        vec![ToolCall {
            id: "call_late".into(),
            name: "read".into(),
            arguments: "{\"path\":\"a.txt\"}".into()
        }]
    );
    assert_eq!(
        c.usage,
        Usage {
            input: 1200,
            output: 40,
            cache_read: 1000
        }
    );
    assert_eq!(deltas.len(), 3);
    let err = fold_stream(Cursor::new(r#"data: {"error":{"message":"Insufficient Balance"}}"#), &mut |_| {});
    assert!(matches!(err, Err(BrainError::Model(m)) if m == "Insufficient Balance"));
}

#[test]
fn the_request_body_turns_thinking_on_only_with_an_effort() {
    let mut r = ChatRequest {
        model: "deepseek-flash".into(),
        messages: vec![Message::user("hi")],
        ..Default::default()
    };
    assert_eq!(request_body(&r)["thinking"]["type"], "disabled");
    assert!(request_body(&r).get("tools").is_none());
    r.effort = Some("high".into());
    let body = request_body(&r);
    assert_eq!(
        (body["thinking"]["type"].as_str(), body["reasoning_effort"].as_str()),
        (Some("enabled"), Some("high"))
    );
    assert_eq!(body["stream"], true);
}

#[test]
fn prices_follow_vibevalleys_table() {
    let p = deepseek_price("deepseek-flash").unwrap();
    let usd = charge_usd(
        p,
        Usage {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 500_000,
        },
    );
    assert!((usd - (0.5 * 0.14 + 0.28 + 0.5 * 0.028)).abs() < 1e-9);
    assert_eq!(deepseek_price("deepseek-official/deepseek-v4-pro"), deepseek_price("deepseek-v4-pro"));
    assert!(deepseek_price("gpt-x").is_none());
}

#[test]
fn edit_needs_exactly_one_match_and_bash_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace {
        bash_timeout: std::time::Duration::from_millis(300),
        ..Workspace::new(dir.path())
    };
    std::fs::write(dir.path().join("f.txt"), "a b a").unwrap();
    let edit = EditFile(ws.clone());
    assert!(edit.execute(&json!({"path": "f.txt", "old_text": "a", "new_text": "x"})).is_error);
    assert!(!edit.execute(&json!({"path": "f.txt", "old_text": "b", "new_text": "y"})).is_error);
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "a y a");
    let bash = Bash(ws);
    let ok = bash.execute(&json!({"command": "echo hi; echo err >&2"}));
    assert_eq!((ok.is_error, ok.text.as_str()), (false, "hi\nerr\n"));
    let slow = bash.execute(&json!({"command": "sleep 5"}));
    assert!(slow.is_error && slow.text.contains("timed out"), "{slow:?}");
    assert!(bash.execute(&json!({"command": "exit 3"})).text.contains("exit status 3"));
}

#[test]
#[ignore = "calls DeepSeek; needs DEEPSEEK_API_KEY"]
fn deepseek_live_tool_turn() {
    let Ok(key) = std::env::var("DEEPSEEK_API_KEY") else { return };
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("secret.txt"), "the answer is 42\n").unwrap();
    let client = Arc::new(OpenAiClient::deepseek(move || Some(key.clone())));
    let mut b = Brain::new(client, "deepseek-flash", "You are a careful assistant. Use tools to look at files.");
    b.tools = coding_tools(&Workspace::new(dir.path()));
    let mut conv = Conversation::open(dir.path().join("c.jsonl"), b).unwrap();
    let mut text = String::new();
    conv.send("What number is in secret.txt? Reply with the number only.", &mut |e| {
        if let BrainEvent::TurnFinished { text: t, usage, .. } = e {
            println!("usage {usage:?}");
            text = t;
        }
    })
    .unwrap();
    assert!(text.contains("42"), "{text}");
}

mod kit_tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use crate::Tool;
    use crate::kit::*;

    #[test]
    fn front_matter_and_skills_scan_first_name_wins() {
        let fm = front_matter("---\nname: deploy\ndescription: >\n  Ships the app\n  to prod\nquoted: \"x y\"\n---\nbody");
        assert_eq!(fm["name"], "deploy");
        assert_eq!(fm["description"], "Ships the app to prod");
        assert_eq!(fm["quoted"], "x y");
        assert_eq!(skill_body("---\nname: a\n---\n\nThe body.\n"), "The body.");

        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for (dir, folder, text) in [
            (a.path(), "deploy", "---\nname: deploy\ndescription: from a\n---\nA"),
            (b.path(), "deploy2", "---\nname: deploy\ndescription: from b\n---\nB"),
            (b.path(), "Lint", "---\ndescription: checks\n---\nL"),
        ] {
            std::fs::create_dir_all(dir.join(folder)).unwrap();
            std::fs::write(dir.join(folder).join("SKILL.md"), text).unwrap();
        }
        let skills = scan_skills(&[a.path().into(), b.path().into(), "/no/such".into()]);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["deploy", "Lint"]);
        assert_eq!(skills[0].description, "from a");
        assert_eq!(skill_index(&skills, 160), "- deploy：from a\n- Lint：checks");
        assert!(read_skill(&skills, "deploy").unwrap().ends_with("\n\nA"));
        assert!(read_skill(&skills, "nope").unwrap_err().contains("有：deploy、Lint"));
    }

    #[test]
    fn memory_remembers_dated_lines_and_rewrites() {
        let home = tempfile::tempdir().unwrap();
        let mem: Arc<dyn MemoryPort> = Arc::new(FileMemory { home: home.path().into() });
        assert_eq!(mem.prompt(), "");
        let remember = Remember(mem.clone());
        assert!(remember.execute(&json!({"note": "  "})).is_error);
        assert_eq!(remember.execute(&json!({"note": "用户喜欢\n简短回答"})).text, "记下了。");
        let prompt = mem.prompt();
        assert!(prompt.starts_with("- 20") && prompt.ends_with("用户喜欢 简短回答"), "{prompt}");
        assert_eq!(
            RewriteMemory(mem.clone()).execute(&json!({"content": "- a\n- b"})).text,
            "重写好了，现在 2 行。"
        );
        assert_eq!(mem.prompt(), "- a\n- b");
    }

    #[test]
    fn todo_graph_adds_all_or_none_and_settles() {
        let g = Arc::new(Mutex::new(vec![]));
        let tools = todo_tools(g.clone());
        let add = &tools[0];
        let bad = add.execute(&json!({"tasks": [
            {"id": "a", "brief": "x", "after": ["b"]}, {"id": "b", "brief": "y", "after": ["a"]}
        ]}));
        assert!(bad.is_error && bad.text.contains("成了一个圈"), "{}", bad.text);
        assert!(g.lock().unwrap().is_empty());
        let ok = add.execute(&json!({"tasks": [
            {"id": "read", "brief": "read the code"}, {"id": "fix", "brief": "fix it", "after": ["read"]}
        ]}));
        assert!(ok.text.starts_with("任务（2 件，1 件可以做）"), "{}", ok.text);
        assert!(ok.text.contains("[等着] fix fix it（等 read）"));
        let update = &tools[1];
        update.execute(&json!({"id": "read", "state": "done", "result": "it is in main.rs"}));
        let back = update.execute(&json!({"id": "read", "state": "failed"}));
        assert!(back.is_error && back.text.contains("做完了，不能改成没做成"), "{}", back.text);
        let done = update.execute(&json!({"id": "fix", "state": "done"}));
        assert!(done.text.ends_with("都做完了，这张图收起来了。"));
        assert!(g.lock().unwrap().is_empty());
        assert_eq!(tools[2].execute(&json!({})).text, "现在没有任务。");
        assert!(add.execute(&json!({"tasks": [{"id": "坏", "brief": "x"}]})).text.contains("不能当 id"));
    }
}

#[test]
fn spawn_agent_runs_a_helper_and_a_replay_does_not_run_it_twice() {
    use crate::kit::SpawnAgent;
    let dir = tempfile::tempdir().unwrap();
    let client = Scripted::new(vec![say("Found it in main.rs:12.")]);
    let tool = SpawnAgent {
        parent: "阿狐".into(),
        client: client.clone(),
        model: "deepseek-flash".into(),
        tools: Arc::new(Vec::new),
        dir: dir.path().into(),
    };
    let out = tool.execute(&json!({"brief": "find the clock code"}));
    assert_eq!((out.is_error, out.text.as_str()), (false, "Found it in main.rs:12."));
    let seen = client.seen.lock().unwrap();
    assert!(seen[0].messages[0].content.as_ref().unwrap().contains("「阿狐」派出去的帮手"));
    drop(seen);
    // The same call again (a replay after a crash) reads the finished helper.
    let again = tool.execute(&json!({"brief": "find the clock code"}));
    assert_eq!(again.text, "Found it in main.rs:12.");
    assert_eq!(client.seen.lock().unwrap().len(), 1);
    assert!(tool.execute(&json!({"brief": " "})).is_error);
}

#[test]
fn reopening_after_a_torn_write_keeps_new_entries_readable() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("assistant.jsonl");
    let client = Scripted::new(vec![say("first"), say("second")]);
    Conversation::open(&path, brain(client.clone(), vec![]))
        .unwrap()
        .send("one", &mut |_| {})
        .unwrap();
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"entry\":").unwrap();
    Conversation::open(&path, brain(client, vec![])).unwrap().send("two", &mut |_| {}).unwrap();
    let entries = read_entries(&path).unwrap();
    assert_eq!(entries.iter().filter(|e| matches!(e, Entry::TurnFinished { .. })).count(), 2);
}

#[test]
fn recovery_settles_a_committed_answer_without_a_second_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("assistant.jsonl");
    let answer = say("done");
    let entries = [
        Entry::TurnStarted { input: "finish".into() },
        Entry::Message {
            message: answer.message,
            usage: Some(answer.usage),
        },
    ];
    std::fs::write(&path, entries.iter().map(|e| serde_json::to_string(e).unwrap()).collect::<Vec<_>>().join("\n")).unwrap();
    let mut conv = Conversation::open(&path, brain(Scripted::new(vec![]), vec![])).unwrap();
    let mut events = vec![];
    assert_eq!(conv.resume(&mut |e| events.push(e)).unwrap().unwrap(), TurnOutcome::Completed);
    assert!(matches!(events.last(),Some(BrainEvent::TurnFinished { text,usage,.. }) if text=="done" && *usage==answer.usage));
    assert_eq!(read_entries(&path).unwrap().len(), 3);
}
