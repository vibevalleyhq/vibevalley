//! End-to-end tests for `debug.*` DevTools diagnostics: disabled-by-default
//! refusal, redaction guarantee across RPC/timeline/trajectories/ZIP bundle,
//! bounded per-lane ring buffers, fault-injection overrides, and multi-kind
//! trajectory inspection.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{
    BizCode, Caller, ContextRef, DebugBundleResult, DebugGraph, DebugOverrideConfig, DebugSnapshot, DebugTimelineEvent, DebugTimelineLane, DebugTimelinePage,
    DebugTrajectoryDetail, DebugTrajectoryKind, DebugTrajectorySummary, EventTokens, Execution, ExecutionPolicy, Fact, Issue, Phase, Session, SessionAction,
    SessionController, SliceKind,
};
use vibevalley_runtime::oar::voyage::{Header as VoyageHeader, Kind as VoyageKind, Record as VoyageRecord, Writer as VoyageWriter};
use vibevalley_runtime::oar::{Event as OarEvent, EventKind as OarEventKind, OarObserver, Registry, StopReason, Usage as OarUsage};
use vibevalley_server::modules::work::ledger::Step;
use vibevalley_server::transport::api::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, FaultGate, HostDebugBridge, InvokeObserver};
use vibevalley_server::{ServerConfig, Started, start};

static DEBUG_TEST_LOCK: Mutex<()> = Mutex::new(());

fn start_server(dir: &Path, debug_enabled: bool, deepseek_key: &str) -> Started {
    let mut registry = Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    start(ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        deepseek_api_key: deepseek_key.into(),
        debug_enabled,
        ..ServerConfig::under(dir)
    })
    .expect("server starts")
}

struct FakeHostDebug {
    snapshot: Mutex<Value>,
}

impl FakeHostDebug {
    fn new(snapshot: Value) -> Arc<Self> {
        Arc::new(Self {
            snapshot: Mutex::new(snapshot),
        })
    }
}

impl HostDebugBridge for FakeHostDebug {
    fn snapshot(&self) -> Value {
        self.snapshot.lock().unwrap().clone()
    }
}

