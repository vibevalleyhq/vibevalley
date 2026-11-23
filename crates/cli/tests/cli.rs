//! End-to-end CLI tests against an in-process VibeValley HTTP server on an isolated home.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use serde_json::{Value, json};

struct TestServer {
    url: String,
    dir: tempfile::TempDir,
    started: Option<vibevalley_server::Started>,
    _listener: vibevalley_server::transport::http::Listener,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(started) = self.started.take() {
            started.close();
        }
    }
}

fn spawn_server() -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(vibevalley_server::testing::helper());
    let starters = [
        "fullstack",
        "architect",
        "backend",
        "tester",
        "frontend",
        "docs",
        "scout",
        "designer",
        "product",
        "slides",
        "collector",
        "pages",
        "reviewer",
    ];
    let work = dir.path().join("work");
    for subdir in ["repos", "worktrees"] {
        std::fs::create_dir_all(work.join(subdir)).unwrap();
    }
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        starters: starters.iter().map(|s| s.to_string()).collect(),
        work_root: work,
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        offline_media: true,
        ..vibevalley_server::ServerConfig::under(dir.path().join("home"))
    })
    .unwrap();
    let listener = vibevalley_server::transport::http::serve(started.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let url = listener.url();
    started.board.sessions().set_mcp_url(format!("{url}/mcp"));
    TestServer {
        url,
        dir,
        started: Some(started),
        _listener: listener,
    }
}

struct Ran {
    code: i32,
    out: String,
    raw_out: Vec<u8>,
    failure: Option<Value>,
}

impl Ran {
    fn tag(&self) -> &str {
        self.failure.as_ref().and_then(|f| f["error"]["tag"].as_str()).unwrap_or("")
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.out).unwrap_or_else(|e| panic!("invalid JSON stdout: {e}\nstdout: {}\nfailure: {:?}", self.out, self.failure))
    }
}

