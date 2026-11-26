use std::io::ErrorKind;
use std::net::TcpListener;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use vibevalley_server::{ClientRpc, HostDebugBridge};

use super::bundle::{build_embedded_bundle, capabilities_from, is_workbench_view, resolve_bundle_dir_from};
use super::hub::{
    BRIDGE_CONCURRENCY, FailedServer, PortPreference, bind_preferred_or_ephemeral, client_identity_for, handle_desktop_connection_op, port_preference_from,
};
use super::view::route_to_bridge;
use super::*;

#[test]
fn port_preference_parses_explicit_and_channel_defaults() {
    assert_eq!(port_preference_from(None, 8789), Ok(PortPreference::ChannelDefault(8789)));
    assert_eq!(port_preference_from(Some("  "), 8790), Ok(PortPreference::ChannelDefault(8790)));
    assert_eq!(port_preference_from(Some("0"), 8789), Ok(PortPreference::Explicit(0)));
    assert_eq!(port_preference_from(Some("9123"), 8789), Ok(PortPreference::Explicit(9123)));
    assert!(port_preference_from(Some("bogus"), 8789).is_err());
}

#[test]
fn channel_default_port_falls_back_to_ephemeral_on_addr_in_use() {
    let occupied = TcpListener::bind("127.0.0.1:0").expect("occupy loopback port");
    let busy_port = occupied.local_addr().unwrap().port();

    let fallback =
        bind_preferred_or_ephemeral(PortPreference::ChannelDefault(busy_port), TcpListener::bind).expect("channel default should fall back to ephemeral port");
    let bound_port = fallback.local_addr().unwrap().port();
    assert_ne!(bound_port, 0);
    assert_ne!(bound_port, busy_port);

    let explicit_err = bind_preferred_or_ephemeral(PortPreference::Explicit(busy_port), TcpListener::bind)
        .expect_err("explicit VIBEVALLEY_PORT must not silently fall back on AddrInUse");
    assert_eq!(explicit_err.kind(), ErrorKind::AddrInUse);
}

#[test]
fn is_workbench_view_routes_workbench_and_farm_views() {
    for view in ["vv", "vibevalley", "farm-form", "farm-phone"] {
        assert!(is_workbench_view(view), "{view} should use the full workbench bundle");
    }
    for view in ["sidebar", "palette", "markdown", "workspace-chat", "probe", "devtools"] {
        assert!(!is_workbench_view(view), "{view} should use the lightweight shell bundle");
    }
}

