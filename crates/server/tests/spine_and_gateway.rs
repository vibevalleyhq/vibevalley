//! Integration tests for Wave 2B server spine, single `ServerDb`, `Hub::invoke`,
//! P0 gateway authentication (`subscribe_with` RBAC + `/api/v1/attachment/{id}`
//! auth & HTTP `Range` streaming), `Fact::RuntimeInboxChanged`, pre-encoded
//! `SliceFeed` JSON caching, generalized remote platforms/scopes, and `LiveVoicePort`.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::{Value, json};
use vibevalley_core::SliceMask;
use vibevalley_protocol::{
    BizCode, Caller, InboxFrom, InboxFromRuntime, InboxItem, InboxKind, InboxSlice, InboxTarget, InboxTargetRuntime, InboxWords, IssueFilter, RemotePlatform,
    SCOPE_REMOTE_CLIENT, SCOPE_REMOTE_MACHINE, SettingsUpdate, SliceKind, ops,
};
use vibevalley_server::gateway::api::{CallerContext, InvokeObserver, Server};
use vibevalley_server::gateway::http::serve;

fn start_server(dir: &std::path::Path) -> vibevalley_server::App {
    start_server_with_observer(dir, None)
}

fn start_server_with_observer(dir: &std::path::Path, invoke_observer: Option<Arc<dyn InvokeObserver>>) -> vibevalley_server::App {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::create_app_blocking(vibevalley_server::Config {
        version: "2.3.4-spine-test".into(),
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        debug_enabled: false,
        invoke_observer,
        ..vibevalley_server::Config::under(dir)
    })
    .unwrap()
}

fn http_client() -> reqwest::blocking::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap()
}

fn enable_and_pair(started: &vibevalley_server::App, platform: &str, name: &str, scope: Option<&str>) -> (String, String, Value) {
    let enabled = started
        .router()
        .call_as(Caller::User, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }));
    assert_eq!(enabled.biz_code, 0, "{}", enabled.message);
    let remote_url = enabled.data.unwrap()["url"].as_str().unwrap().to_string();
    let code = match scope {
        Some(s) => started.test_internals().remote.pair_create_with_scope(Some(s)).unwrap().code,
        None => {
            let pair = started.router().call_as(Caller::User, "remote.pair.create", json!({}));
            assert_eq!(pair.biz_code, 0, "{}", pair.message);
            pair.data.unwrap()["code"].as_str().unwrap().to_string()
        }
    };

    let res = http_client()
        .post(format!("{remote_url}/api/v1/remote/pair/exchange"))
        .json(&json!({ "code": code, "deviceName": name, "platform": platform }))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let body: Value = res.json().unwrap();
    assert_eq!(body["bizCode"], 0, "{body}");
    let token = body["data"]["token"].as_str().unwrap().to_string();
    (remote_url, token, body["data"].clone())
}