/// Minimal standard ZIP parser validating EOCD, central directory, local
/// headers, STORE method 0, and IEEE CRC32 checksums.
fn parse_zip_archive(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let eocd_pos = bytes
        .windows(4)
        .rposition(|w| w == 0x0605_4b50u32.to_le_bytes())
        .expect("EOCD signature present");
    let count = u16::from_le_bytes([bytes[eocd_pos + 10], bytes[eocd_pos + 11]]) as usize;
    let cd_offset = u32::from_le_bytes(bytes[eocd_pos + 16..eocd_pos + 20].try_into().unwrap()) as usize;

    let mut pos = cd_offset;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        assert_eq!(&bytes[pos..pos + 4], &0x0201_4b50u32.to_le_bytes());
        let method = u16::from_le_bytes([bytes[pos + 10], bytes[pos + 11]]);
        assert_eq!(method, 0, "expected STORE method 0");
        let crc = u32::from_le_bytes(bytes[pos + 16..pos + 20].try_into().unwrap());
        let comp_size = u32::from_le_bytes(bytes[pos + 20..pos + 24].try_into().unwrap()) as usize;
        let uncomp_size = u32::from_le_bytes(bytes[pos + 24..pos + 28].try_into().unwrap()) as usize;
        assert_eq!(comp_size, uncomp_size);
        let name_len = u16::from_le_bytes([bytes[pos + 28], bytes[pos + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[pos + 30], bytes[pos + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[pos + 32], bytes[pos + 33]]) as usize;
        let local_off = u32::from_le_bytes(bytes[pos + 42..pos + 46].try_into().unwrap()) as usize;
        let name = std::str::from_utf8(&bytes[pos + 46..pos + 46 + name_len]).unwrap().to_string();
        pos += 46 + name_len + extra_len + comment_len;

        assert_eq!(&bytes[local_off..local_off + 4], &0x0403_4b50u32.to_le_bytes());
        let l_name_len = u16::from_le_bytes([bytes[local_off + 26], bytes[local_off + 27]]) as usize;
        let l_extra_len = u16::from_le_bytes([bytes[local_off + 28], bytes[local_off + 29]]) as usize;
        let data_start = local_off + 30 + l_name_len + l_extra_len;
        let data = bytes[data_start..data_start + uncomp_size].to_vec();
        assert_eq!(crc32fast::hash(&data), crc, "CRC32 mismatch for {name}");
        entries.push((name, data));
    }
    entries
}

fn write_voyage_file(path: &Path, runtime: &str, session_id: &str, records: &[VoyageRecord]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let file = File::create(path).unwrap();
    let header = VoyageHeader::new(runtime, session_id, 1_732_000_000_000);
    let mut writer = VoyageWriter::new(BufWriter::new(file), header).unwrap();
    for rec in records {
        writer.write(rec).unwrap();
    }
}

#[test]
fn disabled_by_default_refuses_all_nine_endpoints_and_leaves_hub_unobserved() {
    let _guard = DEBUG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path(), false, "");

    assert!(!started.debug.is_enabled());
    assert!(!started.hub.has_observer(), "disabled server must not attach observer");
    assert!(!started.hub.has_fault_gate(), "disabled server must not attach fault gate");
    assert!(!vibevalley_runtime::oar::has_observer(), "disabled server must not attach global oar observer");

    let cases: [(&str, Value); 9] = [
        ("debug.snapshot", json!({})),
        ("debug.timeline.list", json!({})),
        ("debug.timeline.clear", json!({})),
        ("debug.trajectory.list", json!({})),
        ("debug.trajectory.get", json!({ "id": "orchestrator" })),
        ("debug.graph", json!({})),
        ("debug.override.get", json!({})),
        ("debug.override.set", json!({ "rpcDelayMs": 0, "sliceDelayMs": 0 })),
        ("debug.bundle.export", json!({})),
    ];
    for (op, payload) in cases {
        let user_env = started.hub.call_as(Caller::User, op, payload.clone());
        assert_eq!(
            user_env.biz_code,
            BizCode::Refused.code(),
            "{op} should refuse when debug_enabled=false, got {user_env:?}"
        );
        assert!(!user_env.message.is_empty());

        let session_env = started.hub.call_as(Caller::Session, op, payload);
        assert_eq!(
            session_env.biz_code,
            BizCode::Forbidden.code(),
            "{op} must reject non-User callers with Forbidden"
        );
    }

    let weak = Arc::downgrade(&started.hub);
    started.close();
    drop(started);
    assert_eq!(weak.strong_count(), 0, "Hub dropped cleanly without Arc cycle");
}