#[test]
fn resolve_bundle_dir_prefers_build_shell_and_falls_back_gracefully() {
    let tmp = std::env::temp_dir().join(format!("vv-bundle-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let build = tmp.join("build");
    let build_shell = tmp.join("build-shell");
    std::fs::create_dir_all(&build).unwrap();
    std::fs::write(build.join("bundle.js"), "/* full */").unwrap();

    assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, true), Some(build.clone()));
    assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, false), Some(build.clone()));

    std::fs::create_dir_all(&build_shell).unwrap();
    std::fs::write(build_shell.join("bundle.nshc"), [1u8, 2, 3]).unwrap();
    assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, false), Some(build_shell.clone()));
    assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, true), Some(build.clone()));

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn embedded_bundle_falls_back_to_source_when_bytecode_is_empty() {
    let caps = capabilities_from(r#"{"host":["action"]}"#);
    let (_bundle, mode) = build_embedded_bundle(&[], "export default function() {}", &caps);
    assert_eq!(mode, "js");
}

#[test]
fn embedded_bundle_accepts_non_empty_bytecode_with_empty_source() {
    let caps = capabilities_from(r#"{"host":["action"]}"#);
    let (_bundle, mode) = build_embedded_bundle(&[1u8, 2, 3, 4], "", &caps);
    assert_eq!(mode, "nshc");
}

#[test]
fn client_identity_maps_hosted_surfaces_to_distinct_kinds() {
    let empty = Map::new();
    let wb = client_identity_for("vv", &empty);
    assert_eq!(wb.kind, vibevalley_server::ClientKind::GpuiWorkbench);
    assert_eq!(wb.label, "vv");

    let dt = client_identity_for("devtools", &empty);
    assert_eq!(dt.kind, vibevalley_server::ClientKind::DevTools);
    assert_eq!(dt.label, "devtools");

    let sb = client_identity_for("sidebar", &empty);
    assert_eq!(sb.kind, vibevalley_server::ClientKind::GpuiSidebar);
    assert_eq!(sb.label, "sidebar");

    let mut insp_params = Map::new();
    insp_params.insert("role".into(), json!("inspector"));
    let insp = client_identity_for("sidebar", &insp_params);
    assert_eq!(insp.kind, vibevalley_server::ClientKind::GpuiSidebar);
    assert_eq!(insp.label, "inspector");
    assert_ne!(sb.id, insp.id);

    let chat = client_identity_for("workspace-chat", &empty);
    assert_eq!(chat.kind, vibevalley_server::ClientKind::GpuiChatPane);

    let phone = client_identity_for("farm-phone", &empty);
    assert_eq!(phone.kind, vibevalley_server::ClientKind::GpuiPixel);

    let pal = client_identity_for("palette", &empty);
    assert_eq!(pal.kind, vibevalley_server::ClientKind::GpuiShell);
}

#[test]
fn route_to_bridge_watches_slices_forwards_applied_slice_and_unwatches() {
    use parking_lot::Mutex;
    use std::time::Duration;
    use tokio::sync::Notify;
    use vibevalley_server::gateway::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_server::gateway::bridge::{Bridge, Outlet, SliceKind};

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<(String, Value)>>,
        notify: Notify,
    }
    impl Outlet for Recorder {
        fn send(&self, event: &str, data: Value) {
            self.events.lock().push((event.to_string(), data));
            self.notify.notify_waiters();
        }
    }
    impl Recorder {
        fn named(&self, name: &str) -> Vec<Value> {
            self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, d)| d.clone()).collect()
        }

        fn wait_for(&self, what: &str, mut f: impl FnMut(&Self) -> bool) {
            vibevalley_runtime::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let notified = self.notify.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if f(self) {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }
    }

    let fake = Arc::new(FakeServer::from_bundle(empty_bundle(1)));
    let hub = Bridge::new(fake.clone(), 2);
    let rec = Arc::new(Recorder::default());
    let client = hub.attach(next_client_identity(vibevalley_server::ClientKind::GpuiWorkbench, "vv"), rec.clone());

    for topic in [
        "slice:board",
        "slice:sessions",
        "slice:collab",
        "slice:inbox",
        "slice:ops",
        "slice:farm",
        "live",
    ] {
        assert!(route_to_bridge(&client, &json!({ "type": "watch", "topic": topic })));
    }
    // Legacy "state" topic is rejected internally (watch prints error, no watcher attached).
    assert!(route_to_bridge(&client, &json!({ "type": "watch", "topic": "state" })));

    rec.wait_for("slice:board", |r| !r.named("frame:slice:board").is_empty());
    let rev = rec.named("frame:slice:board")[0]["rev"].as_u64().unwrap();
    // `applied` acknowledges backpressure AND returns false so HostedView records debug bookkeeping.
    assert!(!route_to_bridge(&client, &json!({ "type": "applied", "topic": "slice:board", "rev": rev })));

    let mut next = empty_bundle(2);
    next.board.issues.push(vibevalley_protocol::Issue::new("i-1", 1, "Updated", 2));
    fake.swap_bundle(next);

    rec.wait_for("second slice:board after applied_slice", |r| r.named("frame:slice:board").len() >= 2);
    assert_eq!(rec.named("frame:slice:board").last().unwrap()["data"]["issues"][0]["id"], "i-1");

    assert!(route_to_bridge(&client, &json!({ "type": "unwatch", "topic": "slice:board" })));
    vibevalley_runtime::rt::block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut yields = 0usize;
            while fake.slice_watchers(SliceKind::Board) != 0 {
                if yields < 64 {
                    yields += 1;
                    tokio::task::yield_now().await;
                } else {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        })
        .await
    })
    .expect("timed out waiting for unwatch");
}

