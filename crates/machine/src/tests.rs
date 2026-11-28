use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::time::Duration;

use parking_lot::RwLock;
use tokio::sync::broadcast;

use super::{
    LOCAL_MACHINE_ID, LocalMachine, Machine, MachineDescriptor, MachinePlatform, MachineRegistry, MachineRegistryEvent, MachineStatus, RuntimeRef,
    RuntimeRefParseError,
};
use vibevalley_oar::scripted::{Script, ScriptedRuntime};
use vibevalley_oar::{ContentBlock, EventKind, Registry, Runtime, SessionOptions};

struct MockMachine {
    machine_id: String,
    label: String,
    platform: MachinePlatform,
    status: RwLock<MachineStatus>,
    ephemeral: bool,
    runtimes: Vec<Arc<dyn Runtime>>,
}

impl MockMachine {
    fn new(
        machine_id: impl Into<String>,
        label: impl Into<String>,
        platform: MachinePlatform,
        status: MachineStatus,
        ephemeral: bool,
        runtimes: Vec<Arc<dyn Runtime>>,
    ) -> Self {
        Self {
            machine_id: machine_id.into(),
            label: label.into(),
            platform,
            status: RwLock::new(status),
            ephemeral,
            runtimes,
        }
    }

    fn set_status(&self, status: MachineStatus) {
        *self.status.write() = status;
    }
}

impl Machine for MockMachine {
    fn descriptor(&self) -> MachineDescriptor {
        MachineDescriptor {
            machine_id: self.machine_id.clone(),
            label: self.label.clone(),
            platform: self.platform,
            status: *self.status.read(),
            ephemeral: self.ephemeral,
            local: false,
        }
    }

    fn machine_id(&self) -> &str {
        &self.machine_id
    }

    fn runtimes(&self) -> Vec<Arc<dyn Runtime>> {
        self.runtimes.clone()
    }
}

fn scripted(id: &str) -> Arc<dyn Runtime> {
    Arc::new(ScriptedRuntime::new(id, Script::echo()))
}

#[tokio::test]
async fn local_machine_wraps_scripted_runtime_and_runs_session() {
    let mut oar_registry = Registry::new();
    oar_registry.register(scripted("scripted"));
    oar_registry.register(scripted("acp:opencode"));

    let local = Arc::new(LocalMachine::new(oar_registry).with_label("MacBook Pro"));
    let desc = local.descriptor();
    assert_eq!(desc.machine_id, LOCAL_MACHINE_ID);
    assert_eq!(desc.label, "MacBook Pro");
    assert_eq!(desc.platform, MachinePlatform::current());
    assert_eq!(desc.status, MachineStatus::Online);
    assert!(!desc.ephemeral);
    assert!(desc.local);
    assert_eq!(local.machine_id(), LOCAL_MACHINE_ID);
    assert_eq!(local.runtimes().len(), 2);
    assert_eq!(local.runtime("opencode").expect("acp prefix match").id(), "acp:opencode");

    let machines = MachineRegistry::new();
    machines.register(local);

    let (machine, runtime) = machines.resolve(&RuntimeRef::local("scripted")).expect("local scripted runtime");
    assert_eq!(machine.machine_id(), LOCAL_MACHINE_ID);
    assert_eq!(runtime.id(), "scripted");

    let session = runtime
        .open(SessionOptions {
            cwd: std::env::temp_dir(),
            ..Default::default()
        })
        .await
        .expect("open scripted session");
    let mut events = session.events();
    session.prompt(vec![ContentBlock::Text("hello local".into())]).await.expect("prompt");

    let mut echoed = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("event before timeout")
            .expect("channel open");
        match event.kind {
            EventKind::TextDelta { text } => echoed.push_str(&text),
            EventKind::TurnFinished { .. } => break,
            _ => {}
        }
    }
    assert_eq!(echoed, "hello local");
}

