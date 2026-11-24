//! A helper reaches the farm through `/mcp`: the board hands it the door
//! and a token, the token names it, and its tools act as it.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::Caller;
use vibevalley_runtime::oar::scripted::ScriptedRuntime;
use vibevalley_runtime::oar::{Capabilities, Installation, McpServer, ModelInfo, Runtime, Session, SessionOptions};

/// The scripted runtime, keeping what each open was given.
struct Recording {
    inner: ScriptedRuntime,
    opened: flume::Sender<SessionOptions>,
}

impl Runtime for Recording {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    fn installation(&self) -> Installation {
        self.inner.installation()
    }
    fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<ModelInfo>> {
        self.inner.list_models()
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn Session>> {
        let _ = self.opened.send(opts.clone());
        self.inner.open(opts)
    }
}

fn rpc(url: &str, token: &str, id: i64, method: &str, params: Value) -> Value {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let res = client
        .post(url)
        .header("authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .expect("POST /mcp");
    res.json().expect("a JSON-RPC answer")
}

fn text_of(answer: &Value) -> String {
    answer["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
}

#[test]
fn a_helper_calls_its_tools_through_the_door_it_was_given() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let (opened_tx, opened_rx) = flume::unbounded();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(Recording {
        inner: ScriptedRuntime::demo(),
        opened: opened_tx,
    }));
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let door = format!("{}/mcp", listener.url());
    app.set_mcp_url(door.clone());
    std::fs::write(dir.path().join("AGENTS.md"), "所有仓库都用 2 个空格缩进。").unwrap();

    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);
    assert!(call("repo.create", json!({ "name": "farm" })).data.is_some());
    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    helper.name = "小帮手".into();
    vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
    let made = call("issue.create", json!({ "title": "say hi", "repo": "farm", "agent": "小帮手" }));
    let id = made.data.unwrap()["id"].as_str().unwrap().to_string();
    let sent = call("issue.status.update", json!({ "id": id, "status": "todo" }));
    assert!(sent.data.is_some(), "{}", sent.message);

    let opts = opened_rx.recv_timeout(Duration::from_secs(5)).expect("the helper was opened");
    let rules = opts.append_system_prompt.clone().unwrap_or_default();
    assert!(rules.contains("## 在 VibeValley 工作的规矩") && rules.contains("「farm」"), "{rules}");
    assert!(rules.contains("所有仓库都用 2 个空格缩进。"), "the house rules: {rules}");
    assert!(rules.contains("issue_report"), "{rules}");
    let token = opts
        .mcp_servers
        .iter()
        .find_map(|s| match s {
            McpServer::Http { name, url, headers } if name == "vibevalley" => {
                assert_eq!(url, &door);
                headers
                    .iter()
                    .find(|(k, _)| k == "authorization")
                    .map(|(_, v)| v.trim_start_matches("Bearer ").to_string())
            }
            _ => None,
        })
        .expect("the vibevalley door with a bearer token");
    let session = app.test_internals().board.session_engine().who(&token).expect("the token names the helper");