#[test]
fn redaction_scrubs_secrets_across_rpc_timeline_trajectories_and_exported_zip() {
    let _guard = DEBUG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let live_secret = "live-deepseek-secret-xyz987654";
    let started = start_server(dir.path(), true, live_secret);

    assert!(started.debug.is_enabled());
    assert!(started.hub.has_observer());
    assert!(started.hub.has_fault_gate());
    assert!(vibevalley_runtime::oar::has_observer());

    let sk_token = "sk-antigravitySecretToken998877";
    let bearer_token = "Bearer eyJhbGciOiJIUzI1NiJ9.SuperSecretPayload";
    let ghp_token = "ghp_GitHubPersonalSecretToken1234";
    let plain_api_key = "plain-header-api-key-secret";

    started.hub.attach_host_debug(Some(FakeHostDebug::new(json!({
        "routes": {
            "current": "/issues",
            "nativeWorkspace": true,
            "panel": "files",
            "inspectorOpen": false,
            "projects": [{ "name": format!("proj-{live_secret}") }]
        },
        "clients": [{
            "id": "workbench-1",
            "kind": "gpuiWorkbench",
            "label": "Main Window",
            "watches": ["slice:board", "slice:sessions"],
            "subscriptions": ["issue.watch"]
        }],
        "bundleMode": "nshc",
        "loopbackUrl": "http://127.0.0.1:8790",
        "bootMs": 88,
        "lastFrameMs": 19.4,
        "frames": [{
            "seq": 1,
            "time": 1_732_000_000_500_i64,
            "durationUs": 19_400,
            "slow": true,
            "summary": format!("Shell::render {sk_token}")
        }],
        "caches": [{ "name": "panes", "entries": 2, "detail": "2 open" }]
    }))));

    let call_ctx = CallerContext {
        caller: Caller::User,
        principal: CallerPrincipal::LocalOwner,
        client: Some(ClientIdentity {
            id: "cli-1".into(),
            kind: ClientKind::Cli,
            label: "CLI".into(),
        }),
        trace_id: 42,
    };
    let created = started.hub.call_with(
        &call_ctx,
        "issue.create",
        json!({
            "title": format!("Fix auth with {live_secret} and {sk_token}"),
            "description": format!("Header: {bearer_token} / {ghp_token}")
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);

    let collector = started.debug.collector();
    collector.on_call_start(&call_ctx, "setting.update", &json!({ "apiKey": plain_api_key, "authorization": bearer_token }));
    collector.on_call_end(&call_ctx, "setting.update", 0, 1_250);
    collector.on_event(
        "sess-secret",
        &OarEvent {
            seq: 1,
            agent_path: vec![],
            at_ms: 1_732_000_000_600,
            kind: OarEventKind::TextDelta {
                text: format!("leaked {live_secret} {sk_token} {ghp_token}"),
            },
        },
    );

    started.trajectories.step(
        "sess-secret",
        "",
        Step::Asked {
            text: format!("Use {live_secret} and {sk_token} with {bearer_token}"),
        },
    );
    started.trajectories.flush(true);
    let mut vrec = VoyageRecord::new(VoyageKind::Frame, "sess-secret".into(), 1_732_000_000_700);
    vrec.seq = 0;
    vrec.frame_type = "text_delta".into();
    vrec.raw = format!(r#"{{"apiKey":"{plain_api_key}","msg":"{live_secret} {ghp_token}"}}"#).into_bytes();
    write_voyage_file(&dir.path().join("records/sess-secret.jsonl"), "claude", "sess-secret", &[vrec]);

    let snap_env = started.hub.call_as(Caller::User, "debug.snapshot", json!({}));
    assert_eq!(snap_env.biz_code, 0, "{}", snap_env.message);
    let snap: DebugSnapshot = serde_json::from_value(snap_env.data.clone().unwrap()).unwrap();
    assert_eq!(snap.overview.bundle_mode.as_deref(), Some("nshc"));
    assert_eq!(snap.overview.loopback_url.as_deref(), Some("http://127.0.0.1:8790"));
    assert_eq!(snap.overview.boot_ms, Some(88));
    assert_eq!(snap.overview.active_clients, 1);

    let tl1: DebugTimelinePage = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.timeline.list", json!({ "lane": "gpui_frame" }))
            .data
            .unwrap(),
    )
    .unwrap();
    let tl2: DebugTimelinePage = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.timeline.list", json!({ "lane": "gpui_frame" }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert_eq!(tl1.events.len(), 1);
    assert_eq!(tl2.events.len(), 1);

    let all_tl = started.hub.call_as(Caller::User, "debug.timeline.list", json!({ "limit": 500 })).data.unwrap();
    let traj_list = started.hub.call_as(Caller::User, "debug.trajectory.list", json!({})).data.unwrap();
    let traj_get = started
        .hub
        .call_as(Caller::User, "debug.trajectory.get", json!({ "id": "sess-secret" }))
        .data
        .unwrap();

    let export_env = started.hub.call_as(Caller::User, "debug.bundle.export", json!({}));
    assert_eq!(export_env.biz_code, 0, "{}", export_env.message);
    let exported: DebugBundleResult = serde_json::from_value(export_env.data.unwrap()).unwrap();
    assert!(Path::new(&exported.path).is_file());
    assert!(exported.size_bytes > 0);
    assert!(exported.redacted_count > 0, "expected redactions during export");
    assert_eq!(
        exported.files,
        vec![
            "overview.json",
            "routes.json",
            "timeline.json",
            "graph.json",
            "state-cache.json",
            "overrides.json",
            "trajectories.json",
        ]
    );

    let zip_bytes = std::fs::read(&exported.path).unwrap();
    let entries = parse_zip_archive(&zip_bytes);
    assert_eq!(entries.len(), 7);

    let forbidden = [live_secret, sk_token, "eyJhbGciOiJIUzI1NiJ9.SuperSecretPayload", ghp_token, plain_api_key];
    for (label, text) in [
        ("snapshot", snap_env.data.unwrap().to_string()),
        ("timeline", all_tl.to_string()),
        ("trajectory.list", traj_list.to_string()),
        ("trajectory.get", traj_get.to_string()),
    ] {
        for secret in forbidden {
            assert!(!text.contains(secret), "raw secret {secret} leaked in {label}: {text}");
        }
    }
    for (name, data) in &entries {
        let text = std::str::from_utf8(data).expect("valid utf-8 JSON entry");
        let parsed: Value = serde_json::from_str(text).unwrap_or_else(|e| panic!("{name} invalid JSON: {e}"));
        assert!(!parsed.is_null(), "{name} should be non-null JSON");
        for secret in forbidden {
            assert!(!text.contains(secret), "raw secret {secret} leaked in zip entry {name}");
        }
    }

    started.close();
    assert!(!started.hub.has_observer());
    assert!(!started.hub.has_fault_gate());
    assert!(!vibevalley_runtime::oar::has_observer());
}

#[test]
fn ring_buffer_bounds_each_lane_at_512_and_truncates_oversized_payloads() {
    let _guard = DEBUG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path(), true, "");
    let collector = started.debug.collector();

    const PER_LANE: usize = 2000;
    let oversized = "x".repeat(8192);
    for lane in DebugTimelineLane::ALL {
        for i in 0..PER_LANE {
            collector.push(DebugTimelineEvent {
                id: 0,
                time: 1_732_000_000_000 + i as i64,
                lane,
                kind: format!("{}-ev-{i}", lane.as_str()),
                trace_id: Some(i as i64),
                duration_us: Some(500),
                summary: format!("event {i}"),
                detail: if i == PER_LANE - 1 {
                    Some(json!({ "blob": oversized }))
                } else {
                    Some(json!({ "n": i }))
                },
                slow: Some(false),
            });
        }
    }

    for lane in DebugTimelineLane::ALL {
        let page: DebugTimelinePage = serde_json::from_value(
            started
                .hub
                .call_as(Caller::User, "debug.timeline.list", json!({ "lane": lane, "limit": 2048 }))
                .data
                .unwrap(),
        )
        .unwrap();
        assert_eq!(page.events.len(), 512, "lane {lane:?} capped at 512");
        assert_eq!(page.dropped, (PER_LANE - 512) as i64, "lane {lane:?} dropped count");
        let last = page.events.last().unwrap();
        let detail = last.detail.as_ref().unwrap();
        assert_eq!(detail["_truncated"], json!(true));
        assert!(detail["originalBytes"].as_u64().unwrap() > 8192);
        assert!(serde_json::to_string(detail).unwrap().len() <= 4096);
    }

    let filtered: DebugTimelinePage = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.timeline.list", json!({ "search": "oar_wire-ev-1999", "limit": 100 }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert_eq!(filtered.events.len(), 1);
    assert_eq!(filtered.events[0].lane, DebugTimelineLane::OarWire);
    assert_eq!(filtered.dropped, 4 * (PER_LANE - 512) as i64);

    let anchor = filtered.events[0].id;
    let after: DebugTimelinePage = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.timeline.list", json!({ "afterId": anchor, "limit": 2048 }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert!(after.events.iter().all(|e| e.id > anchor));

    assert_eq!(started.hub.call_as(Caller::User, "debug.timeline.clear", json!({})).biz_code, 0);
    let cleared: DebugTimelinePage = serde_json::from_value(started.hub.call_as(Caller::User, "debug.timeline.list", json!({})).data.unwrap()).unwrap();
    assert!(cleared.events.is_empty());
    assert_eq!(cleared.dropped, 0);

    started.close();
}

#[test]
fn fault_gate_delays_normal_ops_without_delaying_or_recording_debug_ops() {
    let _guard = DEBUG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path(), true, "");

    assert_eq!(started.hub.call_as(Caller::User, "debug.timeline.clear", json!({})).biz_code, 0);

    let set_env = started.hub.call_as(
        Caller::User,
        "debug.override.set",
        json!({
            "rpcDelayMs": 80,
            "sliceDelayMs": 60,
            "disconnectTopic": "slice:board"
        }),
    );
    assert_eq!(set_env.biz_code, 0, "{}", set_env.message);
    let cfg: DebugOverrideConfig = serde_json::from_value(set_env.data.unwrap()).unwrap();
    assert_eq!(cfg.rpc_delay_ms, 80);
    assert_eq!(cfg.slice_delay_ms, 60);
    assert_eq!(cfg.disconnect_topic.as_deref(), Some("slice:board"));

    let t_debug = Instant::now();
    let get_env = started.hub.call_as(Caller::User, "debug.override.get", json!({}));
    let debug_elapsed = t_debug.elapsed();
    assert_eq!(get_env.biz_code, 0);
    assert!(
        debug_elapsed < Duration::from_millis(30),
        "debug.override.get must not be delayed (took {debug_elapsed:?})"
    );

    let t_normal = Instant::now();
    let health = started.hub.call_as(Caller::User, "server.health.get", json!({}));
    let normal_elapsed = t_normal.elapsed();
    assert_eq!(health.biz_code, 0);
    assert!(
        normal_elapsed >= Duration::from_millis(70),
        "normal RPC should be delayed >=70ms (took {normal_elapsed:?})"
    );

    let rpc_page: DebugTimelinePage = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.timeline.list", json!({ "lane": "bridge_rpc" }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert!(rpc_page.events.iter().any(|e| e.kind == "server.health.get"));
    assert!(
        rpc_page.events.iter().all(|e| !e.kind.starts_with("debug.")),
        "debug.* ops must never spam BridgeRpc timeline: {:?}",
        rpc_page.events
    );

    let gate = started.debug.collector();
    assert_eq!(gate.delay_ms("slice:board"), 60);
    assert_eq!(gate.delay_ms("debug.snapshot"), 0);
    assert!(gate.should_disconnect("slice:board"));
    assert!(!gate.should_disconnect("slice:board"), "disconnect_topic must be one-shot");
    let after_cfg: DebugOverrideConfig = serde_json::from_value(started.hub.call_as(Caller::User, "debug.override.get", json!({})).data.unwrap()).unwrap();
    assert_eq!(after_cfg.disconnect_topic, None);

    started.hub.call_as(
        Caller::User,
        "debug.override.set",
        json!({ "rpcDelayMs": 90, "sliceDelayMs": 45, "targetFilter": "issue." }),
    );
    assert_eq!(gate.delay_ms("issue.list"), 90);
    assert_eq!(gate.delay_ms("server.health.get"), 0);
    assert_eq!(gate.delay_ms("slice:board"), 0);

    started.close();
}