#[test]
fn hot_plug_register_update_unregister_remote_and_ephemeral_machines() {
    let registry = MachineRegistry::with_local(Registry::new());
    assert_eq!(registry.len(), 1);
    assert!(!registry.is_empty());

    let remote = Arc::new(MockMachine::new(
        "gpu-1",
        "GPU Devbox",
        MachinePlatform::Linux,
        MachineStatus::Online,
        false,
        vec![scripted("claude"), scripted("codex")],
    ));
    let sandbox = Arc::new(MockMachine::new(
        "sbx-42",
        "CI Sandbox #42",
        MachinePlatform::Container,
        MachineStatus::Online,
        true,
        vec![scripted("claude")],
    ));

    registry.register(remote.clone());
    registry.register(sandbox.clone());
    assert_eq!(registry.len(), 3);

    let listed = registry.list();
    let ids: Vec<&str> = listed.iter().map(|d| d.machine_id.as_str()).collect();
    assert_eq!(ids, vec!["local", "gpu-1", "sbx-42"]);
    assert!(listed[0].local);
    assert!(!listed[1].ephemeral);
    assert!(listed[2].ephemeral);
    assert_eq!(listed[2].platform, MachinePlatform::Container);

    let all = registry.all_runtimes();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].0.machine_id, "gpu-1");
    assert_eq!(all[2].0.machine_id, "sbx-42");

    let remote_v2 = Arc::new(MockMachine::new(
        "gpu-1",
        "GPU Devbox (upgraded)",
        MachinePlatform::Linux,
        MachineStatus::Online,
        false,
        vec![scripted("claude")],
    ));
    registry.register(remote_v2);
    assert_eq!(registry.len(), 3);
    assert_eq!(registry.get("gpu-1").unwrap().descriptor().label, "GPU Devbox (upgraded)");
    assert!(registry.resolve(&RuntimeRef::new("gpu-1", "codex")).is_none());
    assert!(registry.resolve(&RuntimeRef::new("gpu-1", "claude")).is_some());

    let removed = registry.unregister("sbx-42").expect("sandbox removed");
    assert_eq!(removed.machine_id(), "sbx-42");
    assert!(removed.descriptor().ephemeral);
    assert!(registry.get("sbx-42").is_none());
    assert!(registry.resolve(&RuntimeRef::new("sbx-42", "claude")).is_none());
    assert!(registry.unregister("sbx-42").is_none());
}

#[test]
fn runtime_ref_display_parse_and_validation() {
    let local = RuntimeRef::local("claude");
    assert!(local.is_local());
    assert_eq!(local.to_string(), "local/claude");
    assert_eq!(RuntimeRef::parse("local/claude").unwrap(), local);

    let remote = RuntimeRef::parse("gpu-1/acp:opencode").unwrap();
    assert!(!remote.is_local());
    assert_eq!(remote.machine_id, "gpu-1");
    assert_eq!(remote.runtime_id, "acp:opencode");
    assert_eq!(remote.to_string(), "gpu-1/acp:opencode");

    assert!(matches!(RuntimeRef::parse(""), Err(RuntimeRefParseError::InvalidFormat(_))));
    assert!(matches!(RuntimeRef::parse("claude"), Err(RuntimeRefParseError::InvalidFormat(_))));
    assert!(matches!(RuntimeRef::parse("a/b/c"), Err(RuntimeRefParseError::InvalidFormat(_))));
    assert!(matches!(RuntimeRef::parse("/claude"), Err(RuntimeRefParseError::EmptyMachineId(_))));
    assert!(matches!(RuntimeRef::parse("  /claude"), Err(RuntimeRefParseError::EmptyMachineId(_))));
    assert!(matches!(RuntimeRef::parse("local/"), Err(RuntimeRefParseError::EmptyRuntimeId(_))));
    assert!(matches!(RuntimeRef::parse("local/  "), Err(RuntimeRefParseError::EmptyRuntimeId(_))));
}