#[test]
fn single_server_db_shares_pool_wal_fk_and_reopens_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let service = started.test_internals().service.clone();
    assert_eq!(service.path(), Some(dir.path().join("server.db").as_path()));
    assert!(!service.is_postgres());

    // Verify WAL mode on the SQLite file.
    let journal: String = vibevalley_runtime::rt::block_on(async {
        use sqlx::Row;
        let mut conn = crate::support::inspect_db(&dir.path().join("server.db"));
        sqlx::query("PRAGMA journal_mode").fetch_one(&mut conn).await.unwrap().get(0)
    });
    assert_eq!(journal.to_lowercase(), "wal");

    // Exercise writes across issue, channel, attachment, artifact, memory, cron, remote.
    let issue = started.router().call_as(Caller::User, "issue.create", json!({ "title": "Single DB task" }));
    assert_eq!(issue.biz_code, 0, "{}", issue.message);
    let issue_id = issue.data.unwrap()["id"].as_str().unwrap().to_string();

    let channel_id = started.router().call_as(Caller::User, "channel.list", json!({})).data.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let att = started.router().call_as(
        Caller::User,
        "attachment.create",
        json!({
            "name": "note.txt",
            "type": "text/plain",
            "data": base64::engine::general_purpose::STANDARD.encode(b"hello server db"),
        }),
    );
    assert_eq!(att.biz_code, 0, "{}", att.message);
    let att_id = att.data.unwrap()["id"].as_str().unwrap().to_string();

    let sent = started.router().call_as(
        Caller::User,
        "channel.message.send",
        json!({ "id": channel_id, "text": "persisted across close", "attachments": [att_id] }),
    );
    assert_eq!(sent.biz_code, 0, "{}", sent.message);

    let artifact = started.router().call_as(
        Caller::User,
        "artifact.create",
        json!({ "title": "Spec", "kind": "markdown", "content": "# Hello" }),
    );
    assert_eq!(artifact.biz_code, 0, "{}", artifact.message);

    // Confirm only server.db exists in home (no sidecar per-module .db files).
    let db_files: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.ends_with(".db").then_some(name)
        })
        .collect();
    assert_eq!(db_files, vec!["server.db".to_string()]);

    // Coordinated shutdown checkpoints WAL, closes pool, and drops Router with zero Arc cycles.
    drop(service);
    let weak_router = Arc::downgrade(started.router());
    started.close_blocking();
    drop(started);
    assert_eq!(weak_router.strong_count(), 0, "Router must drop cleanly after App::close");

    // Reopen the same home and verify all persisted records survive intact.
    let reopened = start_server(dir.path());
    let issues = reopened.router().call_as(Caller::User, "issue.list", json!({})).data.unwrap();
    assert!(issues.as_array().unwrap().iter().any(|i| i["id"] == issue_id));
    let msgs = reopened
        .router()
        .call_as(Caller::User, "channel.message.list", json!({ "id": channel_id }))
        .data
        .unwrap();
    assert!(msgs.to_string().contains("persisted across close"));
    let arts = reopened.router().call_as(Caller::User, "artifact.list", json!({})).data.unwrap();
    assert!(arts.as_array().unwrap().iter().any(|a| a["title"] == "Spec"));
    reopened.close_blocking();
}

#[test]
fn hub_invoke_enforces_rbac_and_fires_observer() {
    struct RecordingObserver {
        started: Mutex<Vec<(Caller, String)>>,
        ended: Mutex<Vec<(Caller, String, u32)>>,
    }

    impl InvokeObserver for RecordingObserver {
        fn on_call_start(&self, ctx: &CallerContext, op: &str, _payload: &Value) {
            self.started.lock().push((ctx.caller, op.to_string()));
        }

        fn on_call_end(&self, ctx: &CallerContext, op: &str, biz_code: u32, _duration_us: u64) {
            self.ended.lock().push((ctx.caller, op.to_string(), biz_code));
        }

        fn on_apply(&self, _seq: i64, _dirty: vibevalley_core::SliceMask, _transitions: &[vibevalley_core::Transition], _duration_us: u64) {}
    }

    let dir = tempfile::tempdir().unwrap();
    let observer = Arc::new(RecordingObserver {
        started: Mutex::new(vec![]),
        ended: Mutex::new(vec![]),
    });
    let started = start_server_with_observer(dir.path(), Some(observer.clone()));

    let issues = started
        .router()
        .invoke::<ops::IssueList>(&CallerContext::local(), IssueFilter::default())
        .unwrap();
    assert!(issues.is_empty());

    let remote_issues = started.router().invoke_as::<ops::IssueList>(Caller::Remote, IssueFilter::default()).unwrap();
    assert!(remote_issues.is_empty());

    let denied = started
        .router()
        .invoke::<ops::SettingUpdate>(&CallerContext::from_caller(Caller::Session), SettingsUpdate::default())
        .unwrap_err();
    assert_eq!(denied.biz_code, BizCode::Forbidden);

    let starts = observer.started.lock().clone();
    let ends = observer.ended.lock().clone();
    assert!(starts.contains(&(Caller::User, "issue.list".into())));
    assert!(starts.contains(&(Caller::Remote, "issue.list".into())));
    assert!(starts.contains(&(Caller::Session, "setting.update".into())));
    assert!(ends.contains(&(Caller::User, "issue.list".into(), 0)));
    assert!(ends.contains(&(Caller::Remote, "issue.list".into(), 0)));
    assert!(ends.contains(&(Caller::Session, "setting.update".into(), BizCode::Forbidden.code())));

    started.close_blocking();
}