#[test]
fn trajectory_inspector_covers_issue_workspace_and_orchestrator_with_voyage_tokens_and_silent_errors() {
    let _guard = DEBUG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path(), true, "");

    let mut issue = Issue::new("iss-1", 7, "Investigate quota error", 1_732_000_000_000);
    issue.assignments.push(vibevalley_protocol::Assignment {
        id: "asgn-1".into(),
        issue: "iss-1".into(),
        agent: "worker-a".into(),
        assigned_at: 1_732_000_000_000,
        ended_at: None,
        executions: vec![Execution::Worker {
            session: "sess-issue-1".into(),
            started_at: 1_732_000_000_100,
        }],
    });
    let mut issue_session = Session::new(
        "sess-issue-1",
        SessionController::IssueBoard,
        "Worker A",
        "claude",
        ExecutionPolicy::ManagedWorktree {
            repo: "farm".into(),
            branch: Some("fix/quota".into()),
        },
        1_732_000_000_100,
    );
    issue_session.cwd = Some("/tmp/worktree-issue-1".into());
    issue_session.phase = Phase::working(1_732_000_000_100, SessionAction::Thinking, "debugging");
    issue_session.attach_binding(ContextRef::Issue {
        id: "iss-1".into(),
        refining: None,
    });

    let mut ws_session = Session::new(
        "sess-ws-1",
        SessionController::User,
        "Workspace Chat",
        "codex",
        ExecutionPolicy::DirectCwd {
            repo: Some("farm".into()),
            permission_mode: vibevalley_protocol::SessionPermissionMode::Ask,
        },
        1_732_000_000_200,
    );
    ws_session.cwd = Some("/tmp/repo-farm".into());

    started.hub.apply(vec![
        Fact::issue_changed(1_732_000_000_100, issue),
        Fact::session_changed(1_732_000_000_100, issue_session),
        Fact::session_changed(1_732_000_000_200, ws_session),
    ]);

    started.trajectories.step("sess-issue-1", "", Step::RunStarted { run: "run-1".into() });
    started.trajectories.step(
        "sess-issue-1",
        "",
        Step::Asked {
            text: "Fix the silent failure".into(),
        },
    );
    started.trajectories.with_log("sess-issue-1", |j| {
        j.said("Checking logs...", &[]);
        j.usage(
            EventTokens {
                input: 1500,
                cache_read: 400,
                output: 320,
                cache_write: Some(100),
                reasoning: Some(80),
                context_used: Some(1900),
                context_window: Some(200_000),
            },
            &[],
        );
    });
    started.trajectories.flush(true);

    let big_raw = format!(r#"{{"step_type":17,"code":"QUOTA_EXHAUSTED","pad":"{}"}}"#, "z".repeat(5000));
    let mut r0 = VoyageRecord::new(VoyageKind::Frame, "sess-issue-1".into(), 1_732_000_000_150);
    r0.seq = 0;
    r0.span_id = "run-1".into();
    r0.frame_type = "step_error".into();
    r0.agent_path = vec!["sub-1".into()];
    r0.raw = big_raw.into_bytes();
    write_voyage_file(&dir.path().join("issues/records/sess-issue-1.jsonl"), "claude", "sess-issue-1", &[r0]);

    started.trajectories.step(
        "sess-ws-1",
        "",
        Step::Asked {
            text: "Explain this diff".into(),
        },
    );
    started.trajectories.flush(true);
    let mut ws_rec = VoyageRecord::new(VoyageKind::Frame, "sess-ws-1".into(), 1_732_000_000_250);
    ws_rec.seq = 0;
    ws_rec.frame_type = "error".into();
    ws_rec
        .events
        .push(json!({ "kind": "error", "message": "INVALID_THINKING_SIGNATURE during stream" }));
    write_voyage_file(&dir.path().join("records/sess-ws-1.jsonl"), "codex", "sess-ws-1", &[ws_rec]);

    let turn_start = OarEvent {
        seq: 0,
        agent_path: vec![],
        at_ms: 1_732_000_000_300,
        kind: OarEventKind::TurnStarted {
            prompt: "Plan today's work".into(),
        },
    };
    let turn_end = OarEvent {
        seq: 1,
        agent_path: vec![],
        at_ms: 1_732_000_000_450,
        kind: OarEventKind::TurnFinished {
            reason: StopReason::Completed,
            usage: OarUsage {
                input_tokens: Some(800),
                output_tokens: Some(250),
                cache_read_tokens: Some(120),
                cache_write_tokens: None,
                reasoning_tokens: Some(40),
                context_used_tokens: Some(920),
                context_window_tokens: Some(128_000),
                cost_usd: None,
            },
        },
    };
    let mut o0 = VoyageRecord::event("orchestrator".into(), &turn_start);
    o0.seq = 0;
    let mut o1 = VoyageRecord::event("orchestrator".into(), &turn_end);
    o1.seq = 1;
    write_voyage_file(&dir.path().join("records/orchestrator.jsonl"), "vibevalley", "orchestrator", &[o0, o1]);

    let list_env = started.hub.call_as(Caller::User, "debug.trajectory.list", json!({}));
    assert_eq!(list_env.biz_code, 0, "{}", list_env.message);
    let summaries: Vec<DebugTrajectorySummary> = serde_json::from_value(list_env.data.unwrap()).unwrap();
    let find = |id: &str| summaries.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("missing {id} in {summaries:?}"));

    let s_issue = find("sess-issue-1");
    assert_eq!(s_issue.kind, DebugTrajectoryKind::IssueSession);
    assert!(s_issue.has_voyage_record);
    assert!(s_issue.has_silent_error);
    assert_eq!(s_issue.tokens.as_ref().unwrap().input, 1500);

    let s_ws = find("sess-ws-1");
    assert_eq!(s_ws.kind, DebugTrajectoryKind::WorkspaceChat);
    assert!(s_ws.has_voyage_record);
    assert!(s_ws.has_silent_error);

    let s_orch = find("orchestrator");
    assert_eq!(s_orch.kind, DebugTrajectoryKind::Orchestrator);
    assert!(s_orch.has_voyage_record);
    assert!(!s_orch.has_silent_error);
    assert_eq!(s_orch.tokens.as_ref().unwrap().output, 250);

    let issue_detail: DebugTrajectoryDetail = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.trajectory.get", json!({ "id": "sess-issue-1" }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert_eq!(issue_detail.voyage_record_count, 1);
    assert_eq!(issue_detail.subagent_paths, vec!["sub-1"]);
    assert_eq!(issue_detail.turns.len(), 1);
    let t0 = &issue_detail.turns[0];
    assert_eq!(t0.prompt.as_deref(), Some("Fix the silent failure"));
    assert_eq!(t0.tokens.as_ref().unwrap().cache_read, 400);
    assert_eq!(t0.raw_entries.len(), 1);
    assert!(t0.raw_entries[0].original_bytes > 5000);
    assert!(t0.raw_entries[0].truncated);
    assert!(t0.silent_errors.iter().any(|e| e.contains("step_type=17")), "{:?}", t0.silent_errors);
    assert!(t0.silent_errors.iter().any(|e| e.contains("QUOTA_EXHAUSTED")), "{:?}", t0.silent_errors);

    let ws_detail: DebugTrajectoryDetail = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.trajectory.get", json!({ "id": "sess-ws-1" }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ws_detail.summary.kind, DebugTrajectoryKind::WorkspaceChat);
    assert!(
        ws_detail.turns[0].silent_errors.iter().any(|e| e.contains("INVALID_THINKING_SIGNATURE")),
        "{:?}",
        ws_detail.turns[0].silent_errors
    );

    let orch_detail: DebugTrajectoryDetail = serde_json::from_value(
        started
            .hub
            .call_as(Caller::User, "debug.trajectory.get", json!({ "id": "orchestrator" }))
            .data
            .unwrap(),
    )
    .unwrap();
    assert_eq!(orch_detail.summary.kind, DebugTrajectoryKind::Orchestrator);
    assert!(orch_detail.system_prompt.as_deref().is_some_and(|p| !p.is_empty()));
    assert_eq!(orch_detail.voyage_record_count, 2);
    assert_eq!(orch_detail.turns[0].prompt.as_deref(), Some("Plan today's work"));
    assert_eq!(orch_detail.turns[0].tokens.as_ref().unwrap().input, 800);

    let missing = started.hub.call_as(Caller::User, "debug.trajectory.get", json!({ "id": "does-not-exist" }));
    assert_eq!(missing.biz_code, BizCode::SessionNotFound.code());

    let _board_watch = started.hub.subscribe_slice_feed(SliceKind::Board);
    let graph: DebugGraph = serde_json::from_value(started.hub.call_as(Caller::User, "debug.graph", json!({})).data.unwrap()).unwrap();
    let g_issue = graph.sessions.iter().find(|s| s.session_id == "sess-issue-1").unwrap();
    assert_eq!(g_issue.issue_id, Some(7));
    assert_eq!(g_issue.kind, DebugTrajectoryKind::IssueSession);
    assert_eq!(g_issue.status, "working");

    let snap: DebugSnapshot = serde_json::from_value(started.hub.call_as(Caller::User, "debug.snapshot", json!({})).data.unwrap()).unwrap();
    assert_eq!(snap.state_cache.slice_seqs.len(), 6);
    assert_eq!(snap.state_cache.slice_watchers.get("board"), Some(&1));
    assert_eq!(snap.state_cache.counts.issues, 1);
    assert!(snap.state_cache.counts.sessions >= 2);
    assert_eq!(snap.overview.active_sessions, 1);
    assert!(snap.overview.latest_seq > 0);
    assert!(started.hub.slice_seqs().len() == 6);
    assert_eq!(started.hub.slice_watcher_counts().get("board"), Some(&1));

    started.close();
}