#[test]
fn resolve_and_fallback_respect_local_priority_and_online_status() {
    let registry = MachineRegistry::new();
    registry.register(Arc::new(LocalMachine::from_runtimes(vec![scripted("claude")])));

    let gpu_online = Arc::new(MockMachine::new(
        "gpu-1",
        "GPU Online",
        MachinePlatform::Linux,
        MachineStatus::Online,
        false,
        vec![scripted("claude"), scripted("codex")],
    ));
    let gpu_offline = Arc::new(MockMachine::new(
        "gpu-2",
        "GPU Offline",
        MachinePlatform::Linux,
        MachineStatus::Offline,
        false,
        vec![scripted("only-offline"), scripted("codex")],
    ));
    let gpu_draining = Arc::new(MockMachine::new(
        "gpu-3",
        "GPU Draining",
        MachinePlatform::Container,
        MachineStatus::Draining,
        true,
        vec![scripted("only-draining"), scripted("codex")],
    ));

    registry.register(gpu_online.clone());
    registry.register(gpu_offline);
    registry.register(gpu_draining);

    let (m, r) = registry.resolve_local_or_any("claude").expect("prefers local");
    assert_eq!(m.machine_id(), LOCAL_MACHINE_ID);
    assert_eq!(r.id(), "claude");

    let (m, r) = registry.resolve(&RuntimeRef::new("gpu-1", "claude")).expect("explicit remote target");
    assert_eq!(m.machine_id(), "gpu-1");
    assert_eq!(r.id(), "claude");

    let (m, r) = registry.resolve_local_or_any("codex").expect("falls back to online remote");
    assert_eq!(m.machine_id(), "gpu-1");
    assert_eq!(r.id(), "codex");

    assert!(registry.resolve_local_or_any("only-offline").is_none());
    assert!(registry.resolve_local_or_any("only-draining").is_none());

    let (offline_machine, _) = registry
        .resolve(&RuntimeRef::new("gpu-2", "only-offline"))
        .expect("explicit resolve exposes offline descriptor");
    assert_eq!(offline_machine.descriptor().status, MachineStatus::Offline);

    gpu_online.set_status(MachineStatus::Draining);
    assert!(registry.notify_updated("gpu-1"));
    assert!(registry.resolve_local_or_any("codex").is_none());

    assert!(registry.resolve(&RuntimeRef::new("missing", "claude")).is_none());
    assert!(registry.resolve(&RuntimeRef::new("gpu-1", "missing")).is_none());

    let headless = MachineRegistry::new();
    headless.register(Arc::new(MockMachine::new(
        "remote-a",
        "Remote A",
        MachinePlatform::Linux,
        MachineStatus::Online,
        false,
        vec![scripted("claude")],
    )));
    let (m, r) = headless.resolve_local_or_any("claude").expect("resolves remote without local");
    assert_eq!(m.machine_id(), "remote-a");
    assert_eq!(r.id(), "claude");
}