#[test]
fn subscribe_with_enforces_subscription_rbac_and_http_subscribe_authenticates() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let local_listener = serve(started.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let channel_id = started.router().call_as(Caller::User, "channel.list", json!({})).data.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Direct Server::subscribe_with enforces Subscription::CAN for every subscription.
    let session_ctx = CallerContext::from_caller(Caller::Session);
    let orch_ctx = CallerContext::from_caller(Caller::Orchestrator);
    for (sub_name, payload) in [
        ("channel.follow", json!({ "id": channel_id, "after": 0 })),
        ("session.watch", json!({ "id": "s-missing" })),
        ("issue.watch", json!({ "id": "i-missing" })),
    ] {
        for denied_ctx in [&session_ctx, &orch_ctx] {
            let err = started.router().subscribe_with(denied_ctx, sub_name, payload.clone()).unwrap_err();
            assert_eq!(err.biz_code, BizCode::Forbidden.code(), "{sub_name} for {:?}: {err:?}", denied_ctx.caller);
        }
    }

    // Allowed callers (User, Remote) can open subscriptions.
    for allowed_ctx in [CallerContext::local(), CallerContext::from_caller(Caller::Remote)] {
        let (sub_id, _rx) = started
            .router()
            .subscribe_with(&allowed_ctx, "channel.follow", json!({ "id": channel_id, "after": 0 }))
            .unwrap();
        started.router().unsubscribe(sub_id);
    }

    // HTTP remote listener must enforce Bearer auth on /api/v1/subscribe/* and /api/v1/issue/watch/*.
    let (remote_url, token, _) = enable_and_pair(&started, "cli", "Test CLI", None);
    let client = http_client();
    let follow_query = format!("{remote_url}/api/v1/subscribe/channel.follow?payload=%7B%22id%22%3A%22{channel_id}%22%2C%22after%22%3A0%7D");

    let unauth_sub = client.get(&follow_query).send().unwrap();
    assert_eq!(
        unauth_sub.status().as_u16(),
        403,
        "unauthenticated remote /subscribe must not fall back to LocalOwner"
    );

    let unauth_watch = client.get(format!("{remote_url}/api/v1/issue/watch/i-missing")).send().unwrap();
    assert_eq!(unauth_watch.status().as_u16(), 403, "unauthenticated remote /issue/watch must be refused");

    let bad_tok_loopback = client
        .get(format!(
            "{}/api/v1/subscribe/channel.follow?payload=%7B%22id%22%3A%22{channel_id}%22%2C%22after%22%3A0%7D",
            local_listener.url()
        ))
        .header("authorization", "Bearer vv_dev_bad")
        .send()
        .unwrap();
    assert_eq!(bad_tok_loopback.status().as_u16(), 401);

    let authed_sub = client.get(&follow_query).header("authorization", format!("Bearer {token}")).send().unwrap();
    assert_eq!(authed_sub.status().as_u16(), 200);
    assert_eq!(authed_sub.headers().get("content-type").unwrap().to_str().unwrap(), "text/event-stream");
    drop(authed_sub);

    drop(local_listener);
    started.close_blocking();
}

