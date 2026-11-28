//! Full-stack dual-database E2E verification booting `vibevalley_server::start(...)`
//! on both SQLite (`ServerConfig::under`) and ephemeral local Homebrew PostgreSQL 14
//! (`database_url: Some(...)`) across every server domain plus `durable`, including
//! clean shutdown and reopen persistence verification.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::Query;
use axum::routing::{get, post};
use base64::Engine as _;
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_protocol::{Caller, PublishPlatform, PullRequestState, SliceKind};
use vibevalley_runtime::agent::durable::now_ms;
use vibevalley_server::channel::Noticing;
use vibevalley_server::connector::{Options as ConnectorOptions, Vendors};
use vibevalley_server::issue::pull::UpsertPullInput;

struct EphemeralPostgres {
    data_dir: PathBuf,
    pg_ctl: PathBuf,
    port: u16,
    _temp: tempfile::TempDir,
}

impl EphemeralPostgres {
    fn start() -> Option<Self> {
        let initdb = ["/opt/homebrew/bin/initdb", "/usr/local/bin/initdb"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())?;
        let pg_ctl = ["/opt/homebrew/bin/pg_ctl", "/usr/local/bin/pg_ctl"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())?;

        let temp = tempfile::tempdir().ok()?;
        let data_dir = temp.path().join("pgdata");
        let sock_dir = temp.path().join("sock");
        std::fs::create_dir_all(&sock_dir).ok()?;

        let port = vibevalley_runtime::rt::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
            listener.local_addr().ok().map(|a| a.port())
        })?;

        let init = std::process::Command::new(&initdb)
            .arg("-D")
            .arg(&data_dir)
            .args(["--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-sync"])
            .output()
            .ok()?;
        assert!(init.status.success(), "initdb failed: {}", String::from_utf8_lossy(&init.stderr));

        let conf = format!(
            "\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = '{}'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n",
            sock_dir.display()
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(data_dir.join("postgresql.conf"))
            .unwrap()
            .write_all(conf.as_bytes())
            .unwrap();

        let log = temp.path().join("postgres.log");
        let start = std::process::Command::new(&pg_ctl)
            .arg("-D")
            .arg(&data_dir)
            .arg("-l")
            .arg(&log)
            .args(["-w", "start"])
            .output()
            .ok()?;
        assert!(
            start.status.success(),
            "pg_ctl start failed: {}\nlog:\n{}",
            String::from_utf8_lossy(&start.stderr),
            std::fs::read_to_string(&log).unwrap_or_default()
        );

        Some(Self {
            data_dir,
            pg_ctl,
            port,
            _temp: temp,
        })
    }

    fn create_database(&self, db_name: &str) {
        let admin_url = format!("postgres://postgres@127.0.0.1:{}/postgres", self.port);
        let name = db_name.to_owned();
        vibevalley_runtime::rt::block_on(async move {
            let db = Database::connect(&admin_url).await.expect("connect postgres admin db");
            db.execute_unprepared(&format!("CREATE DATABASE \"{name}\""))
                .await
                .expect("create test database");
            db.close().await.expect("close admin db");
        });
    }

    fn db_url(&self, db_name: &str) -> String {
        format!("postgres://postgres@127.0.0.1:{}/{}", self.port, db_name)
    }
}

impl Drop for EphemeralPostgres {
    fn drop(&mut self) {
        let _ = std::process::Command::new(&self.pg_ctl)
            .arg("-D")
            .arg(&self.data_dir)
            .args(["-m", "immediate", "-w", "stop"])
            .output();
    }
}

struct MockWeixin {
    base_url: String,
    _guard: DropGuard,
}

