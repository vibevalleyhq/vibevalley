use super::*;

fn via_http(gate: &vibevalley_server::transport::http::Listener, op: &str, req: Value) -> Value {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = format!("{}/api/v1/{}", gate.url(), op.replace('.', "/"));
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let response = client.post(&url).json(&req).send().unwrap_or_else(|e| panic!("{op}: {e}"));
    let envelope: Value = response.json().unwrap();
    assert_eq!(envelope["bizCode"], 0, "{op}: {envelope}");
    envelope["data"].clone()
}

fn graded_issue(
    answers: Vec<Completion>,
    criteria: &[&str],
) -> (
    tempfile::TempDir,
    vibevalley_server::Started,
    vibevalley_server::transport::http::Listener,
    Arc<Scripted>,
    String,
) {
    let home = tempfile::tempdir().unwrap();
    let model = Arc::new(Scripted {
        answers: Mutex::new(answers.into()),
        seen: Default::default(),
    });
    let mut config = vibevalley_server::ServerConfig {
        model_client: Some(model.clone()),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..vibevalley_server::ServerConfig::under(home.path())
    };
    config.tool_permissions.overrides.insert(
        "vibevalley__issue_report".into(),
        vibevalley_runtime::agent::extensions::governance::Policy::AlwaysAllow,
    );
    let server = vibevalley_server::start(config).unwrap();
    let listener = vibevalley_server::transport::http::serve(server.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    server.test_internals().board.sessions().set_mcp_url(format!("{}/mcp", listener.url()));
    let user = |op: &str, req| via_http(&listener, op, req);
    user("repo.create", json!({"name":"r"}));
    user("artifact.create", json!({"title":"unrelated artifact private marker","kind":"markdown"}));
    let mut helper = server.test_internals().agents.profiles.install_template("reviewer").unwrap();
    helper.name = "Checked".into();
    helper.runtime = "vibevalley".into();
    server.test_internals().agents.profiles.save(helper).unwrap();
    let issue = user(
        "issue.create",
        json!({"title":"Deliver the requested file","description":"Local grading example","agent":"Checked","repo":"r","criteria":criteria}),
    );
    let id = issue["id"].as_str().unwrap().to_owned();
    user("issue.status.update", json!({"id":id,"status":"todo"}));
    (home, server, listener, model, id)
}

fn terminal_worker_run(listener: &vibevalley_server::transport::http::Listener, issue: &str) -> vibevalley_protocol::Run {
    until("worker round finished", || {
        let runs: Vec<vibevalley_protocol::Run> = serde_json::from_value(via_http(listener, "issue.run.list", json!({"id":issue}))).unwrap();
        runs.into_iter().find(|r| r.outcome.is_some())
    })
}

#[test]
fn regression_issue_criteria_grade_the_builtin_worker_with_only_its_own_delivery() {
    let mut first = say("First draft.");
    first.message.reasoning = Some("private worker reasoning marker".into());
    let verdict = |satisfied: bool| {
        say(&json!({"satisfied":satisfied,"summary":"check the file","unmetItems":if satisfied {vec![]}else{vec!["use the required content"]}}).to_string())
    };
    let (_home, s, listener, model, id) = graded_issue(
        vec![
            call("first-write", "bash", json!({"command":"printf 'draft-content' > graded.txt"})),
            first,
            verdict(false),
            call("second-write", "bash", json!({"command":"printf 'required-content' > graded.txt"})),
            say("Revised draft."),
            verdict(true),
        ],
        &["graded.txt contains required-content"],
    );
    let run = terminal_worker_run(&listener, &id);
    assert_eq!(run.outcome, Some(vibevalley_protocol::Outcome::Completed), "{run:?}");
    assert_eq!(run.summary, "Revised draft.");
    let requests = model.seen.lock().unwrap();
    assert_eq!(requests.len(), 6, "{:?}", requests.iter().map(|r| r.messages.last()).collect::<Vec<_>>());
    for (index, expected) in [(2, "draft-content"), (5, "required-content")] {
        let grade = &requests[index];
        assert!(grade.tools.is_empty());
        assert_eq!(grade.messages.len(), 2);
        let input: Value = serde_json::from_str(grade.messages[1].content.as_deref().unwrap()).unwrap();
        assert_eq!(input["rubricMarkdown"], "- graded.txt contains required-content");
        assert!(input["taskPrompt"].as_str().unwrap().contains("Deliver the requested file"));
        let evidence = input["deliverables"].as_str().unwrap();
        assert!(evidence.contains("graded.txt") && evidence.contains(expected), "{evidence}");
        assert!(!input.to_string().contains("unrelated artifact private marker"));
        assert!(!input.to_string().contains("private worker reasoning marker"));
    }
    assert!(json!(requests[3].messages).to_string().contains("use the required content"));
    drop(requests);
    let runs = vibevalley_runtime::rt::block_on(s.test_internals().board.runs_async(&id)).unwrap();
    assert_eq!(runs.len(), 1);
    let work = std::path::PathBuf::from(s.test_internals().board.session(&run.session).unwrap().cwd.unwrap());
    assert_eq!(std::fs::read_to_string(work.join("graded.txt")).unwrap(), "required-content");
    s.close();
}

#[test]
fn regression_failed_rubric_limit_identifies_what_the_user_must_review() {
    let mut replies = vec![];
    for _ in 0..3 {
        replies.push(say("claim completed"));
        replies.push(say(r#"{"satisfied":false,"summary":"Review required","unmetItems":["missing receipt"]}"#));
    }
    let (_home, s, listener, model, id) = graded_issue(replies, &["include receipt"]);
    let run = terminal_worker_run(&listener, &id);
    assert_eq!(model.seen.lock().unwrap().len(), 6);
    assert_eq!(run.outcome, Some(vibevalley_protocol::Outcome::Failed), "{run:?}");
    assert!(run.summary.contains("missing receipt"), "{run:?}");
    s.close();
}

#[test]
fn regression_worker_question_waits_for_user_before_grading() {
    let (_home, s, listener, model, id) = graded_issue(
        vec![
            call(
                "ask",
                "vibevalley__issue_report",
                json!({"status":"blocked","summary":"Need a decision","questions":["Which version?"]}),
            ),
            say("Waiting for the user."),
        ],
        &["provide the chosen version"],
    );
    let _run = terminal_worker_run(&listener, &id);
    let issue = s.test_internals().board.issue(&id).unwrap();
    assert_eq!(issue.questions[0].question, "Which version?");
    let requests = model.seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .messages
            .iter()
            .any(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some("ask"))
    );
    drop(requests);
    s.close();
}