#[test]
fn broadcast_events_report_register_update_and_unregister() {
    let registry = MachineRegistry::new();
    let mut rx_a = registry.subscribe();
    let mut rx_b = registry.subscribe();

    let box_v1 = Arc::new(MockMachine::new(
        "dev-1",
        "Dev Box",
        MachinePlatform::Linux,
        MachineStatus::Online,
        false,
        vec![scripted("claude")],
    ));
    registry.register(box_v1.clone());

    let box_v2 = Arc::new(MockMachine::new(
        "dev-1",
        "Dev Box v2",
        MachinePlatform::Linux,
        MachineStatus::Draining,
        false,
        vec![scripted("claude")],
    ));
    registry.register(box_v2.clone());

    box_v2.set_status(MachineStatus::Offline);
    assert!(registry.notify_updated("dev-1"));
    assert!(!registry.notify_updated("ghost"));

    assert!(registry.unregister("dev-1").is_some());
    assert!(registry.unregister("dev-1").is_none());

    let drain = |rx: &mut broadcast::Receiver<MachineRegistryEvent>| -> Vec<MachineRegistryEvent> {
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            out.push(event);
        }
        out
    };

    let events_a = drain(&mut rx_a);
    let events_b = drain(&mut rx_b);
    assert_eq!(events_a, events_b);
    assert_eq!(events_a.len(), 4);

    match &events_a[0] {
        MachineRegistryEvent::Registered { descriptor } => {
            assert_eq!(descriptor.machine_id, "dev-1");
            assert_eq!(descriptor.label, "Dev Box");
            assert_eq!(descriptor.status, MachineStatus::Online);
        }
        other => panic!("expected Registered, got {other:?}"),
    }
    match &events_a[1] {
        MachineRegistryEvent::Updated { descriptor } => {
            assert_eq!(descriptor.label, "Dev Box v2");
            assert_eq!(descriptor.status, MachineStatus::Draining);
        }
        other => panic!("expected Updated, got {other:?}"),
    }
    match &events_a[2] {
        MachineRegistryEvent::Updated { descriptor } => {
            assert_eq!(descriptor.status, MachineStatus::Offline);
        }
        other => panic!("expected Updated, got {other:?}"),
    }
    match &events_a[3] {
        MachineRegistryEvent::Unregistered { descriptor } => {
            assert_eq!(descriptor.machine_id, "dev-1");
            assert_eq!(events_a[3].machine_id(), "dev-1");
        }
        other => panic!("expected Unregistered, got {other:?}"),
    }

    let wire = serde_json::to_string(&events_a[0]).expect("serialize event");
    let decoded: MachineRegistryEvent = serde_json::from_str(&wire).expect("deserialize event");
    assert_eq!(decoded, events_a[0]);
}

#[test]
fn concurrent_lock_free_reads_stay_consistent_under_hot_plug_writes() {
    let registry = Arc::new(MachineRegistry::new());
    registry.register(Arc::new(LocalMachine::from_runtimes(vec![scripted("scripted")])));

    let reader_count = 4;
    let writer_count = 2;
    let iterations = 200;
    let barrier = Arc::new(Barrier::new(reader_count + writer_count));
    let mut handles = Vec::new();

    for writer_idx in 0..writer_count {
        let registry = Arc::clone(&registry);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            for step in 0..iterations {
                let id = format!("sbx-{writer_idx}-{}", step % 8);
                let machine = Arc::new(MockMachine::new(
                    id.clone(),
                    format!("Sandbox {id}"),
                    MachinePlatform::Container,
                    MachineStatus::Online,
                    true,
                    vec![scripted("claude")],
                ));
                registry.register(machine);
                if step % 2 == 0 {
                    let _ = registry.unregister(&id);
                }
            }
        }));
    }

    for _ in 0..reader_count {
        let registry = Arc::clone(&registry);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            for _ in 0..iterations * 3 {
                let (local, rt) = registry.resolve(&RuntimeRef::local("scripted")).expect("local always resolves");
                assert_eq!(local.machine_id(), LOCAL_MACHINE_ID);
                assert_eq!(rt.id(), "scripted");

                let (fallback_m, _) = registry.resolve_local_or_any("scripted").expect("fallback always resolves");
                assert_eq!(fallback_m.machine_id(), LOCAL_MACHINE_ID);

                let list = registry.list();
                assert!(!list.is_empty());
                assert_eq!(list[0].machine_id, LOCAL_MACHINE_ID);

                let _ = registry.all_runtimes();
            }
        }));
    }

    for handle in handles {
        handle.join().expect("thread finished without panic");
    }

    assert!(registry.get(LOCAL_MACHINE_ID).is_some());
}

fn remote_hello(machine_id: &str) -> vibevalley_protocol::MachineHello {
    vibevalley_protocol::MachineHello {
        machine_id: machine_id.into(),
        name: format!("Remote {machine_id}"),
        platform: vibevalley_protocol::MachinePlatform::Linux,
        ephemeral: false,
        runtimes: vec![vibevalley_protocol::MachineRuntimeSummary {
            id: "claude".into(),
            label: "Claude".into(),
            models: Vec::new(),
            capabilities: Vec::new(),
            available: true,
        }],
    }
}