impl MockWeixin {
    fn start() -> Self {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let ready = Arc::new(Notify::new());
        let ready_wait = ready.clone();

        let base_url = vibevalley_runtime::rt::block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let base = format!("http://{addr}");
            let base_for_status = base.clone();
            let updates_cancel = token.clone();

            let app = Router::new()
                .route(
                    "/ilink/bot/get_bot_qrcode",
                    post(|| async move {
                        axum::Json(json!({
                            "qrcode": "qr-dual-db",
                            "qrcode_img_content": "https://example.com/qr-dual-db"
                        }))
                    }),
                )
                .route(
                    "/ilink/bot/get_qrcode_status",
                    get(move |_q: Query<std::collections::HashMap<String, String>>| {
                        let base = base_for_status.clone();
                        async move {
                            axum::Json(json!({
                                "status": "confirmed",
                                "bot_token": "wx-dual-tok",
                                "ilink_bot_id": "wx-bot-dual",
                                "baseurl": base,
                                "ilink_user_id": "wx-user-dual"
                            }))
                        }
                    }),
                )
                .route(
                    "/ilink/bot/getupdates",
                    post(move || {
                        let c = updates_cancel.clone();
                        async move {
                            tokio::select! {
                                _ = c.cancelled() => {},
                                _ = tokio::time::sleep(Duration::from_millis(50)) => {},
                            }
                            axum::Json(json!({
                                "ret": 0,
                                "msgs": [],
                                "get_updates_buf": "wx-cur-1"
                            }))
                        }
                    }),
                );

            let shutdown = token.cancelled_owned();
            vibevalley_runtime::rt::spawn(async move {
                ready_wait.notify_one();
                let _ = axum::serve(listener, app).with_graceful_shutdown(shutdown).await;
            });
            ready.notified().await;
            base
        });

        Self {
            base_url,
            _guard: cancel.drop_guard(),
        }
    }
}

fn start_server(home: &Path, database_url: Option<String>, weixin_url: &str) -> vibevalley_server::App {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let vendors = Vendors {
        weixin: weixin_url.to_string(),
        ..Vendors::default()
    };

    vibevalley_server::app::create_app_with_overrides_blocking(
        vibevalley_server::Config {
            version: "0.1.0-dual-db-test".into(),
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            orchestrator_listens: false,
            link_previews: false,
            tick_crons: false,
            debug_enabled: false,
            database_url,
            ..vibevalley_server::Config::under(home)
        },
        vibevalley_server::app::Overrides {
            connector: Some(ConnectorOptions {
                vendors,
                moment: Duration::from_secs(2),
                ..ConnectorOptions::default()
            }),
            ..Default::default()
        },
    )
    .unwrap()
}

fn ok(started: &vibevalley_server::App, op: &str, payload: Value) -> Value {
    let env = vibevalley_runtime::rt::block_on(started.router().call_as_async(Caller::User, op, payload));
    assert_eq!(env.biz_code, 0, "{op} failed (biz={}): {}", env.biz_code, env.message);
    env.data.unwrap_or(Value::Null)
}