    let hello = rpc(&door, &token, 1, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }));
    assert_eq!(hello["result"]["serverInfo"]["name"], "vibevalley");
    let tools = rpc(&door, &token, 2, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 25, "{names:?}");
    assert!(names.contains(&"issue_report"));
    assert!(names.contains(&"artifact_file_list"));
    assert!(names.contains(&"artifact_file_write"));
    assert!(names.contains(&"artifact_suggestion_create"));
    assert!(!names.contains(&"pkm_search"));

    let stranger = rpc(&door, "not-a-token", 3, "tools/call", json!({ "name": "session_list", "arguments": {} }));
    assert_eq!(stranger["result"]["isError"], true);
    assert_eq!(text_of(&stranger), "没认出你是谁：这些工具只给执行会话用");

    let said = rpc(
        &door,
        &token,
        4,
        "tools/call",
        json!({ "name": "channel_message_send", "arguments": { "text": "收到，开工。" } }),
    );
    assert_eq!(said["result"]["isError"], false, "{said}");
    assert!(text_of(&said).starts_with("发出去了：#general:1"), "{said}");
    let unread = rpc(&door, &token, 41, "tools/call", json!({ "name": "channel_unread_list", "arguments": {} }));
    assert_eq!(text_of(&unread), "没有没读的消息。", "{unread}");

    let remembered = rpc(
        &door,
        &token,
        5,
        "tools/call",
        json!({ "name": "memory_create", "arguments": { "text": "farm 用 make test" } }),
    );
    assert!(text_of(&remembered).contains("仓库 farm"), "{remembered}");

    let issue_uri = format!("vv://issue/{id}");
    let page = rpc(
        &door,
        &token,
        6,
        "tools/call",
        json!({ "name": "resource_read", "arguments": { "uri": issue_uri } }),
    );
    let page: Value = serde_json::from_str(&text_of(&page)).unwrap_or_else(|_| panic!("{page}"));
    assert!(page["text"].as_str().unwrap().contains("say hi"));
    let other = rpc(
        &door,
        &token,
        7,
        "tools/call",
        json!({ "name": "resource_read", "arguments": { "uri": "vv://session/someone-else/trajectory" } }),
    );
    assert_eq!(other["result"]["isError"], true);

    let reported = rpc(
        &door,
        &token,
        8,
        "tools/call",
        json!({ "name": "issue_report", "arguments": { "summary": "打了招呼 abc123", "remember": [{ "text": "测试用 cargo test", "scope": "all" }] } }),
    );
    assert_eq!(text_of(&reported), "报告已记录；现在用简短正文说明结果。");
    let kept = std::fs::read_to_string(app.test_internals().board.session_engine().report_path(&session)).unwrap();
    assert!(kept.contains("打了招呼 abc123") && kept.contains("测试用 cargo test"), "{kept}");

    let none = rpc(&door, &token, 9, "tools/call", json!({ "name": "no_such_tool", "arguments": {} }));
    assert_eq!(none["result"]["isError"], true);
    assert!(text_of(&none).contains("没有 no_such_tool 这个工具"));

    // Artifact MCP tools: directory create, file list/get/write, and human-owned suggestion diversion.
    let created_res = rpc(
        &door,
        &token,
        10,
        "tools/call",
        json!({
            "name": "artifact_create",
            "arguments": {
                "title": "Sprint Outline",
                "artifactType": "outline",
                "files": [{ "path": "structure/notes.md", "content": "Initial agent notes" }],
                "announce": false
            }
        }),
    );
    assert_eq!(created_res["result"]["isError"], false, "{created_res}");
    let created_art: Value = serde_json::from_str(&text_of(&created_res)).unwrap();
    let outline_id = created_art["id"].as_str().unwrap().to_string();
    assert_eq!(created_art["title"], "Sprint Outline");
    assert_eq!(created_art["artifactType"], "outline");

    let list_res = rpc(
        &door,
        &token,
        11,
        "tools/call",
        json!({ "name": "artifact_file_list", "arguments": { "id": outline_id, "prefix": "structure/" } }),
    );
    assert_eq!(list_res["result"]["isError"], false, "{list_res}");
    let listed: Value = serde_json::from_str(&text_of(&list_res)).unwrap();
    let files = listed["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f["path"] == "structure/notes.md"), "{listed}");

    // Human edits `structure/notes.md` directly; subsequent helper write diverts to a review suggestion.
    let human_write = call(
        "artifact.file.write",
        json!({
            "id": outline_id,
            "files": [{ "path": "structure/notes.md", "content": "Human edited note" }],
            "summary": "user tweak"
        }),
    );
    assert_eq!(human_write.biz_code, 0, "{}", human_write.message);

    let agent_write_res = rpc(
        &door,
        &token,
        12,
        "tools/call",
        json!({
            "name": "artifact_file_write",
            "arguments": {
                "id": outline_id,
                "summary": "suggest improvement",
                "files": [
                    { "path": "structure/notes.md", "content": "Agent proposed rewrite" },
                    { "path": "structure/appendix.md", "content": "Brand new section" }
                ]
            }
        }),
    );
    assert_eq!(agent_write_res["result"]["isError"], false, "{agent_write_res}");
    let written: Value = serde_json::from_str(&text_of(&agent_write_res)).unwrap();
    assert_eq!(written["suggestions"].as_array().unwrap().len(), 1, "{written}");
    assert_eq!(written["suggestions"][0]["path"], "structure/notes.md");

    let notes_res = rpc(
        &door,
        &token,
        13,
        "tools/call",
        json!({ "name": "artifact_file_get", "arguments": { "id": outline_id, "path": "structure/notes.md" } }),
    );
    let notes_file: Value = serde_json::from_str(&text_of(&notes_res)).unwrap();
    assert_eq!(notes_file["content"], "Human edited note");

    let appendix_res = rpc(
        &door,
        &token,
        14,
        "tools/call",
        json!({ "name": "artifact_file_get", "arguments": { "id": outline_id, "path": "structure/appendix.md" } }),
    );
    let appendix_file: Value = serde_json::from_str(&text_of(&appendix_res)).unwrap();
    assert_eq!(appendix_file["content"], "Brand new section");

    app.close_blocking();
}