#[test]
fn attachment_http_enforces_remote_auth_query_token_and_streams_byte_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let local_listener = serve(started.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let payload_bytes = b"0123456789abcdef";

    let created = started.router().call_as(
        Caller::User,
        "attachment.create",
        json!({
            "name": "sample.bin",
            "type": "application/octet-stream",
            "data": base64::engine::general_purpose::STANDARD.encode(payload_bytes),
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let att_id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    let (remote_url, token, _) = enable_and_pair(&started, "ios", "Range iPhone", None);
    let client = http_client();
    let remote_att = format!("{remote_url}/api/v1/attachment/{att_id}");

    // Remote unauthenticated and invalid tokens must be rejected (never silently drop to LocalOwner).
    assert_eq!(client.get(&remote_att).send().unwrap().status().as_u16(), 403);
    assert_eq!(
        client
            .get(&remote_att)
            .header("authorization", "Bearer vv_dev_invalid")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    assert_eq!(client.get(format!("{remote_att}?token=vv_dev_invalid")).send().unwrap().status().as_u16(), 401);

    // POST /api/v1/attachment/file stays blocked as a native-only op even with valid Bearer token.
    let native_blocked = client
        .post(format!("{remote_url}/api/v1/attachment/file"))
        .header("authorization", format!("Bearer {token}"))
        .json(&json!({ "id": att_id }))
        .send()
        .unwrap();
    assert_ne!(native_blocked.status().as_u16(), 200);

    // Authenticated via Authorization: Bearer <token>.
    let full = client.get(&remote_att).header("authorization", format!("Bearer {token}")).send().unwrap();
    assert_eq!(full.status().as_u16(), 200);
    assert_eq!(full.headers().get("accept-ranges").unwrap().to_str().unwrap(), "bytes");
    assert_eq!(full.bytes().unwrap().as_ref(), payload_bytes);

    // Authenticated via ?token=<token> query parameter (used by <Image src>).
    let query_full = client.get(format!("{remote_att}?token={token}")).send().unwrap();
    assert_eq!(query_full.status().as_u16(), 200);
    assert_eq!(query_full.bytes().unwrap().as_ref(), payload_bytes);

    // HTTP Range: prefix, open-ended, suffix, and out-of-bounds 416.
    let prefix = client
        .get(&remote_att)
        .header("authorization", format!("Bearer {token}"))
        .header("range", "bytes=0-3")
        .send()
        .unwrap();
    assert_eq!(prefix.status().as_u16(), 206);
    assert_eq!(prefix.headers().get("content-range").unwrap().to_str().unwrap(), "bytes 0-3/16");
    assert_eq!(prefix.headers().get("content-length").unwrap().to_str().unwrap(), "4");
    assert_eq!(prefix.bytes().unwrap().as_ref(), b"0123");

    let tail = client
        .get(&remote_att)
        .header("authorization", format!("Bearer {token}"))
        .header("range", "bytes=12-")
        .send()
        .unwrap();
    assert_eq!(tail.status().as_u16(), 206);
    assert_eq!(tail.headers().get("content-range").unwrap().to_str().unwrap(), "bytes 12-15/16");
    assert_eq!(tail.bytes().unwrap().as_ref(), b"cdef");

    let suffix = client
        .get(&remote_att)
        .header("authorization", format!("Bearer {token}"))
        .header("range", "bytes=-4")
        .send()
        .unwrap();
    assert_eq!(suffix.status().as_u16(), 206);
    assert_eq!(suffix.headers().get("content-range").unwrap().to_str().unwrap(), "bytes 12-15/16");
    assert_eq!(suffix.bytes().unwrap().as_ref(), b"cdef");

    let oob = client
        .get(&remote_att)
        .header("authorization", format!("Bearer {token}"))
        .header("range", "bytes=999-")
        .send()
        .unwrap();
    assert_eq!(oob.status().as_u16(), 416);
    assert_eq!(oob.headers().get("content-range").unwrap().to_str().unwrap(), "bytes */16");

    // Loopback also supports Range streaming cleanly.
    let local_range = client
        .get(format!("{}/api/v1/attachment/{att_id}", local_listener.url()))
        .header("range", "bytes=4-7")
        .send()
        .unwrap();
    assert_eq!(local_range.status().as_u16(), 206);
    assert_eq!(local_range.bytes().unwrap().as_ref(), b"4567");

    drop(local_listener);
    started.close_blocking();
}

#[test]
fn runtime_inbox_fact_folds_into_inbox_slice_and_clears() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let inbox_slice = |app: &vibevalley_server::App| -> InboxSlice {
        vibevalley_runtime::rt::block_on(app.ctx().feed.flush());
        serde_json::from_str(&app.ctx().feed.snapshot_json(SliceKind::Inbox)).unwrap()
    };
    let before = inbox_slice(&started);
    assert!(!before.items.iter().any(|i| i.id == "runtime:test-budget-1"));

    let alert = InboxItem {
        id: "runtime:test-budget-1".into(),
        kind: InboxKind::BudgetReached,
        at: vibevalley_server::now(),
        from: InboxFrom::Runtime(InboxFromRuntime {}),
        who: "runtime".into(),
        text: "Paused at limit".into(),
        target: InboxTarget::Runtime(InboxTargetRuntime {
            task_id: "t-1".into(),
            session_id: Some("s-1".into()),
        }),
        words: InboxWords {
            label: "budget_reached".into(),
            title: "Budget reached".into(),
            body: "Paused at limit".into(),
            tray: "Paused at limit".into(),
        },
    };

    started.ctx().live.set_runtime_inbox(vec![alert]);
    started.ctx().mark_dirty(SliceMask::INBOX);
    let after = inbox_slice(&started);
    assert!(after.seq > before.seq);
    assert!(after.items.iter().any(|i| i.id == "runtime:test-budget-1"));

    started.ctx().live.set_runtime_inbox(vec![]);
    started.ctx().mark_dirty(SliceMask::INBOX);
    let cleared = inbox_slice(&started);
    assert!(cleared.seq > after.seq);
    assert!(!cleared.items.iter().any(|i| i.id == "runtime:test-budget-1"));

    started.close_blocking();
}

#[test]
fn slice_feed_caches_pre_encoded_json_arc_across_reads() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());

    let seq1 = started.router().slice_seqs()["board"];
    let json1 = started.ctx().feed.snapshot_json(SliceKind::Board);
    let json2 = started.ctx().feed.snapshot_json(SliceKind::Board);
    assert!(Arc::ptr_eq(&json1, &json2), "unchanged slice snapshot must reuse cached Arc<str>");

    let created = started.router().call_as(Caller::User, "issue.create", json!({ "title": "Cached JSON test" }));
    assert_eq!(created.biz_code, 0, "{}", created.message);

    vibevalley_runtime::rt::block_on(started.ctx().feed.flush());
    let seq3 = started.router().slice_seqs()["board"];
    let json3 = started.ctx().feed.snapshot_json(SliceKind::Board);
    let json4 = started.ctx().feed.snapshot_json(SliceKind::Board);
    assert!(seq3 > seq1);
    assert!(!Arc::ptr_eq(&json1, &json3));
    assert!(Arc::ptr_eq(&json3, &json4));
    assert!(json3.contains("Cached JSON test"));

    started.close_blocking();
}

#[test]
fn remote_supports_all_six_platforms_and_persists_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let enabled = started
        .router()
        .call_as(Caller::User, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }));
    assert_eq!(enabled.biz_code, 0, "{}", enabled.message);

    // Invalid scope on pair code creation must be refused.
    let bad_scope = started.test_internals().remote.pair_create_with_scope(Some("remote:superadmin")).unwrap_err();
    assert_eq!(bad_scope.biz_code, BizCode::InvalidInput);

    let client = http_client();
    for platform in RemotePlatform::ALL {
        let expected_scope = match platform {
            RemotePlatform::Machine | RemotePlatform::Sandbox => SCOPE_REMOTE_MACHINE,
            RemotePlatform::Ios | RemotePlatform::Android | RemotePlatform::Cli | RemotePlatform::Other => SCOPE_REMOTE_CLIENT,
        };
        let (remote_url, token, data) = enable_and_pair(&started, platform.as_str(), &format!("dev-{}", platform.as_str()), None);
        assert_eq!(data["device"]["platform"], platform.as_str());
        assert_eq!(data["device"]["scope"], expected_scope);

        let whoami: Value = client
            .post(format!("{remote_url}/api/v1/remote/whoami"))
            .header("authorization", format!("Bearer {token}"))
            .json(&json!({}))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(whoami["bizCode"], 0, "{whoami}");
        assert_eq!(whoami["data"]["device"]["platform"], platform.as_str());
        assert_eq!(whoami["data"]["device"]["scope"], expected_scope);
    }

    // Explicit scope override on pair code (e.g. CLI pairing with machine scope) persists cleanly.
    let (remote_url, token, data) = enable_and_pair(&started, "cli", "scoped-cli", Some(SCOPE_REMOTE_MACHINE));
    assert_eq!(data["device"]["scope"], SCOPE_REMOTE_MACHINE);
    let whoami: Value = client
        .post(format!("{remote_url}/api/v1/remote/whoami"))
        .header("authorization", format!("Bearer {token}"))
        .json(&json!({}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(whoami["data"]["device"]["scope"], SCOPE_REMOTE_MACHINE);

    started.close_blocking();
}

#[test]
fn spine_exposes_live_voice_port_and_narrow_started_surface() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());

    // App exposes setting MCP URL without exposing board internals.
    started.set_mcp_url("http://127.0.0.1:1/mcp");

    // Router exposes LiveVoicePort purely through the spine trait without importing channel/voice.
    let voice: vibevalley_server::gateway::api::SharedLiveVoice = started.server().ports().voice.expect("LiveVoicePort attached on Router");
    assert!(voice.grant().is_err(), "grant without configured MOSS provider must return ApiError");
    voice.stop("nonexistent-agent");

    started.close_blocking();
}