fn cli(home: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Ran {
    let output = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
        .args(args)
        .env("VIBEVALLEY_HOME", home)
        .env_remove("VIBEVALLEY_SERVER")
        .env_remove("DEEPSEEK_API_KEY")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ran {
        code: output.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
        raw_out: output.stdout,
        failure: stderr.lines().last().and_then(|l| serde_json::from_str(l).ok()),
    }
}

impl TestServer {
    fn home(&self) -> PathBuf {
        self.dir.path().join("cli")
    }

    fn run(&self, args: &[&str]) -> Ran {
        let mut all = vec!["--server", &self.url];
        all.extend_from_slice(args);
        cli(&self.home(), &all, &[])
    }
}

const COMMANDS: &[&str] = &[
    "agent create",
    "agent delete",
    "agent list",
    "agent update",
    "artifact create",
    "artifact delete",
    "artifact entry batch",
    "artifact entry get",
    "artifact entry list",
    "artifact entry set",
    "artifact list",
    "artifact read",
    "artifact show",
    "artifact update",
    "attachment get",
    "attachment upload",
    "channel create",
    "channel delete",
    "channel list",
    "channel message delete",
    "channel message list",
    "channel message search",
    "channel message send",
    "channel pin list",
    "channel pin set",
    "chat",
    "cron create",
    "cron delete",
    "cron edit",
    "cron list",
    "doctor",
    "issue comment",
    "issue create",
    "issue delete",
    "issue diff",
    "issue edit",
    "issue list",
    "issue review",
    "issue show",
    "issue status",
    "issue timeline",
    "issue watch",
    "library add",
    "library delete",
    "library list",
    "media input delete",
    "media input list",
    "media input upload",
    "media job cancel",
    "media job list",
    "media job show",
    "memory create",
    "memory delete",
    "memory list",
    "memory search",
    "orchestrator approval list",
    "orchestrator approval resolve",
    "orchestrator open",
    "orchestrator stop",
    "repo create",
    "repo list",
    "repo pr submit",
    "runtime list",
    "runtime refresh",
    "session events",
    "session list",
    "session show",
    "session stop",
    "setting get",
    "setting update",
    "setting validate",
    "state",
];

#[test]
fn every_command_has_help_and_examples() {
    let home = tempfile::tempdir().unwrap();
    for command in COMMANDS {
        let mut args: Vec<&str> = command.split(' ').collect();
        args.push("--help");
        let help = cli(home.path(), &args, &[]);
        assert_eq!((command, help.code, help.out.contains("Examples:")), (command, 0, true), "{}", help.out);
    }
}

#[test]
fn bare_invocation_and_group_invocations_show_help() {
    let home = tempfile::tempdir().unwrap();
    let bare = cli(home.path(), &[], &[]);
    assert_eq!((bare.code, bare.out.contains("Commands:")), (0, true), "{}", bare.out);
    let group = cli(home.path(), &["issue"], &[]);
    assert_eq!((group.code, group.out.contains("Commands:")), (0, true), "{}", group.out);
}

#[test]
fn orchestrator_commands_and_approvals_use_http() {
    let srv = spawn_server();
    let opened = srv.run(&["orchestrator", "open"]);
    assert_eq!(opened.code, 0, "{:?}", opened.failure);

    let listed = srv.run(&["orchestrator", "approval", "list", "--conversation", "orchestrator", "--json"]);
    assert_eq!((listed.code, listed.out.as_str()), (0, "[]"), "{:?}", listed.failure);

    let missing = srv.run(&["orchestrator", "approval", "resolve", "orchestrator", "missing", "call-1", "approve", "--json"]);
    assert_eq!((missing.code, missing.tag()), (4, "Missing"), "{:?}", missing.failure);

    let incomplete = srv.run(&["orchestrator", "approval", "resolve", "orchestrator", "missing", "approve"]);
    assert_eq!((incomplete.code, incomplete.tag()), (2, "MissingArgument"));

    let stopped = srv.run(&["orchestrator", "stop"]);
    assert_eq!(stopped.code, 0, "{:?}", stopped.failure);
}

#[test]
fn issue_crud_text_and_json_output_and_errors() {
    let srv = spawn_server();
    let made = srv.run(&["issue", "create", "试一下", "--criterion", "能打开"]);
    assert_eq!(made.out, "#1  backlog  试一下", "{:?}", made.failure);

    let shown = srv.run(&["issue", "show", "#1"]).out;
    assert!(shown.contains("能打开"));
    assert!(shown.lines().last().unwrap().starts_with("  vibevalley issue status 1 "), "{shown}");

    assert_eq!(srv.run(&["issue", "edit", "1", "--title", "改一下"]).out, "#1  backlog  改一下");

    let as_json = srv.run(&["issue", "show", "1", "--json"]).json();
    assert_eq!((as_json["number"].clone(), as_json["criteria"].clone()), (1.into(), json!(["能打开"])));

    for title in ["二", "三", "四"] {
        assert_eq!(srv.run(&["issue", "create", title]).code, 0);
    }
    let list = srv.run(&["issue", "list"]).out;
    let list_json = srv.run(&["issue", "list", "--json"]).out;
    assert_eq!(list.lines().count(), 4);
    assert!(list.len() * 3 < list_json.len());
    assert!(srv.run(&["issue", "list", "--limit", "2"]).out.lines().last().unwrap().contains("--limit 4"));
    assert_eq!(cli(&srv.home(), &["issue", "show", "1"], &[("VIBEVALLEY_SERVER", &srv.url)]).code, 0);

    // Structured failures and exit codes
    let missing_arg = srv.run(&["issue", "show"]);
    assert_eq!((missing_arg.code, missing_arg.out.as_str(), missing_arg.tag()), (2, "", "MissingArgument"));
    assert_eq!(srv.run(&["issue", "list", "--bogus", "1"]).tag(), "UnrecognizedOption");
    assert_eq!(srv.run(&["issue", "list", "--format", "json"]).tag(), "UnrecognizedOption");

    let missing = srv.run(&["issue", "show", "nope"]);
    assert_eq!((missing.code, missing.tag()), (4, "Missing"));
    assert_eq!(missing.failure.as_ref().unwrap()["error"]["next"][0]["run"], json!(["issue", "list"]));

    let refused = srv.run(&["issue", "status", "1", "done"]);
    assert_eq!((refused.code, refused.tag()), (3, "Refused"));
    let next = refused.failure.as_ref().unwrap()["error"]["next"].as_array().cloned().unwrap_or_default();
    let cancel = next
        .iter()
        .find(|n| n["run"] == json!(["issue", "status", "1", "canceled"]))
        .expect("a way to cancel");
    let run_args: Vec<&str> = cancel["run"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
    assert!(srv.run(&run_args).out.starts_with("#1  canceled"));

    let no_words = srv.run(&["issue", "comment", "1"]);
    assert_eq!((no_words.code, no_words.tag()), (2, "MissingArgument"));
    let nowhere = srv.run(&["channel", "message", "list", "nowhere"]);
    assert_eq!((nowhere.code, nowhere.tag()), (4, "Missing"));
    let gone = cli(&srv.home(), &["issue", "list", "--server", "http://127.0.0.1:9"], &[]);
    assert_eq!((gone.code, gone.tag()), (5, "Unreachable"));
    let wrong = cli(&srv.home(), &["issue", "nope"], &[]);
    assert_eq!((wrong.code, wrong.out.as_str(), wrong.tag()), (2, "", "UnknownSubcommand"));
}

#[test]
fn dry_run_ssot_previews_supported_ops_and_rejects_unsupported_ops() {
    let srv = spawn_server();
    srv.run(&["issue", "create", "先试跑"]);
    let cancel = srv.run(&["issue", "status", "1", "canceled", "--dry-run"]);
    assert_eq!(cancel.code, 0, "{:?}", cancel.failure);
    assert!(cancel.out.contains("#1"), "{}", cancel.out);
    assert!(srv.run(&["issue", "show", "1"]).out.lines().nth(1).unwrap().starts_with("backlog"));

    let create = srv.run(&["issue", "create", "不该建", "--dry-run"]);
    assert_eq!((create.code, create.tag()), (2, "NoDryRun"));

    let added = srv.run(&["cron", "create", "早上看看", "看看昨天的改动", "--daily", "09:00"]);
    let cron_id = added.out.split("  ").next().unwrap().to_string();
    let cron_preview = srv.run(&["cron", "delete", &cron_id, "--dry-run"]);
    assert_eq!(cron_preview.code, 0, "{:?}", cron_preview.failure);
    assert!(cron_preview.out.contains("早上看看"), "{}", cron_preview.out);
    assert!(srv.run(&["cron", "list"]).out.contains(&cron_id));

    let agent_preview = srv.run(&["agent", "delete", "docs", "--dry-run"]);
    assert_eq!(agent_preview.code, 0, "{:?}", agent_preview.failure);
    assert!(!agent_preview.out.is_empty());

    let chat_dry = srv.run(&["chat", "hello", "--dry-run"]);
    assert_eq!((chat_dry.code, chat_dry.tag()), (2, "NoDryRun"));
}

#[test]
fn state_snapshot_and_doctor_verify_sse_and_channel() {
    let srv = spawn_server();

    let state_text = srv.run(&["state"]);
    assert_eq!(state_text.code, 0, "{:?}", state_text.failure);
    assert!(state_text.out.contains("seq ") && state_text.out.contains("channels "), "{}", state_text.out);

    let state_json = srv.run(&["state", "--json"]).json();
    assert!(state_json["seq"].is_i64(), "{state_json}");
    assert!(state_json["board"]["issues"].is_array(), "{state_json}");
    assert!(state_json["sessions"]["sessions"].is_array(), "{state_json}");
    assert!(state_json["collab"].is_object(), "{state_json}");
    assert!(state_json["inbox"]["items"].is_array(), "{state_json}");
    assert!(state_json["ops"]["crons"].is_array(), "{state_json}");
    assert!(state_json["farm"]["view"].is_object(), "{state_json}");

    let board_json = srv.run(&["state", "--slice", "board", "--json"]).json();
    assert!(board_json["seq"].is_i64(), "{board_json}");
    assert!(board_json["issues"].is_array(), "{board_json}");

    let inbox_text = srv.run(&["state", "--slice", "inbox"]);
    assert_eq!(inbox_text.code, 0, "{:?}", inbox_text.failure);
    assert!(inbox_text.out.contains("inbox") && inbox_text.out.contains("items "), "{}", inbox_text.out);

    let watch_missing_slice = srv.run(&["state", "--watch"]);
    assert_eq!((watch_missing_slice.code, watch_missing_slice.tag()), (2, "MissingOption"));

    // Configure settings & runtime so all 5 doctor checks pass
    let bad_key = srv.run(&["setting", "validate", "--deepseek-key", "bad"]);
    assert_eq!((bad_key.code, bad_key.tag()), (3, "Refused"));
    assert_eq!(srv.run(&["setting", "validate", "--deepseek-key", "sk-valid12345"]).code, 0);
    assert_eq!(srv.run(&["setting", "update", "--locale", "en", "--deepseek-key", "sk-valid12345"]).code, 0);
    let st = srv.run(&["setting", "get", "--json"]).json();
    assert_eq!(st["locale"], "en");
    assert_eq!(st["deepseekApiKey"]["source"], "settings");

    assert_eq!(srv.run(&["runtime", "refresh", "pi"]).code, 0);
    let doc_text = srv.run(&["doctor"]);
    assert_eq!(doc_text.code, 0, "{:?}", doc_text.failure);
    assert!(doc_text.out.contains("home  ok"), "{}", doc_text.out);
    assert!(doc_text.out.contains("server  ok"), "{}", doc_text.out);
    assert!(doc_text.out.contains("state  ok  seq"), "{}", doc_text.out);
    assert!(doc_text.out.contains("model  ok  settings"), "{}", doc_text.out);

    let doc_json = srv.run(&["doctor", "--json"]).json();
    let checks = doc_json.as_array().unwrap();
    assert_eq!(checks.len(), 5, "{doc_json}");
    assert_eq!(checks[0]["check"], "home");
    assert!(checks[0]["channel"].is_string());
    assert_eq!(checks[2]["check"], "state");
    assert_eq!(checks[2]["ok"], true);
}

#[test]
fn content_domain_artifacts_entries_attachments_library_media_and_channel_flags() {
    let srv = spawn_server();

    // 1. Artifact create, update, entry set/get/list/batch, and dry-run delete
    let created = srv.run(&["artifact", "create", "System Map", "--type", "whiteboard", "--json"]).json();
    let art_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["artifactType"], "whiteboard");

    let renamed = srv.run(&["artifact", "update", &art_id, "--title", "System Map v2", "--json"]).json();
    assert_eq!(renamed["title"], "System Map v2");

    let set_meta = srv
        .run(&[
            "artifact",
            "entry",
            "set",
            &art_id,
            "board/meta",
            r#"{"title":"System Map v2","viewport":{"x":0,"y":0,"zoom":1}}"#,
            "--kind",
            "json",
            "--json",
        ])
        .json();
    assert_eq!(set_meta["applied"], true, "{set_meta}");

    let batch_file = srv.dir.path().join("writes.json");
    std::fs::write(
        &batch_file,
        serde_json::to_string(&json!([
            {
                "op": "set",
                "path": "elements/n1",
                "kind": "json",
                "value": r#"{"id":"n1","type":"shape","shape":"card","x":40,"y":60,"w":220,"h":100,"text":"API"}"#
            }
        ]))
        .unwrap(),
    )
    .unwrap();
    let batch_arg = format!("@{}", batch_file.display());
    let batched = srv
        .run(&["artifact", "entry", "batch", &art_id, &batch_arg, "--note", "seed node", "--json"])
        .json();
    assert_eq!(batched["applied"], true, "{batched}");

    let entry_list = srv
        .run(&["artifact", "entry", "list", &art_id, "--prefix", "elements/", "--values", "--json"])
        .json();
    let entries = entry_list["entries"].as_array().unwrap();
    assert!(!entries.is_empty() && entries.iter().all(|e| e["path"].as_str().unwrap().starts_with("elements/")));
    assert!(entries.iter().any(|e| e["path"] == "elements/n1"));
    let entry_get = srv.run(&["artifact", "entry", "get", &art_id, "elements/n1", "--json"]).json();
    assert_eq!(entry_get["path"], "elements/n1");
    assert!(entry_get["value"].as_str().unwrap().contains("API"));

    let listed_wb = srv.run(&["artifact", "list", "--type", "whiteboard", "--json"]).json();
    assert_eq!(listed_wb.as_array().unwrap().len(), 1);

    // 2. Attachment upload & download (both --out and raw stdout)
    let sample_file = srv.dir.path().join("hello.txt");
    std::fs::write(&sample_file, b"vibevalley-cli-payload").unwrap();
    let uploaded = srv
        .run(&["attachment", "upload", sample_file.to_str().unwrap(), "--name", "hello.txt", "--json"])
        .json();
    let att_id = uploaded["id"].as_str().unwrap().to_string();
    assert_eq!(uploaded["size"], 22);

    let out_file = srv.dir.path().join("downloaded.txt");
    let got_file = srv.run(&["attachment", "get", &att_id, "--out", out_file.to_str().unwrap(), "--json"]);
    assert_eq!(got_file.code, 0, "{:?}", got_file.failure);
    assert_eq!(std::fs::read(&out_file).unwrap(), b"vibevalley-cli-payload");

    let got_raw = srv.run(&["attachment", "get", &att_id]);
    assert_eq!(got_raw.code, 0, "{:?}", got_raw.failure);
    assert_eq!(got_raw.raw_out, b"vibevalley-cli-payload");

    // 3. Library add / list / delete --dry-run / delete
    let lib_added = srv.run(&["library", "add", "--attachment", &att_id, "--name", "hello.txt", "--json"]).json();
    assert_eq!(lib_added["attachment"]["id"], att_id);
    let lib_list = srv.run(&["library", "list", "--text", "hello", "--json"]).json();
    assert_eq!(lib_list.as_array().unwrap().len(), 1);
    let lib_dry = srv.run(&["library", "delete", &att_id, "--dry-run"]);
    assert_eq!(lib_dry.code, 0, "{:?}", lib_dry.failure);
    assert_eq!(srv.run(&["library", "delete", &att_id]).code, 0);

    // 4. Media job list & media input upload / list / delete --dry-run
    let jobs = srv.run(&["media", "job", "list", "--json"]).json();
    assert!(jobs.is_array());
    // Minimal 1x1 PNG header bytes so server validates PNG upload
    let png_bytes: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08,
        0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, b'I', b'D', b'A', b'T', 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03,
        0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB4, 0x00, 0x00, 0x00, 0x00, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82,
    ];
    let png_path = srv.dir.path().join("dot.png");
    std::fs::write(&png_path, png_bytes).unwrap();
    let media_in = srv.run(&["media", "input", "upload", png_path.to_str().unwrap(), "--json"]).json();
    let input_id = media_in["id"].as_str().unwrap().to_string();
    assert_eq!(media_in["phase"], "ready", "{media_in}");
    assert!(srv.run(&["media", "input", "list"]).out.contains(&input_id));
    let media_dry = srv.run(&["media", "input", "delete", &input_id, "--dry-run"]);
    assert_eq!(media_dry.code, 0, "{:?}", media_dry.failure);

    // 5. Channel create, message send with --view-context / --send-key / --attachment, pin, delete
    let ch_created = srv.run(&["channel", "create", "design-review", "--description", "Review notes", "--json"]);
    assert_eq!(ch_created.code, 0, "{:?}", ch_created.failure);
    let ch_id = ch_created.json().as_str().unwrap().to_string();

    let view_ctx = json!({
        "artifactId": art_id,
        "artifactType": "whiteboard",
        "title": "System Map v2",
        "selectedIds": ["n1"]
    })
    .to_string();
    let sent = srv.run(&[
        "channel",
        "message",
        "send",
        &ch_id,
        "Check",
        "node",
        "n1",
        "--send-key",
        "sk-1",
        "--attachment",
        &att_id,
        "--view-context",
        &view_ctx,
    ]);
    assert_eq!(sent.code, 0, "{:?}", sent.failure);

    let msgs = srv.run(&["channel", "message", "list", &ch_id, "--json"]).json();
    let msg = &msgs.as_array().unwrap()[0];
    let msg_id = msg["id"].as_str().unwrap().to_string();
    assert_eq!(msg["sendKey"], "sk-1");
    assert_eq!(msg["viewContext"]["artifactId"], art_id);
    assert_eq!(msg["attachments"][0]["id"], att_id);

    assert_eq!(srv.run(&["channel", "pin", "set", &msg_id]).code, 0);
    let pins = srv.run(&["channel", "pin", "list", &ch_id, "--json"]).json();
    assert_eq!(pins.as_array().unwrap().len(), 1);
    assert_eq!(srv.run(&["channel", "pin", "set", &msg_id, "--off"]).code, 0);
    assert_eq!(srv.run(&["channel", "message", "delete", &msg_id, "--dry-run"]).code, 0);
    assert_eq!(srv.run(&["channel", "delete", &ch_id, "--dry-run"]).code, 0);

    // Artifact dry-run delete + actual delete
    assert_eq!(srv.run(&["artifact", "delete", &art_id, "--dry-run"]).code, 0);
    assert_eq!(srv.run(&["artifact", "delete", &art_id]).code, 0);
}