#[test]
fn shell_debug_handle_bridges_snapshots_into_server_with_bounded_frames_and_clients() {
    use vibevalley_server::SharedHostDebug;
    use vibevalley_server::gateway::bridge::fake::FakeServer;
    use vibevalley_server::gateway::bridge::{Bridge, CallerContext, Envelope, LiveEvent, Outlet, Server, SliceKind};

    struct NoopOutlet;
    impl Outlet for NoopOutlet {
        fn send(&self, _: &str, _: Value) {}
    }

    struct DebugBridgeServer {
        inner: FakeServer,
        host_debug: SharedHostDebug,
    }

    impl Server for DebugBridgeServer {
        fn call(&self, op: &str, payload: Value) -> Envelope {
            self.inner.call(op, payload)
        }
        fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
            self.inner.call_with(ctx, op, payload)
        }
        fn slice_snapshot(&self, slice: SliceKind) -> Value {
            self.inner.slice_snapshot(slice)
        }
        fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &tokio_util::sync::CancellationToken, receive: &mut dyn FnMut(i64, &Value)) {
            self.inner.watch_slice(slice, after_seq, stop, receive);
        }
        fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<LiveEvent> {
            self.inner.live()
        }
        fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
            self.inner.subscribe(name, payload)
        }
        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id);
        }
        fn host_debug(&self) -> Option<SharedHostDebug> {
            Some(self.host_debug.clone())
        }
    }

    let handle = ShellDebugHandle::new();
    let server: Arc<dyn Server> = Arc::new(DebugBridgeServer {
        inner: FakeServer::new(),
        host_debug: Arc::new(handle.clone()),
    });
    handle.set_bundle_mode("nshc");
    handle.set_boot_info("http://127.0.0.1:8790".into(), 120);
    assert_eq!(handle.loopback_port(), Some(8790));

    let bridge_hub = Bridge::new(server.clone(), 1);
    let bridge_for_provider = bridge_hub.clone();
    let provider: Arc<ClientsProvider> = Arc::new(move || bridge_for_provider.clients_snapshot());
    handle.attach_clients(&provider);
    let client = bridge_hub.attach(next_client_identity(vibevalley_server::ClientKind::DevTools, "devtools"), Arc::new(NoopOutlet));
    client.watch("slice:sessions").unwrap();

    handle.update_shell(
        json!({
            "current": "/workspace",
            "nativeWorkspace": true,
            "panel": "git",
            "inspectorOpen": true,
            "projects": [{ "id": 1, "name": "vv", "tabs": [] }],
        }),
        vec![DebugCacheEntry {
            name: "panes".into(),
            entries: 3,
            detail: Some("open pane entities".into()),
        }],
    );

    let fast = handle.record_frame(4_200, "Shell::render");
    assert!(!fast.slow);
    assert_eq!(fast.seq, 1);

    let slow = handle.record_frame(16_000, "Shell::render");
    assert!(slow.slow);
    assert_eq!(slow.seq, 2);

    for i in 0..200u64 {
        let rec = handle.record_frame(5_000 + (i % 3) * 10_000, "Shell::render");
        assert_eq!(rec.slow, rec.duration_us >= SLOW_FRAME_US);
    }

    let bridge = server.host_debug().expect("host debug bridge attached");
    let snap: Value = serde_json::from_str(&bridge.snapshot_json()).unwrap();
    assert_eq!(snap["routes"]["current"], "/workspace");
    assert_eq!(snap["routes"]["nativeWorkspace"], true);
    assert_eq!(snap["routes"]["panel"], "git");
    assert_eq!(snap["routes"]["inspectorOpen"], true);
    assert_eq!(snap["bundleMode"], "nshc");
    assert_eq!(snap["loopbackUrl"], "http://127.0.0.1:8790");
    assert_eq!(snap["bootMs"], 120);
    assert_eq!(snap["caches"][0]["name"], "panes");
    assert_eq!(snap["caches"][0]["entries"], 3);

    let clients = snap["clients"].as_array().expect("clients array");
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0]["kind"], "devTools");
    assert_eq!(clients[0]["label"], "devtools");
    assert_eq!(clients[0]["watches"], json!(["slice:sessions"]));

    let frames = snap["frames"].as_array().expect("frames array");
    assert_eq!(frames.len(), MAX_DEBUG_FRAMES);
    assert_eq!(frames.first().unwrap()["seq"], 202 - MAX_DEBUG_FRAMES as u64 + 1);
    assert_eq!(frames.last().unwrap()["seq"], 202);
    assert!(snap["lastFrameMs"].as_f64().is_some());

    drop(client);
    drop(provider);
    assert_eq!(serde_json::from_str::<Value>(&handle.snapshot_json()).unwrap()["clients"], json!([]));
}

