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
    let mut helper = app.test_internals().agent.profile.store.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    helper.name = "小帮手".into();
    app.test_internals().agent.profile.store.save(helper).unwrap();
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
    let session = app.test_internals().board.sessions().who(&token).expect("the token names the helper");

    let hello = rpc(&door, &token, 1, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }));
    assert_eq!(hello["result"]["serverInfo"]["name"], "vibevalley");
    let tools = rpc(&door, &token, 2, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 28, "{names:?}");
    assert!(names.contains(&"issue_report"));
    assert!(names.contains(&"artifact_block_list"));
    assert!(names.contains(&"artifact_block_batch"));
    assert!(names.contains(&"artifact_outline_import"));
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
    let kept = std::fs::read_to_string(app.test_internals().board.sessions().report_path(&session)).unwrap();
    assert!(kept.contains("打了招呼 abc123") && kept.contains("测试用 cargo test"), "{kept}");

    let none = rpc(&door, &token, 9, "tools/call", json!({ "name": "no_such_tool", "arguments": {} }));
    assert_eq!(none["result"]["isError"], true);
    assert!(text_of(&none).contains("没有 no_such_tool 这个工具"));

    // Artifact S2 + S6 MCP tools: outline import, block snapshot, and block batch (including tempId nesting, move, and suggestion diversion).
    let imported_res = rpc(
        &door,
        &token,
        10,
        "tools/call",
        json!({
            "name": "artifact_outline_import",
            "arguments": {
                "markdown": "---\ntitle: Sprint Outline\n---\n- TODO Ship collab tools\n  id:: block-prop-1\n  - DONE Wire block batch",
                "announce": false
            }
        }),
    );
    assert_eq!(imported_res["result"]["isError"], false, "{imported_res}");
    let imported_art: Value = serde_json::from_str(&text_of(&imported_res)).unwrap();
    let outline_id = imported_art["id"].as_str().unwrap().to_string();
    assert_eq!(imported_art["title"], "Sprint Outline");
    assert_eq!(imported_art["artifactType"], "outline");
    assert_eq!(imported_art["body"], "blocks");

    let snap_res = rpc(
        &door,
        &token,
        11,
        "tools/call",
        json!({ "name": "artifact_block_list", "arguments": { "id": outline_id } }),
    );
    assert_eq!(snap_res["result"]["isError"], false, "{snap_res}");
    let snap: Value = serde_json::from_str(&text_of(&snap_res)).unwrap();
    let blocks = snap["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2, "{snap}");
    let first_block_id = blocks[0]["id"].as_str().unwrap().to_string();
    let first_block_rev = blocks[0]["rev"].as_i64().unwrap();

    // User adds a block directly; helper batch editing that user block must divert to a suggestion.
    let user_block = call(
        "artifact.block.create",
        json!({ "id": outline_id, "type": "paragraph", "text": "User authored note" }),
    )
    .data
    .unwrap();
    let user_block_id = user_block["blockId"].as_str().unwrap().to_string();
    let user_block_rev = user_block["rev"].as_i64().unwrap();

    let batch_res = rpc(
        &door,
        &token,
        12,
        "tools/call",
        json!({
            "name": "artifact_block_batch",
            "arguments": {
                "id": outline_id,
                "note": "expand outline",
                "ops": [
                    { "op": "create", "tempId": "sec", "type": "heading", "level": 2, "text": "Follow-ups" },
                    { "op": "create", "tempId": "child", "type": "bulleted", "parentId": "sec", "text": "Verify MCP tools" },
                    { "op": "update", "block": first_block_id, "baseRev": first_block_rev, "checked": true, "text": "Shipped collab tools" },
                    { "op": "move", "block": "child", "parentId": "", "afterBlock": "" },
                    { "op": "update", "block": user_block_id, "baseRev": user_block_rev, "text": "Suggested rewrite" }
                ]
            }
        }),
    );
    assert_eq!(batch_res["result"]["isError"], false, "{batch_res}");
    let batch: Value = serde_json::from_str(&text_of(&batch_res)).unwrap();
    let results = batch["results"].as_array().unwrap();
    assert_eq!(results.len(), 5, "{batch}");
    assert_eq!(results[0]["status"], "applied");
    assert_eq!(results[1]["status"], "applied");
    assert_eq!(results[2]["status"], "applied");
    assert_eq!(results[3]["status"], "applied");
    assert_eq!(results[4]["status"], "rejected");
    assert!(results[4]["suggestion"].as_str().is_some(), "{batch}");
    let moved_child_id = batch["createdIds"]["child"].as_str().unwrap().to_string();

    let after_snap_res = rpc(
        &door,
        &token,
        13,
        "tools/call",
        json!({ "name": "artifact_block_list", "arguments": { "id": outline_id } }),
    );
    let after_snap: Value = serde_json::from_str(&text_of(&after_snap_res)).unwrap();
    let after_blocks = after_snap["blocks"].as_array().unwrap();
    assert_eq!(after_blocks[0]["id"], moved_child_id, "child moved to top-level first");
    assert!(after_blocks[0].get("parentId").is_none());

    app.close_blocking();
}