#[test]
fn clean_surface_agent_update_cron_and_resources() {
    let srv = spawn_server();

    // Retired PKM subcommand and legacy flags are rejected cleanly
    assert_eq!(srv.run(&["pkm", "page", "list"]).tag(), "UnknownSubcommand");
    assert_eq!(srv.run(&["chat", "--orchestrator", "hi"]).tag(), "UnrecognizedOption");

    // Agent create default runtime + agent update
    let owl = srv.run(&["agent", "create", "owl", "--json"]).json();
    let owl_id = owl["id"].as_str().unwrap().to_string();
    assert_eq!(owl["runtime"], "vibevalley");
    let updated = srv
        .run(&["agent", "update", &owl_id, "--duty", "Night watch", "--enabled", "false", "--json"])
        .json();
    assert_eq!(updated["duty"], "Night watch");
    assert_eq!(updated["enabled"], false);

    // Cron --at validation + conflict check
    let once = srv
        .run(&["cron", "create", "once-check", "检查一次", "--at", "2099-11-05T09:00", "--json"])
        .json();
    assert_eq!(once["when"]["kind"], "once");
    assert_eq!(srv.run(&["cron", "create", "bad-check", "x", "--at", "bogus"]).tag(), "InvalidValue");
    assert_eq!(
        srv.run(&["cron", "create", "dup", "x", "--every", "5", "--daily", "09:00"]).tag(),
        "ConflictingOption"
    );

    // Repo, runtime, memory basics
    assert_eq!(srv.run(&["repo", "create", "clock"]).code, 0);
    assert!(srv.run(&["repo", "list"]).out.starts_with("clock"));
    assert!(srv.run(&["runtime", "list"]).out.contains("pi"));
    assert_eq!(srv.run(&["memory", "create", "docs", "用中文写"]).code, 0);
    assert!(srv.run(&["memory", "list", "docs"]).out.contains("用中文写"));
}