#[test]
fn desktop_connection_host_ops_inspect_save_and_reset_without_leaking_token() {
    let dir = tempfile::tempdir().unwrap();
    let active = connection::Mode::Embedded;

    let initial = handle_desktop_connection_op("host.connectionState", json!({}), dir.path(), &active);
    assert_eq!(initial.biz_code, 0);
    let data = initial.data.unwrap();
    assert_eq!(data["activeMode"], "embedded");
    assert_eq!(data["configuredMode"], "embedded");
    assert_eq!(data["restartRequired"], false);

    let raw_token = "vv_dev_host_op_secret_token_7788";
    let saved = handle_desktop_connection_op(
        "host.connectionSave",
        json!({
            "url": "https://hub.tailnet.ts.net:8791/",
            "token": raw_token,
            "label": "Studio Mac",
        }),
        dir.path(),
        &active,
    );
    assert_eq!(saved.biz_code, 0);
    let saved_data = saved.data.unwrap();
    assert_eq!(saved_data["activeMode"], "embedded");
    assert_eq!(saved_data["configuredMode"], "remote");
    assert_eq!(saved_data["configuredUrl"], "https://hub.tailnet.ts.net:8791");
    assert_eq!(saved_data["configuredLabel"], "Studio Mac");
    assert_eq!(saved_data["tokenHint"], "…7788");
    assert_eq!(saved_data["restartRequired"], true);
    assert!(!saved_data.to_string().contains(raw_token));

    let reset = handle_desktop_connection_op("host.connectionReset", json!({}), dir.path(), &active);
    assert_eq!(reset.biz_code, 0);
    let reset_data = reset.data.unwrap();
    assert_eq!(reset_data["configuredMode"], "embedded");
    assert_eq!(reset_data["restartRequired"], false);
}

#[test]
fn failed_server_reports_service_unavailable_with_root_cause_and_empty_slices() {
    use vibevalley_server::gateway::bridge::{BizCode, CallerContext, Server, SliceKind};

    let root_cause = "vibevalley server: no such column: source_job_id";
    let server = Arc::new(FailedServer::new(root_cause));

    for env in [
        server.call("session.openWorkspace", json!({})),
        server.call_with(&CallerContext::local(), "session.openWorkspace", json!({})),
        vibevalley_runtime::rt::block_on(Arc::clone(&server).call_with_async(CallerContext::local(), "session.openWorkspace".into(), json!({}))),
    ] {
        assert_eq!(env.biz_code, BizCode::ServiceUnavailable.code());
        assert!(env.message.contains(root_cause), "unexpected message: {}", env.message);
        assert!(
            !env.message.to_ascii_lowercase().contains("fake server"),
            "must never mention fake server: {}",
            env.message
        );
    }

    let sub_err = server
        .subscribe("channel.follow", json!({}))
        .expect_err("FailedServer must refuse subscriptions");
    assert_eq!(sub_err.biz_code, BizCode::ServiceUnavailable.code());
    assert!(sub_err.message.contains(root_cause));
    assert!(!sub_err.message.to_ascii_lowercase().contains("fake server"));

    let sub_with_err = server
        .subscribe_with(&CallerContext::local(), "channel.follow", json!({}))
        .expect_err("FailedServer must refuse subscribe_with");
    assert_eq!(sub_with_err.biz_code, BizCode::ServiceUnavailable.code());
    assert!(sub_with_err.message.contains(root_cause));

    // Empty slices render cleanly without panicking and expose cached JSON + async subscriptions.
    for kind in [
        SliceKind::Board,
        SliceKind::Sessions,
        SliceKind::Collab,
        SliceKind::Inbox,
        SliceKind::Ops,
        SliceKind::Farm,
    ] {
        let snap = server.slice_snapshot(kind);
        assert_eq!(snap["seq"], 0);
        let json = server.slice_snapshot_json(kind);
        assert!(json.contains("\"seq\":0"), "slice {kind:?} json: {json}");
        assert!(server.subscribe_slice(kind).is_some());
    }

    // Live streams close immediately without spawning background threads.
    assert!(server.live().try_recv().is_err());
    let mut live_rx = server.subscribe_live().expect("broadcast receiver");
    assert!(matches!(live_rx.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Closed)));
}