#[tokio::test]
async fn remote_runtime_open_forwards_typed_dispatch_meta_without_env_smuggling() {
    use std::collections::BTreeMap;
    use tokio::sync::mpsc;
    use vibevalley_protocol::{MachineSessionOpened, MachineWireFrame};

    use super::{RemoteDispatchMeta, RemoteMachine};

    let (tx, mut rx) = mpsc::channel(16);
    let machine = RemoteMachine::new(&remote_hello("gpu-typed"), 1, tx, 1_000);
    let runtime = machine.runtime("claude").expect("remote claude runtime");

    let meta = RemoteDispatchMeta {
        session_id: Some("s42".into()),
        repo_ref: Some("https://github.com/acme/farm.git".into()),
        mcp_session_token: Some("mcp_secret_token_999".into()),
        ..Default::default()
    };
    let debug = format!("{meta:?}");
    assert!(!debug.contains("mcp_secret_token_999"), "RemoteDispatchMeta Debug leaked secret: {debug}");

    let open_machine = Arc::clone(&machine);
    let responder = tokio::spawn(async move {
        let frame = rx.recv().await.expect("session.open frame");
        let MachineWireFrame::MachineSessionOpen(open) = frame else {
            panic!("expected MachineSessionOpen, got {frame:?}");
        };
        open_machine.handle_session_opened(MachineSessionOpened {
            request_id: open.request_id.clone(),
            session_id: open.session_id.clone(),
            ok: true,
            workdir: Some("/remote/work/s42".into()),
            error: None,
        });
        open
    });

    let _session = runtime
        .open(SessionOptions {
            cwd: PathBuf::from("/local/unused"),
            env: vec![("CUSTOM_FLAG".into(), "1".into())],
            remote_dispatch: Some(meta),
            ..Default::default()
        })
        .await
        .expect("remote session opened");

    let open = responder.await.expect("responder joined");
    assert_eq!(open.session_id, "s42");
    assert_eq!(open.repo_ref.as_deref(), Some("https://github.com/acme/farm.git"));
    assert_eq!(open.workdir.as_deref(), Some("/local/unused"));
    assert_eq!(open.mcp_session_token.as_deref(), Some("mcp_secret_token_999"));
    assert_eq!(open.env, BTreeMap::from([("CUSTOM_FLAG".to_string(), "1".to_string())]));
    assert!(
        open.env.keys().all(|k| !k.starts_with("__VIBEVALLEY_REMOTE_")),
        "child env must never carry __VIBEVALLEY_REMOTE_* keys: {:?}",
        open.env
    );
}