#[test]
fn issue_watch_and_worker_round_trip() {
    let srv = spawn_server();
    let profile = srv
        .run(&["agent", "create", "fox", "--runtime", "pi"])
        .out
        .split("  ")
        .next()
        .unwrap()
        .to_string();
    assert_eq!(srv.run(&["repo", "create", "clock"]).code, 0);
    let made = srv.run(&[
        "issue",
        "create",
        "打卡页先问清楚，给选项，提交",
        "--repo",
        "clock",
        "--agent",
        &profile,
        "--criterion",
        "clock-in works",
    ]);
    let n = made.out.trim_start_matches('#').split("  ").next().unwrap().to_string();
    assert_eq!(srv.run(&["issue", "status", &n, "todo"]).code, 0);
    let watched = srv.run(&["issue", "show", &n, "--watch", "--timeout", "30"]);
    assert_eq!(watched.code, 0, "{:?}", watched.failure);
    let asking = srv.run(&["issue", "show", &n]).out;
    assert!(asking.lines().nth(1).unwrap().starts_with("in_progress"), "{asking}");
    assert!(asking.contains("用 8797"), "{asking}");
    assert!(asking.contains(&format!("vibevalley issue comment {n} …")), "{asking}");

    assert_eq!(srv.run(&["issue", "comment", &n, "用 8797"]).code, 0);
    assert_eq!(srv.run(&["issue", "show", &n, "--watch", "--timeout", "30"]).code, 0);
    let handed_back = srv.run(&["issue", "show", &n]).out;
    assert!(handed_back.lines().nth(1).unwrap().starts_with("in_review"), "{handed_back}");
    assert!(srv.run(&["issue", "diff", &n]).out.contains("clock.ts"));

    let sessions = srv.run(&["session", "list", "--json"]).json();
    let sid = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["role"] == "worker")
        .and_then(|s| s["id"].as_str())
        .unwrap()
        .to_string();
    assert!(!srv.run(&["session", "events", &sid]).out.is_empty());
    assert!(!srv.run(&["session", "events", &sid, "--json"]).json()["events"].as_array().unwrap().is_empty());

    assert_eq!(srv.run(&["issue", "review", &n, "--pass"]).code, 0);
    assert!(srv.run(&["issue", "status", &n, "done"]).out.starts_with(&format!("#{n}  done")));

    let observed = srv.run(&["issue", "watch", &format!("#{n}"), "--json"]);
    assert_eq!(observed.code, 0, "{:?}", observed.failure);
    assert!(observed.out.lines().any(|l| l.contains("\"kind\":\"state\"")), "{}", observed.out);
}