fn run_full_stack_e2e(home: &Path, database_url: Option<String>) {
    let wx = MockWeixin::start();
    let ws_dir = home.join("workspace");
    std::fs::create_dir_all(&ws_dir).unwrap();

    let started = start_server(home, database_url.clone(), &wx.base_url);

    // Install a scripted agent profile for memory / session exercises.
    let mut reviewer = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    reviewer.runtime = "scripted".into();
    let reviewer = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(reviewer)).unwrap();

    // 1. work/issue
    let created_issue = ok(
        &started,
        "issue.create",
        json!({ "title": "Dual DB Issue", "description": "Persist across backends" }),
    );
    let issue_id = created_issue["id"].as_str().unwrap().to_string();
    ok(&started, "issue.update", json!({ "id": issue_id, "priority": "high" }));

    // 2. work/session
    let ws_session = ok(
        &started,
        "session.openWorkspace",
        json!({
            "runtime": "scripted",
            "cwd": ws_dir,
            "title": "Dual Workspace",
        }),
    );
    let session_id = ws_session["id"].as_str().unwrap().to_string();
    let session_got = ok(&started, "session.get", json!({ "id": session_id }));
    assert_eq!(session_got["id"], session_id);
    assert_eq!(session_got["runtime"], "scripted");
    ok(&started, "session.send", json!({ "id": session_id, "text": "hello dual db session" }));

    // 3. work/cron
    let cron_created = ok(
        &started,
        "cron.create",
        json!({ "name": "daily-check", "text": "check dual db", "when": { "kind": "once", "at": 4_102_444_800_000_i64 } }),
    );
    let cron_id = cron_created["id"].as_str().unwrap().to_string();
    ok(&started, "cron.update", json!({ "id": cron_id, "enabled": false }));

    // 4. work/pull
    let pull_rec = vibevalley_runtime::rt::block_on(started.test_internals().pull.upsert_async(UpsertPullInput {
        platform: PublishPlatform::Github,
        repo: "acme/dual".into(),
        number: 88,
        url: "https://github.com/acme/dual/pull/88".into(),
        branch: "feat/dual-db".into(),
        base: "main".into(),
        state: PullRequestState::Open,
        issue_id: Some(issue_id.clone()),
        at: now_ms(),
    }))
    .unwrap();
    vibevalley_runtime::rt::block_on(
        started
            .test_internals()
            .pull
            .keep_event_async(&pull_rec.id, "ev-dual-1", Some("round-1"), Some(1)),
    )
    .unwrap();

    // 5. collab/channel + system_code suppression
    let eng_channel = ok(&started, "channel.create", json!({ "name": "dual-eng", "description": "Dual DB channel" }));
    let eng_id = eng_channel.as_str().unwrap().to_string();

    vibevalley_runtime::rt::block_on(started.test_internals().channel.notice_async(Noticing {
        channel: eng_id.clone(),
        text: "Welcome to dual-eng".into(),
        code: "dual_welcome".into(),
        send_key: "dual-welcome-1".into(),
        until_user_speaks: true,
    }));
    vibevalley_runtime::rt::block_on(started.test_internals().channel.notice_async(Noticing {
        channel: eng_id.clone(),
        text: "Welcome to dual-eng".into(),
        code: "dual_welcome".into(),
        send_key: "dual-welcome-2".into(),
        until_user_speaks: true,
    }));
    let notices = ok(&started, "channel.message.list", json!({ "id": eng_id }));
    let welcome_count = notices.as_array().unwrap().iter().filter(|m| m["text"] == "Welcome to dual-eng").count();
    assert_eq!(welcome_count, 1, "repeat system_code notice must be suppressed before user speaks");

    // 6. content/attachment
    let png_bytes = b"\x89PNG\r\n\x1a\ndual-db-png";
    let att = ok(
        &started,
        "attachment.create",
        json!({
            "name": "dual.png",
            "type": "image/png",
            "data": base64::engine::general_purpose::STANDARD.encode(png_bytes),
        }),
    );
    let att_id = att["id"].as_str().unwrap().to_string();

    ok(
        &started,
        "channel.message.send",
        json!({ "id": eng_id, "text": "hello from dual db", "attachments": [att_id], "sendKey": "dual-msg-1" }),
    );
    let msg_list = ok(&started, "channel.message.list", json!({ "id": eng_id }));
    let msg_id = msg_list.as_array().unwrap().iter().find(|m| m["text"] == "hello from dual db").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    ok(&started, "channel.pin.set", json!({ "id": msg_id, "on": true }));

    // 7. collab/connector (Weixin mock login + channel binding)
    let wx_login = ok(&started, "connector.login", json!({ "id": "weixin" }));
    assert!(
        matches!(wx_login["state"].as_str(), Some("waiting" | "connected")),
        "unexpected weixin login state: {wx_login}"
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        vibevalley_runtime::rt::block_on(started.ctx().feed.flush());
        let collab: vibevalley_protocol::CollabSlice = serde_json::from_str(&started.ctx().feed.snapshot_json(SliceKind::Collab)).unwrap();
        if collab.connectors.iter().any(|c| c.id.as_str() == "weixin" && c.state.as_str() == "connected") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "connector weixin did not reach connected: {:?}",
            collab.connectors
        );
        vibevalley_runtime::rt::block_on(async { tokio::time::sleep(Duration::from_millis(25)).await });
    }
    ok(&started, "connector.channel.set", json!({ "id": "weixin", "channel": "#dual-eng" }));

    // 8. content/library
    let lib_item = ok(&started, "library.item.add", json!({ "attachment": att_id }));
    assert_eq!(lib_item["attachment"]["id"], att_id);

    // 9. content/media
    let media_bytes = b"\x89PNG\r\n\x1a\nmedia-input";
    let media_created = ok(
        &started,
        "media.input.create",
        json!({ "kind": "image", "mime": "image/png", "name": "in.png", "size": media_bytes.len() }),
    );
    let media_id = media_created["id"].as_str().unwrap().to_string();
    vibevalley_runtime::rt::block_on(
        started
            .test_internals()
            .storage
            .media_input
            .upload_async(&media_id, Box::new(std::io::Cursor::new(media_bytes.to_vec()))),
    )
    .unwrap();
    let media_listed = ok(&started, "media.input.list", Value::Null);
    assert!(media_listed.as_array().unwrap().iter().any(|m| m["id"] == media_id && m["phase"] == "ready"));

    // 10. note (doc + canvas directory files)
    let md_note = ok(
        &started,
        "note.create",
        json!({
            "title": "Dual Markdown",
            "noteType": "doc",
            "content": "{\"version\":1,\"blocks\":[{\"id\":\"b1\",\"type\":\"heading\",\"level\":1,\"text\":\"Dual DB\"}]}",
            "channel": eng_id
        }),
    );
    let md_note_id = md_note["id"].as_str().unwrap().to_string();

    let store_note = ok(
        &started,
        "note.create",
        json!({ "title": "Dual Store", "noteType": "canvas", "channel": eng_id }),
    );
    let store_note_id = store_note["id"].as_str().unwrap().to_string();
    let written = ok(
        &started,
        "note.file.write",
        json!({
            "id": store_note_id,
            "files": [{ "path": "structure/notes.txt", "content": "persisted" }]
        }),
    );
    assert_eq!(written["seq"], 2);

    // 11. team/memory
    let mem = ok(
        &started,
        "memory.create",
        json!({ "agent": reviewer.id, "text": "dual db persists memory rows cleanly", "repo": "acme/dual" }),
    );
    let mem_id = mem["id"].as_str().unwrap().to_string();
    let mem_found = ok(&started, "memory.search", json!({ "text": "persists memory rows" }));
    assert!(mem_found["found"].as_array().unwrap().iter().any(|m| m["id"] == mem_id));
    let mem_recalled = ok(
        &started,
        "memory.recall",
        json!({ "agent": reviewer.id, "repo": "acme/dual", "text": "dual db memory" }),
    );
    assert!(!mem_recalled["lines"].as_array().unwrap().is_empty());

    // 12. infra/remote (enable, pair.create, pair.exchange, whoami)
    let remote_enabled = ok(&started, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }));
    let remote_url = remote_enabled["url"].as_str().unwrap().to_string();
    let pair = ok(&started, "remote.pair.create", json!({}));
    let pair_code = pair["code"].as_str().unwrap().to_string();

    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
    let exchanged: Value = client
        .post(format!("{remote_url}/api/v1/remote/pair/exchange"))
        .json(&json!({ "code": pair_code, "deviceName": "DualDB CLI", "platform": "cli" }))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(exchanged["bizCode"], 0, "{exchanged}");
    let remote_token = exchanged["data"]["token"].as_str().unwrap().to_string();
    let device_id = exchanged["data"]["device"]["id"].as_str().unwrap().to_string();

    let whoami: Value = client
        .post(format!("{remote_url}/api/v1/remote/whoami"))
        .header("authorization", format!("Bearer {remote_token}"))
        .json(&json!({}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(whoami["bizCode"], 0, "{whoami}");
    assert_eq!(whoami["data"]["device"]["id"], device_id);

    // 13. durable store sharing the same Database backend
    let durable = vibevalley_runtime::rt::block_on(started.test_internals().service.durable()).unwrap();
    vibevalley_runtime::rt::block_on(durable.write_async(|tx| {
        Box::pin(async move {
            tx.create_conversation_async("dual-conv", "deepseek-flash").await?;
            tx.append_entry_async("dual-conv", "pi.user", &json!({ "msg": "dual-db" })).await?;
            tx.put_document_async("dual", "e2e", "state", &json!({ "ok": true })).await?;
            Ok(())
        })
    }))
    .unwrap();
    drop(durable);

    // Verify slice feed snapshot works before shutdown.
    vibevalley_runtime::rt::block_on(started.ctx().feed.flush());
    let board_json = started.ctx().feed.snapshot_json(SliceKind::Board);
    assert!(board_json.contains("Dual DB Issue"));

    // Clean shutdown and reopen to prove full persistence across restart.
    started.close_blocking();

    let reopened = start_server(home, database_url, &wx.base_url);

    let issues = ok(&reopened, "issue.list", json!({}));
    assert!(issues.as_array().unwrap().iter().any(|i| i["id"] == issue_id && i["priority"] == "high"));

    let sessions = ok(&reopened, "session.list", json!({}));
    assert!(sessions.as_array().unwrap().iter().any(|s| s["id"] == session_id && s["runtime"] == "scripted"));

    let crons = ok(&reopened, "cron.list", json!({}));
    assert!(crons.as_array().unwrap().iter().any(|c| c["id"] == cron_id && c["enabled"] == false));

    let pull_reloaded = reopened.test_internals().pull.find("acme/dual", 88).expect("pull persisted");
    assert_eq!(pull_reloaded.issue_id.as_deref(), Some(issue_id.as_str()));
    assert_eq!(
        vibevalley_runtime::rt::block_on(reopened.test_internals().pull.known_events_async(&pull_reloaded.id))
            .unwrap()
            .len(),
        1
    );

    let msgs = ok(&reopened, "channel.message.list", json!({ "id": eng_id }));
    assert!(msgs.to_string().contains("hello from dual db"));
    let pins = ok(&reopened, "channel.pin.list", json!({ "id": eng_id }));
    assert!(pins.as_array().unwrap().iter().any(|p| p["id"] == msg_id));

    vibevalley_runtime::rt::block_on(reopened.ctx().feed.flush());
    let collab: vibevalley_protocol::CollabSlice = serde_json::from_str(&reopened.ctx().feed.snapshot_json(SliceKind::Collab)).unwrap();
    assert!(
        collab
            .connectors
            .iter()
            .any(|c| c.id.as_str() == "weixin" && c.channel.as_deref() == Some("dual-eng"))
    );

    let lib_items = ok(&reopened, "library.item.list", json!({}));
    assert!(lib_items.as_array().unwrap().iter().any(|i| i["attachment"]["id"] == att_id));

    let media_listed = ok(&reopened, "media.input.list", json!({}));
    assert!(media_listed.as_array().unwrap().iter().any(|m| m["id"] == media_id && m["phase"] == "ready"));

    let md_got = ok(&reopened, "note.get", json!({ "id": md_note_id }));
    assert_eq!(md_got["title"], "Dual Markdown");
    let files = ok(&reopened, "note.file.list", json!({ "id": store_note_id, "prefix": "structure/" }));
    assert!(files["files"].as_array().unwrap().iter().any(|f| f["path"] == "structure/notes.txt"));
    let file_got = ok(&reopened, "note.file.get", json!({ "id": store_note_id, "path": "structure/notes.txt" }));
    assert_eq!(file_got["content"], "persisted");

    let mems = ok(&reopened, "memory.list", json!({ "agent": reviewer.id }));
    assert!(mems["memories"].as_array().unwrap().iter().any(|m| m["id"] == mem_id));

    let remote_status = ok(&reopened, "remote.status", json!({}));
    assert!(
        remote_status["devices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == device_id && d["name"] == "DualDB CLI")
    );

    let durable2 = vibevalley_runtime::rt::block_on(reopened.test_internals().service.durable()).unwrap();
    let doc = vibevalley_runtime::rt::block_on(durable2.read_async(|rd| Box::pin(rd.document_async("dual", "e2e", "state"))))
        .unwrap()
        .unwrap();
    assert_eq!(doc.state, json!({ "ok": true }));
    let entries2 = vibevalley_runtime::rt::block_on(durable2.read_async(|rd| Box::pin(rd.entries_async("dual-conv", 0)))).unwrap();
    assert_eq!(entries2.len(), 1);
    drop(durable2);

    reopened.close_blocking();
}

#[test]
fn full_stack_server_persists_all_domains_on_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    run_full_stack_e2e(dir.path(), None);
}

#[test]
fn full_stack_server_persists_all_domains_on_postgres() {
    let Some(pg) = EphemeralPostgres::start() else {
        eprintln!("skipping full_stack_server_persists_all_domains_on_postgres: initdb/pg_ctl not found");
        return;
    };
    pg.create_database("vibevalley_e2e_dual_db");
    let dir = tempfile::tempdir().unwrap();
    run_full_stack_e2e(dir.path(), Some(pg.db_url("vibevalley_e2e_dual_db")));
}