#[tokio::test]
async fn remote_runtime_open_supports_directoryless_session() {
    use tokio::sync::mpsc;
    use vibevalley_protocol::{MachineSessionOpened, MachineWireFrame};

    use super::{RemoteDispatchMeta, RemoteMachine};

    let (tx, mut rx) = mpsc::channel(16);
    let machine = RemoteMachine::new(&remote_hello("gpu-dirless"), 1, tx, 1_000);
    let runtime = machine.runtime("claude").expect("remote claude runtime");

    let open_machine = Arc::clone(&machine);
    let responder = tokio::spawn(async move {
        let frame = rx.recv().await.expect("session.open frame");
        let MachineWireFrame::MachineSessionOpen(open) = frame else {
            panic!("expected MachineSessionOpen, got {frame:?}");
        };
        open_machine.handle_session_opened(MachineSessionOpened {
            request_id: open.request_id.clone(),
            session_id: open.session_id.clone(),
            ok: true,
            workdir: Some("/remote/sessions/s-dirless".into()),
            error: None,
        });
        open
    });

    let _session = runtime
        .open(SessionOptions {
            remote_dispatch: Some(RemoteDispatchMeta {
                session_id: Some("s-dirless".into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .expect("directoryless remote session opened");

    let open = responder.await.expect("responder joined");
    assert_eq!(open.session_id, "s-dirless");
    assert_eq!(open.workdir, None);
    assert_eq!(open.repo_ref, None);
}

#[tokio::test]
async fn remote_runtime_open_falls_back_to_mcp_bearer_token_when_meta_token_absent() {
    use tokio::sync::mpsc;
    use vibevalley_protocol::{MachineSessionOpened, MachineWireFrame};

    use super::{RemoteDispatchMeta, RemoteMachine};
    use vibevalley_oar::McpServer;

    let (tx, mut rx) = mpsc::channel(16);
    let machine = RemoteMachine::new(&remote_hello("gpu-mcp"), 1, tx, 1_000);
    let runtime = machine.runtime("claude").expect("remote claude runtime");

    let open_machine = Arc::clone(&machine);
    let responder = tokio::spawn(async move {
        let frame = rx.recv().await.expect("session.open frame");
        let MachineWireFrame::MachineSessionOpen(open) = frame else {
            panic!("expected MachineSessionOpen, got {frame:?}");
        };
        open_machine.handle_session_opened(MachineSessionOpened {
            request_id: open.request_id.clone(),
            session_id: open.session_id.clone(),
            ok: true,
            workdir: None,
            error: None,
        });
        open
    });

    let _session = runtime
        .open(SessionOptions {
            remote_dispatch: Some(RemoteDispatchMeta {
                session_id: Some("s99".into()),
                ..Default::default()
            }),
            mcp_servers: vec![McpServer::Http {
                name: "vibevalley".into(),
                url: "http://127.0.0.1:8790/mcp".into(),
                headers: vec![("Authorization".into(), "Bearer tok_from_mcp_header".into())],
            }],
            ..Default::default()
        })
        .await
        .expect("remote session opened");

    let open = responder.await.expect("responder joined");
    assert_eq!(open.session_id, "s99");
    assert_eq!(open.mcp_session_token.as_deref(), Some("tok_from_mcp_header"));
}

#[tokio::test]
async fn remote_session_evicts_slow_event_subscriber_when_bounded_channel_fills() {
    use tokio::sync::mpsc;
    use vibevalley_protocol::{MachineSessionEvent, MachineSessionOpened, MachineWireFrame};

    use super::{RemoteDispatchMeta, RemoteMachine};
    use vibevalley_oar::core::EVENT_SUBSCRIBER_CAPACITY;

    let (tx, mut rx) = mpsc::channel(16);
    let machine = RemoteMachine::new(&remote_hello("gpu-bp"), 1, tx, 1_000);
    let runtime = machine.runtime("claude").expect("remote claude runtime");

    let open_machine = Arc::clone(&machine);
    tokio::spawn(async move {
        if let Some(MachineWireFrame::MachineSessionOpen(open)) = rx.recv().await {
            open_machine.handle_session_opened(MachineSessionOpened {
                request_id: open.request_id,
                session_id: open.session_id,
                ok: true,
                workdir: None,
                error: None,
            });
        }
    });

    let session = runtime
        .open(SessionOptions {
            remote_dispatch: Some(RemoteDispatchMeta {
                session_id: Some("s-bp".into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .expect("open session");

    let mut slow_rx = session.events();
    let mut fast_rx = session.events();

    for seq in 1..=(EVENT_SUBSCRIBER_CAPACITY as u64 + 5) {
        let ev = vibevalley_oar::Event {
            seq,
            agent_path: Vec::new(),
            at_ms: 1_000,
            kind: EventKind::TextDelta { text: "x".into() },
        };
        machine.handle_session_event(MachineSessionEvent {
            session_id: "s-bp".into(),
            seq,
            event_json: serde_json::to_string(&ev).expect("serialize event"),
            terminal: false,
            at: 1_000,
        });
        assert!(fast_rx.try_recv().is_ok(), "fast subscriber keeps receiving at seq {seq}");
    }

    let mut slow_count = 0usize;
    while slow_rx.try_recv().is_ok() {
        slow_count += 1;
    }
    assert_eq!(slow_count, EVENT_SUBSCRIBER_CAPACITY);
    assert!(slow_rx.recv().await.is_none(), "slow subscriber must be evicted and closed");
}