#[test]
fn bridge_concurrency_does_not_starve_fast_rpcs_behind_four_slow_session_opens() {
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::Notify;
    use vibevalley_server::gateway::api::BoxFuture;
    use vibevalley_server::gateway::bridge::fake::FakeServer;
    use vibevalley_server::gateway::bridge::{Bridge, CallerContext, Envelope, Outlet, Server, SliceKind};

    struct SlowOpenServer {
        inner: FakeServer,
        open_in_flight: AtomicUsize,
        open_entered: Notify,
        release_opens: Notify,
    }

    impl SlowOpenServer {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                inner: FakeServer::new(),
                open_in_flight: AtomicUsize::new(0),
                open_entered: Notify::new(),
                release_opens: Notify::new(),
            })
        }
    }

    impl Server for SlowOpenServer {
        fn call(&self, op: &str, payload: Value) -> Envelope {
            self.inner.call(op, payload)
        }
        fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
            self.inner.call_with(ctx, op, payload)
        }
        fn call_with_async(self: Arc<Self>, _ctx: CallerContext, op: String, _payload: Value) -> BoxFuture<'static, Envelope> {
            Box::pin(async move {
                if op == "session.openWorkspace" {
                    let notified = self.release_opens.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    self.open_in_flight.fetch_add(1, Ordering::SeqCst);
                    self.open_entered.notify_waiters();
                    let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
                    return Envelope::ok(json!({ "id": "w1" }));
                }
                Envelope::ok(json!({ "op": op }))
            })
        }
        fn slice_snapshot(&self, slice: SliceKind) -> Value {
            self.inner.slice_snapshot(slice)
        }
        fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &tokio_util::sync::CancellationToken, receive: &mut dyn FnMut(i64, &Value)) {
            self.inner.watch_slice(slice, after_seq, stop, receive);
        }
        fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<vibevalley_server::gateway::bridge::LiveEvent> {
            self.inner.live()
        }
        fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
            self.inner.subscribe(name, payload)
        }
        fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
            self.inner.subscribe_with(ctx, name, payload)
        }
        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id);
        }
    }

    #[derive(Default)]
    struct ReplyRecorder {
        replies: Mutex<Vec<(String, Value)>>,
        notify: Notify,
    }

    impl Outlet for ReplyRecorder {
        fn send(&self, event: &str, data: Value) {
            self.replies.lock().push((event.to_string(), data));
            self.notify.notify_waiters();
        }
    }

    impl ReplyRecorder {
        fn has(&self, event: &str) -> bool {
            self.replies.lock().iter().any(|(e, _)| e == event)
        }
    }

    let server = SlowOpenServer::new();
    let bridge = Bridge::new(server.clone(), BRIDGE_CONCURRENCY);
    let rec = Arc::new(ReplyRecorder::default());
    let client = bridge.attach(next_client_identity(vibevalley_server::ClientKind::GpuiWorkbench, "vv"), rec.clone());

    for i in 1..=4 {
        client.call(
            &format!("open-{i}"),
            "session.openWorkspace".into(),
            json!({ "runtime": "claude", "cwd": "/tmp" }),
        );
    }

    vibevalley_runtime::rt::block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let entered = server.open_entered.notified();
                tokio::pin!(entered);
                entered.as_mut().enable();
                if server.open_in_flight.load(Ordering::SeqCst) == 4 {
                    break;
                }
                entered.await;
            }
        })
        .await
        .expect("all 4 slow session.openWorkspace calls must enter concurrently");

        client.call("fast-1", "runtime.list".into(), Value::Null);
        client.call("fast-2", "channel.message.send".into(), json!({ "channel": "c1", "text": "hi" }));

        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let replied = rec.notify.notified();
                tokio::pin!(replied);
                replied.as_mut().enable();
                if rec.has("reply:fast-1") && rec.has("reply:fast-2") {
                    break;
                }
                replied.await;
            }
        })
        .await
        .expect("fast RPCs must complete immediately while 4 slow opens are held in flight");

        assert!(!rec.has("reply:open-1"), "slow opens must still be held in flight when fast RPCs complete");
        server.release_opens.notify_waiters();

        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let replied = rec.notify.notified();
                tokio::pin!(replied);
                replied.as_mut().enable();
                if (1..=4).all(|i| rec.has(&format!("reply:open-{i}"))) {
                    break;
                }
                replied.await;
            }
        })
        .await
        .expect("all 4 slow opens must finish after release");
    });
}
