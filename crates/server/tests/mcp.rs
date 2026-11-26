//! A helper reaches the farm through `/mcp`: the board hands it the door
//! and a token, the token names it, and its tools act as it.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use vibevalley_protocol::{Caller, MachineMcpRequest};
use vibevalley_runtime::oar::scripted::ScriptedRuntime;
use vibevalley_runtime::oar::{Capabilities, Installation, McpServer, ModelInfo, Runtime, Session, SessionOptions};

/// The scripted runtime, keeping what each open was given.
struct Recording {
    inner: ScriptedRuntime,
    opened: std::sync::mpsc::Sender<SessionOptions>,
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
    fn installation(&self) -> vibevalley_runtime::oar::BoxFuture<'_, Installation> {
        self.inner.installation()
    }
    fn list_models(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
        self.inner.list_models()
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn Session>>> {
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

fn rpc_no_auth(url: &str, id: i64, method: &str, params: Value) -> Value {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let res = client.post(url).json(&body).send().expect("POST /mcp");
    res.json().expect("a JSON-RPC answer")
}

fn text_of(answer: &Value) -> String {
    answer["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
}

fn vibevalley_token_from(opts: &SessionOptions, expected_door: &str) -> String {
    opts.mcp_servers
        .iter()
        .find_map(|s| match s {
            McpServer::Http { name, url, headers } if name == "vibevalley" => {
                assert_eq!(url, expected_door);
                headers
                    .iter()
                    .find(|(k, _)| k == "authorization")
                    .map(|(_, v)| v.trim_start_matches("Bearer ").to_string())
            }
            _ => None,
        })
        .expect("the vibevalley door with a bearer token")
}

fn upload_text_attachment(app: &vibevalley_server::App, name: &str, bytes: &[u8]) -> String {
    let uploaded = app.router().call_as(
        Caller::User,
        "attachment.create",
        json!({
            "name": name,
            "type": "text/plain",
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        }),
    );
    assert_eq!(uploaded.biz_code, 0, "{}", uploaded.message);
    uploaded.data.unwrap()["id"].as_str().unwrap().to_string()
}

#[test]
fn a_helper_calls_its_tools_through_the_door_it_was_given() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let (opened_tx, opened_rx) = std::sync::mpsc::channel();
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
    let att_bytes = b"design spec notes for coding agent";
    let att_id = upload_text_attachment(&app, "spec.txt", att_bytes);
    let expected_cas_path = dir.path().join("attachments").join(&att_id);
    assert_eq!(std::fs::read(&expected_cas_path).unwrap(), att_bytes);

    let made = call("issue.create", json!({ "title": "say hi", "repo": "farm", "agent": "小帮手" }));
    let id = made.data.unwrap()["id"].as_str().unwrap().to_string();
    let other_made = call(
        "issue.create",
        json!({
            "title": "inspect attached spec",
            "description": "Read the attached spec file before implementing.",
            "repo": "farm",
            "attachments": [att_id],
        }),
    );
    assert_eq!(other_made.biz_code, 0, "{}", other_made.message);
    let other_id = other_made.data.unwrap()["id"].as_str().unwrap().to_string();

    let sent = call("issue.status.update", json!({ "id": id, "status": "todo" }));
    assert!(sent.data.is_some(), "{}", sent.message);

    let opts = opened_rx.recv_timeout(Duration::from_secs(5)).expect("the helper was opened");
    let rules = opts.append_system_prompt.clone().unwrap_or_default();
    assert!(rules.contains("## 在 VibeValley 工作的规矩") && rules.contains("「farm」"), "{rules}");
    assert!(rules.contains("所有仓库都用 2 个空格缩进。"), "the house rules: {rules}");
    assert!(rules.contains("issue_report"), "{rules}");
    let token = vibevalley_token_from(&opts, &door);
    let session = app.test_internals().board.session_engine().who(&token).expect("the token names the helper");

    let hello = rpc(&door, &token, 1, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }));
    assert_eq!(hello["result"]["serverInfo"]["name"], "vibevalley");
    assert!(hello["result"]["capabilities"]["tools"].is_object(), "{hello}");
    assert!(hello["result"]["capabilities"]["resources"].is_object(), "{hello}");

    let tools = rpc(&door, &token, 2, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 27, "{names:?}");
    assert!(names.contains(&"issue_list"));
    assert!(names.contains(&"issue_get"));
    assert!(names.contains(&"issue_report"));
    assert!(names.contains(&"artifact_file_list"));
    assert!(names.contains(&"artifact_file_write"));
    assert!(names.contains(&"artifact_suggestion_create"));
    assert!(!names.contains(&"pkm_search"));

    let listed_issues = rpc(&door, &token, 21, "tools/call", json!({ "name": "issue_list", "arguments": {} }));
    assert_eq!(listed_issues["result"]["isError"], false, "{listed_issues}");
    let listed_text = text_of(&listed_issues);
    assert!(listed_text.contains("say hi"), "{listed_text}");
    assert!(
        listed_text.contains("inspect attached spec") && listed_text.contains("1 个附件"),
        "{listed_text}"
    );

    let fetched_issue = rpc(&door, &token, 22, "tools/call", json!({ "name": "issue_get", "arguments": { "id": other_id } }));
    assert_eq!(fetched_issue["result"]["isError"], false, "{fetched_issue}");
    let detail_text = text_of(&fetched_issue);
    assert!(detail_text.contains("spec.txt") && detail_text.contains("text/plain"), "{detail_text}");
    assert!(detail_text.contains(&expected_cas_path.display().to_string()), "{detail_text}");

    // Standard MCP Resources: resources/list, resources/templates/list, resources/read.
    let res_list = rpc(&door, &token, 23, "resources/list", json!({}));
    let resources = res_list["result"]["resources"].as_array().expect("resources array");
    assert!(resources.iter().any(|r| r["uri"] == "vv://issues"), "{res_list}");
    assert!(resources.iter().any(|r| r["uri"] == format!("vv://issue/{id}")), "{res_list}");
    assert!(resources.iter().any(|r| r["uri"] == format!("vv://issue/{other_id}")), "{res_list}");

    let tpl_list = rpc(&door, &token, 24, "resources/templates/list", json!({}));
    let templates = tpl_list["result"]["resourceTemplates"].as_array().expect("resourceTemplates array");
    assert!(templates.iter().any(|t| t["uriTemplate"] == "vv://issue/{id}"), "{tpl_list}");

    let read_all = rpc(&door, &token, 25, "resources/read", json!({ "uri": "vv://issues" }));
    let contents = read_all["result"]["contents"].as_array().expect("contents array");
    assert_eq!(contents[0]["uri"], "vv://issues");
    assert_eq!(contents[0]["mimeType"], "application/json");
    let open_issues: Value = serde_json::from_str(contents[0]["text"].as_str().unwrap()).unwrap();
    let other_entry = open_issues
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == other_id)
        .expect("other issue in vv://issues");
    assert_eq!(other_entry["attachments"][0]["name"], "spec.txt");
    assert_eq!(other_entry["attachments"][0]["path"], expected_cas_path.to_string_lossy().as_ref());

    // Helper can read any issue via standard resources/read (including another issue with attachments).
    let other_uri = format!("vv://issue/{other_id}");
    let read_other = rpc(&door, &token, 26, "resources/read", json!({ "uri": other_uri }));
    let other_contents = read_other["result"]["contents"].as_array().expect("other issue contents");
    assert_eq!(other_contents[0]["uri"], other_uri);
    let other_payload: Value = serde_json::from_str(other_contents[0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(other_payload["issue"]["title"], "inspect attached spec");
    assert_eq!(other_payload["issue"]["attachments"][0]["path"], expected_cas_path.to_string_lossy().as_ref());
    assert_eq!(other_payload["attachments"][0]["path"], expected_cas_path.to_string_lossy().as_ref());
    assert!(Path::new(other_payload["attachments"][0]["path"].as_str().unwrap()).is_file());

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

#[test]
fn loopback_unauthenticated_mcp_reads_issues_and_rejects_mutations_and_tunnels() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(ScriptedRuntime::demo()));
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

    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);
    assert!(call("repo.create", json!({ "name": "farm" })).data.is_some());
    let att_id = upload_text_attachment(&app, "mockup.txt", b"wireframe details");
    let expected_path = dir.path().join("attachments").join(&att_id);
    let created = call(
        "issue.create",
        json!({
            "title": "external agent reads me",
            "description": "Check attached mockup.",
            "repo": "farm",
            "attachments": [att_id],
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    // Unauthenticated loopback client can initialize, list tools/resources, and read issues.
    let init = rpc_no_auth(&door, 1, "initialize", json!({ "protocolVersion": "2025-06-18" }));
    assert!(init["result"]["capabilities"]["tools"].is_object(), "{init}");
    assert!(init["result"]["capabilities"]["resources"].is_object(), "{init}");

    let list_res = rpc_no_auth(&door, 2, "tools/call", json!({ "name": "issue_list", "arguments": {} }));
    assert_eq!(list_res["result"]["isError"], false, "{list_res}");
    assert!(text_of(&list_res).contains("external agent reads me") && text_of(&list_res).contains("1 个附件"));

    let get_res = rpc_no_auth(&door, 3, "tools/call", json!({ "name": "issue_get", "arguments": { "id": issue_id } }));
    assert_eq!(get_res["result"]["isError"], false, "{get_res}");
    assert!(text_of(&get_res).contains(&expected_path.display().to_string()), "{get_res}");

    let res_list = rpc_no_auth(&door, 4, "resources/list", json!({}));
    assert!(
        res_list["result"]["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["uri"] == format!("vv://issue/{issue_id}")),
        "{res_list}"
    );
    let tpl_list = rpc_no_auth(&door, 5, "resources/templates/list", json!({}));
    assert!(
        tpl_list["result"]["resourceTemplates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["uriTemplate"] == "vv://issue/{id}"),
        "{tpl_list}"
    );
    let read_issues = rpc_no_auth(&door, 6, "resources/read", json!({ "uri": "vv://issues" }));
    let issues_json: Value = serde_json::from_str(read_issues["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(issues_json[0]["attachments"][0]["path"], expected_path.to_string_lossy().as_ref());

    let read_one = rpc_no_auth(&door, 7, "resources/read", json!({ "uri": format!("vv://issue/{issue_id}") }));
    let one_json: Value = serde_json::from_str(read_one["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(one_json["issue"]["attachments"][0]["path"], expected_path.to_string_lossy().as_ref());

    // Unauthenticated loopback client cannot read non-issue resources or call mutating/session tools.
    let read_channel = rpc_no_auth(&door, 8, "resources/read", json!({ "uri": "vv://channel/general/messages" }));
    assert!(read_channel["error"].is_object(), "{read_channel}");
    let read_traj = rpc_no_auth(&door, 9, "resources/read", json!({ "uri": "vv://session/w1/trajectory" }));
    assert!(read_traj["error"].is_object(), "{read_traj}");

    for tool_name in ["channel_message_send", "memory_create", "issue_report", "session_list", "resource_read"] {
        let refused = rpc_no_auth(&door, 10, "tools/call", json!({ "name": tool_name, "arguments": {} }));
        assert_eq!(refused["result"]["isError"], true, "{tool_name}: {refused}");
        assert_eq!(text_of(&refused), "没认出你是谁：这些工具只给执行会话用", "{tool_name}: {refused}");
    }

    // Any invalid non-empty token is still rejected even for read-only issue calls.
    let bad_tool = rpc(&door, "not-a-token", 11, "tools/call", json!({ "name": "issue_list", "arguments": {} }));
    assert_eq!(bad_tool["result"]["isError"], true, "{bad_tool}");
    assert_eq!(text_of(&bad_tool), "没认出你是谁：这些工具只给执行会话用");

    let bad_res_list = rpc(&door, "not-a-token", 12, "resources/list", json!({}));
    assert_eq!(bad_res_list["error"]["code"], -32001, "{bad_res_list}");
    let bad_res_read = rpc(&door, "not-a-token", 13, "resources/read", json!({ "uri": "vv://issues" }));
    assert_eq!(bad_res_read["error"]["code"], -32001, "{bad_res_read}");

    // Remote WS MCP tunnel never allows empty/blank session tokens (401).
    let mcp_port = Some(app.test_internals().agent.mcp.clone() as vibevalley_server::context::SharedMcp);
    for blank_token in ["", "   "] {
        let resp = vibevalley_runtime::rt::block_on(vibevalley_server::context::dispatch_mcp_tunnel_async(
            mcp_port.clone(),
            MachineMcpRequest {
                request_id: "tunnel-empty".into(),
                session_id: "w1".into(),
                session_token: blank_token.into(),
                method: "POST".into(),
                path: "/mcp".into(),
                body: json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" }).to_string(),
            },
        ));
        assert_eq!(resp.status, 401, "blank token {blank_token:?} must return 401: {resp:?}");
    }

    drop(listener);
    app.close_blocking();
}

#[test]
fn workspace_coding_agent_receives_mcp_door_on_open_and_relaunch() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();

    let (opened_tx, opened_rx) = std::sync::mpsc::channel();
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

    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);
    assert!(call("repo.create", json!({ "name": "farm" })).data.is_some());
    let repo_cwd = dir.path().join("repos").join("farm");
    let att_id = upload_text_attachment(&app, "brief.txt", b"workspace attachment body");
    let expected_path = dir.path().join("attachments").join(&att_id);
    let created = call(
        "issue.create",
        json!({
            "title": "workspace issue reading",
            "repo": "farm",
            "attachments": [att_id],
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    // Open a direct workspace coding agent session and verify MCP injection.
    let opened = call(
        "session.openWorkspace",
        json!({
            "runtime": "scripted",
            "cwd": repo_cwd.to_string_lossy(),
            "repo": "farm",
            "title": "Workspace Coder",
        }),
    );
    assert_eq!(opened.biz_code, 0, "{}", opened.message);
    let ws_id = opened.data.unwrap()["id"].as_str().unwrap().to_string();

    let opts = opened_rx.recv_timeout(Duration::from_secs(5)).expect("workspace agent opened");
    let ws_token = vibevalley_token_from(&opts, &door);
    assert_eq!(app.test_internals().board.session_engine().who(&ws_token).as_deref(), Some(ws_id.as_str()));

    let list_res = rpc(&door, &ws_token, 1, "tools/call", json!({ "name": "issue_list", "arguments": {} }));
    assert_eq!(list_res["result"]["isError"], false, "{list_res}");
    assert!(text_of(&list_res).contains("workspace issue reading"));

    let get_res = rpc(
        &door,
        &ws_token,
        2,
        "tools/call",
        json!({ "name": "issue_get", "arguments": { "id": issue_id } }),
    );
    assert_eq!(get_res["result"]["isError"], false, "{get_res}");
    assert!(text_of(&get_res).contains(&expected_path.display().to_string()), "{get_res}");

    let res_read = rpc(&door, &ws_token, 3, "resources/read", json!({ "uri": "vv://issues" }));
    let issues: Value = serde_json::from_str(res_read["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(issues[0]["attachments"][0]["path"], expected_path.to_string_lossy().as_ref());

    drop(listener);
    app.close_blocking();

    // Reopen server and reconnect the persisted workspace session (triggers `launch_workspace_agent_async`).
    let (reopened_tx, reopened_rx) = std::sync::mpsc::channel();
    let mut registry2 = vibevalley_runtime::oar::Registry::new();
    registry2.register(Arc::new(Recording {
        inner: ScriptedRuntime::demo(),
        opened: reopened_tx,
    }));
    let app2 = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry2)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener2 = vibevalley_server::gateway::http::serve(app2.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let door2 = format!("{}/mcp", listener2.url());
    app2.set_mcp_url(door2.clone());

    let reconnected = app2.router().call_as(
        Caller::User,
        "session.openWorkspace",
        json!({
            "sessionId": ws_id,
            "runtime": "scripted",
            "cwd": repo_cwd.to_string_lossy(),
            "repo": "farm",
        }),
    );
    assert_eq!(reconnected.biz_code, 0, "{}", reconnected.message);

    let opts2 = reopened_rx.recv_timeout(Duration::from_secs(5)).expect("workspace agent relaunched");
    let ws_token2 = vibevalley_token_from(&opts2, &door2);
    let list_res2 = rpc(&door2, &ws_token2, 1, "tools/call", json!({ "name": "issue_list", "arguments": {} }));
    assert_eq!(list_res2["result"]["isError"], false, "{list_res2}");
    assert!(text_of(&list_res2).contains("workspace issue reading"));

    drop(listener2);
    app2.close_blocking();
}

#[test]
fn helper_toolsets_narrow_mcp_tools_and_serve_user_and_builtin_skills() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let (opened_tx, opened_rx) = std::sync::mpsc::channel();
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

    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);
    assert!(call("repo.create", json!({ "name": "farm" })).data.is_some());

    let created_skill = call(
        "skill.create",
        json!({ "id": "", "name": "deploy-check", "description": "Verify deploy readiness", "body": "Check migrations first." }),
    );
    assert_eq!(created_skill.biz_code, 0, "{}", created_skill.message);

    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    helper.name = "窄权限帮工".into();
    helper.toolsets = vec![vibevalley_protocol::Toolset::Issue];
    vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();

    let made = call("issue.create", json!({ "title": "narrow check", "repo": "farm", "agent": "窄权限帮工" }));
    let id = made.data.unwrap()["id"].as_str().unwrap().to_string();
    assert!(call("issue.status.update", json!({ "id": id, "status": "todo" })).data.is_some());

    let opts = opened_rx.recv_timeout(Duration::from_secs(5)).expect("helper opened");
    let token = vibevalley_token_from(&opts, &door);

    // Worktree must NOT receive a copied skills directory.
    assert!(!opts.cwd.join(".agents/skills/deploy-check").exists());

    // `tools/list` only exposes Issue toolset tools for this helper.
    let listed = rpc(&door, &token, 1, "tools/list", json!({}));
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"issue_list"), "{names:?}");
    assert!(!names.contains(&"memory_search"), "{names:?}");
    assert!(!names.contains(&"channel_say"), "{names:?}");

    // `tools/call` on a tool outside `toolsets` fails cleanly.
    let blocked = rpc(
        &door,
        &token,
        2,
        "tools/call",
        json!({ "name": "memory_search", "arguments": { "query": "test" } }),
    );
    assert_eq!(blocked["result"]["isError"], true, "{blocked}");
    assert!(text_of(&blocked).contains("memory"), "{blocked}");

    // SEP-2640 serves user skill from `$VIBEVALLEY_HOME/skills` and built-in skills on demand.
    let skills = rpc(&door, &token, 3, "skills/list", json!({}));
    let skill_uris: Vec<&str> = skills["result"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["uri"].as_str())
        .collect();
    assert!(skill_uris.contains(&"skill://local/deploy-check"), "{skill_uris:?}");
    assert!(skill_uris.contains(&"skill://built-in/reviewer"), "{skill_uris:?}");
    assert!(skill_uris.contains(&"skill://artifact/outline"), "{skill_uris:?}");

    let user_skill = rpc(&door, &token, 4, "skills/get", json!({ "uri": "skill://local/deploy-check" }));
    assert!(
        user_skill["result"]["content"].as_str().unwrap().contains("Check migrations first."),
        "{user_skill}"
    );

    drop(listener);
    app.close_blocking();
}
