//! Values VibeValley's TypeScript wrote before the contract moved here (its
//! samples, its `reduce` and `frameOf`, each checked by its zod schema), read
//! into the Rust types and written back, must be the same JSON.

use std::collections::BTreeMap;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use vibevalley_protocol::*;

fn golden(name: &str) -> Value {
    let path = format!("{}/golden/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn round_trip<T: Serialize + DeserializeOwned>(name: &str) -> Vec<T> {
    let Value::Array(items) = golden(name) else {
        panic!("{name} is not an array")
    };
    items
        .into_iter()
        .enumerate()
        .map(|(i, want)| {
            let value: T = serde_json::from_value(want.clone()).unwrap_or_else(|e| panic!("{name}[{i}]: {e}\n{want:#}"));
            let got = serde_json::to_value(&value).unwrap();
            assert_eq!(got, want, "{name}[{i}] changed in the round trip");
            value
        })
        .collect()
}

#[test]
fn issues_from_the_servers_fold() {
    let issues = round_trip::<Issue>("issues");
    assert_eq!(issues.len(), 11);
    // The derived fields VibeValley's reduce wrote are kept as they are.
    let asking = issues.iter().find(|t| t.id == "i2").unwrap();
    assert_eq!(asking.stage.state, IssueStageKind::Asking);
}

#[test]
fn sessions_and_their_views() {
    round_trip::<Session>("sessions");
    round_trip::<SessionView>("session_views");
}

#[test]
fn facts() {
    round_trip::<Fact>("facts");
}

#[test]
fn inbox_items() {
    round_trip::<InboxItem>("inbox");
}

#[test]
fn the_state_frames_issues_sessions_and_inbox() {
    let frame = golden("state_frame");
    for (path, check) in [
        ("issues", round_value::<Vec<Issue>> as fn(&Value)),
        ("sessions", round_value::<Vec<SessionView>>),
        ("crons", round_value::<Vec<CronView>>),
    ] {
        check(&frame["state"][path]);
    }
    round_value::<Vec<InboxItem>>(&frame["inbox"]);
    assert_eq!(frame["seq"], 7);
}

fn round_value<T: Serialize + DeserializeOwned>(want: &Value) {
    let value: T = serde_json::from_value(want.clone()).unwrap();
    assert_eq!(&serde_json::to_value(&value).unwrap(), want);
}

#[test]
fn session_events_phases_crons_and_requests() {
    round_trip::<SessionEvent>("session_events");
    round_trip::<Phase>("phases");
    round_trip::<Cron>("crons");
    round_trip::<IssueRequest>("issue_requests");
    round_trip::<IssueStatusRequest>("status_requests");
}

#[test]
fn error_envelopes() {
    let envelopes = round_trip::<Envelope>("error_envelopes");
    let e = envelopes[2].error().unwrap();
    assert_eq!(e.biz_code, BizCode::IssueRefused);
    assert_eq!(e.detail.next.unwrap()[0].run.as_deref(), Some(&["vibevalley issue start 1".to_string()][..]));
    assert_eq!(
        serde_json::to_value(Envelope::void()).unwrap(),
        serde_json::json!({"bizCode": 0, "message": "ok"})
    );
}

#[test]
fn every_biz_code_and_its_meta() {
    let codes: BTreeMap<String, u32> = serde_json::from_value(golden("biz_codes")[0].clone()).unwrap();
    assert_eq!(codes.len(), BizCode::ALL.len() + 1, "Ok plus every error code");
    for code in BizCode::ALL {
        assert_eq!(codes[code.name()], code.code(), "{}", code.name());
    }
    let meta = golden("biz_code_meta")[0].clone();
    for code in BizCode::ALL {
        let want = &meta[code.code().to_string()];
        let m = code.meta();
        assert_eq!(want["status"], m.status, "{}", code.name());
        assert_eq!(want["kind"], serde_json::to_value(m.kind).unwrap(), "{}", code.name());
        assert_eq!(want["retryable"], m.retryable, "{}", code.name());
    }
}

#[test]
fn slice_bundle_and_slices_round_trip() {
    let frame = golden("state_frame");
    let seq = frame["seq"].clone();
    let state = &frame["state"];

    let mut view = frame["view"].clone();
    let standings = view.as_object_mut().unwrap().remove("achievements").unwrap();
    round_value::<Vec<AchievementStanding>>(&standings);

    let board = serde_json::json!({
        "seq": seq,
        "issues": state["issues"],
    });
    let sessions = serde_json::json!({
        "seq": seq,
        "sessions": state["sessions"],
        "machines": state["machines"],
    });
    let collab = serde_json::json!({
        "seq": seq,
        "connectors": state["connectors"],
    });
    let inbox = serde_json::json!({
        "seq": seq,
        "items": frame["inbox"],
        "call": state["call"],
        "callReason": state["callReason"],
    });
    let ops = serde_json::json!({
        "seq": seq,
        "crons": state["crons"],
    });
    let farm = serde_json::json!({
        "seq": seq,
        "view": view,
        "effects": frame["effects"],
    });
    let bundle = serde_json::json!({
        "seq": seq,
        "board": board,
        "sessions": sessions,
        "collab": collab,
        "inbox": inbox,
        "ops": ops,
        "farm": farm,
    });

    round_value::<BoardSlice>(&board);
    round_value::<SessionsSlice>(&sessions);
    round_value::<CollabSlice>(&collab);
    round_value::<InboxSlice>(&inbox);
    round_value::<OpsSlice>(&ops);
    round_value::<FarmFrame>(&farm);
    round_value::<SliceBundle>(&bundle);
}

#[cfg(feature = "host")]
#[test]
fn host_actions_and_frames_round_trip() {
    for sample in [
        serde_json::json!({"type": "activate_project", "id": 3}),
        serde_json::json!({"type": "activate_path", "path": "/tmp/repo"}),
        serde_json::json!({"type": "stage", "paths": ["a.rs", "b/c.rs"]}),
        serde_json::json!({"type": "search", "query": "fn"}),
        serde_json::json!({"type": "search", "query": "fn", "regex": true, "case_sensitive": true}),
        serde_json::json!({"type": "applied", "topic": "rail", "rev": 4}),
        serde_json::json!({"type": "show_panel", "panel": "git"}),
        serde_json::json!({"type": "openFarm", "repo": "demo"}),
        serde_json::json!({"type": "openRepoMap"}),
        serde_json::json!({"type": "openTree"}),
        serde_json::json!({"type": "new_chat_at", "path": "/tmp/repo", "runtime": "antigravity"}),
        serde_json::json!({"type": "open_file_adjacent", "path": "src/lib.rs", "line": 42}),
        serde_json::json!({"type": "open_diff_adjacent", "path": "src/lib.rs", "staged": true}),
        serde_json::json!({"type": "bind_chat_session", "tab_id": 7, "session_id": "s1", "runtime": "claude"}),
        serde_json::json!({"type": "toggle_devtools"}),
        serde_json::json!({"type": "detach_devtools"}),
        serde_json::json!({"type": "close_devtools"}),
    ] {
        round_value::<HostAction>(&sample);
    }

    for sample in [
        serde_json::json!({"op": "host.info"}),
        serde_json::json!({"op": "host.locale", "payload": "en"}),
        serde_json::json!({"op": "host.theme", "payload": "dark"}),
        serde_json::json!({"op": "host.openFile", "payload": {"path": "src/lib.rs", "worktree": "/tmp/wt"}}),
        serde_json::json!({"op": "host.qr", "payload": {"text": "https://vibevalley.dev", "border": 2}}),
    ] {
        round_value::<HostOp>(&sample);
    }

    assert!(serde_json::from_value::<HostAction>(serde_json::json!({"type": "show_panel", "panel": "unknown"})).is_err());

    let rail = serde_json::json!({
        "projects": [{
            "id": 1,
            "name": "vibevalley",
            "path": "/tmp/vv",
            "initials": "VV",
            "active": true,
            "attention": false,
            "terminals": 2,
            "shortcut": "⌘1",
            "branch": "main",
            "mainRoot": "/tmp/vv",
            "worktrees": [{"path": "/tmp/vv", "branch": "main", "main": true}],
            "tabs": [{"id": 1, "title": "zsh", "active": true, "kind": "terminal", "running": true, "runningState": "working", "attention": false}]
        }],
        "panel": "files",
        "inspectorOpen": true
    });
    round_value::<HostRailFrame>(&rail);

    let tree = serde_json::json!({
        "root": "/tmp/vv",
        "name": "vv",
        "items": [{
            "id": "/tmp/vv/src",
            "label": "src",
            "tone": "dirty",
            "hidden": false,
            "children": [{
                "id": "/tmp/vv/src/lib.rs",
                "label": "lib.rs",
                "tone": "modified",
                "hidden": false
            }]
        }],
        "expanded": ["/tmp/vv/src"],
        "selected": "/tmp/vv/src/lib.rs"
    });
    round_value::<HostFileTreeFrame>(&tree);

    let git = serde_json::json!({
        "repo": true,
        "branch": "main",
        "head": "01234567",
        "ahead": 1,
        "behind": 0,
        "staged": [{"path": "a.rs", "code": "M", "tone": "modified"}],
        "changes": [{"path": "b.rs", "code": "?", "tone": "untracked"}],
        "conflicts": [],
        "branches": [{"name": "main", "head": true, "upstream": "origin/main"}],
        "worktrees": [{"path": "/tmp/vv", "branch": "main", "main": true, "locked": false, "current": true, "changed": 2, "conflicts": 0, "ahead": 1, "behind": 0}],
        "log": [{"id": "0123456789", "short": "0123456", "summary": "init", "author": "dev", "time": 100}],
        "busy": false
    });
    round_value::<HostGitPanelFrame>(&git);

    let palette = serde_json::json!({
        "mode": "commands",
        "query": "",
        "items": [
            {"id": "nav.issues", "label": "Issues", "detail": "/issues", "group": "Nav", "shortcut": "mod+1"},
            {"id": "file:src/lib.rs", "label": "lib.rs", "detail": "src", "indices": [0, 4]},
            {"id": "hit:/tmp/a.rs:10", "label": "fn main()", "detail": "a.rs:10", "ranges": [[0, 2]]}
        ],
        "loading": false
    });
    round_value::<HostPaletteFrame>(&palette);
}

#[test]
fn subscription_specs_and_native_attachment_permissions_stay_consistent() {
    use std::collections::BTreeSet;

    let mut names = BTreeSet::new();
    for spec in SUBSCRIPTIONS {
        assert!(names.insert(spec.name), "duplicate subscription {}", spec.name);
        assert!(!spec.can.is_empty(), "subscription {} has empty can", spec.name);
        assert_eq!(subscription(spec.name), Some(spec));
    }
    assert!(subscription("unknown.stream").is_none());

    fn assert_sub<S: Subscription>() {
        let spec = subscription(S::NAME).unwrap_or_else(|| panic!("missing SUBSCRIPTIONS entry for {}", S::NAME));
        assert_eq!(spec.can, S::CAN, "CAN mismatch for {}", S::NAME);
    }

    assert_sub::<subscriptions::ChannelFollow>();
    assert_sub::<subscriptions::ChannelReports>();
    assert_sub::<subscriptions::NoteFollow>();
    assert_sub::<subscriptions::NoteSuggestionFollow>();
    assert_sub::<subscriptions::NotePresenceFollow>();
    assert_sub::<subscriptions::SessionWatch>();
    assert_sub::<subscriptions::IssueWatch>();
    assert_eq!(SUBSCRIPTIONS.len(), 7);

    let att = endpoint("attachment.file").expect("attachment.file");
    assert_eq!(att.can, &[Caller::User, Caller::Remote]);
    assert_eq!(endpoint("media.input.file").expect("media.input.file").can, &[Caller::User]);
    assert_eq!(endpoint("media.input.uploadFile").expect("media.input.uploadFile").can, &[Caller::User]);
}

#[test]
fn remote_platforms_scopes_and_runtime_inbox_fact_round_trip() {
    assert_eq!(SCOPE_REMOTE_CLIENT, "remote:default");
    assert_eq!(SCOPE_REMOTE_MACHINE, "remote:runtime");
    assert_eq!(
        RemotePlatform::ALL.map(RemotePlatform::as_str),
        ["ios", "android", "cli", "machine", "sandbox", "other"]
    );
    for platform in RemotePlatform::ALL {
        assert_eq!(platform.as_str().parse::<RemotePlatform>(), Ok(platform));
    }
    assert!("invalid".parse::<RemotePlatform>().is_err());

    let fact = Fact::runtime_inbox_changed(42, vec![]);
    assert_eq!(fact.at(), 42);
    round_value::<Fact>(&serde_json::json!({
        "type": "runtimeInboxChanged",
        "at": 42,
        "items": [],
    }));
}

#[test]
fn machine_contract_types_runtime_ref_and_routing_fields_round_trip() {
    assert_eq!(LOCAL_MACHINE_ID, "local");
    assert_eq!(MachinePlatform::ALL.map(MachinePlatform::as_str), ["macos", "linux", "container", "other"]);
    for platform in MachinePlatform::ALL {
        assert_eq!(platform.as_str().parse::<MachinePlatform>(), Ok(platform));
    }
    assert!("windows".parse::<MachinePlatform>().is_err());

    assert_eq!(MachineStatus::ALL.map(MachineStatus::as_str), ["online", "offline", "draining"]);
    for status in MachineStatus::ALL {
        assert_eq!(status.as_str().parse::<MachineStatus>(), Ok(status));
    }
    assert!("broken".parse::<MachineStatus>().is_err());

    assert_eq!(
        MachineInputKind::ALL.map(MachineInputKind::as_str),
        ["prompt", "steer", "queue", "abort", "setConfig", "dispose"]
    );
    for kind in MachineInputKind::ALL {
        assert_eq!(kind.as_str().parse::<MachineInputKind>(), Ok(kind));
    }
    assert!("other".parse::<MachineInputKind>().is_err());

    let local_ref = RuntimeRef::local("claude");
    assert!(local_ref.is_local());
    assert_eq!(local_ref.to_string(), "local/claude");
    assert_eq!(RuntimeRef::parse("local/claude"), Ok(local_ref));
    let remote_ref = RuntimeRef::parse("gpu-1/acp:opencode").expect("parse remote ref");
    assert!(!remote_ref.is_local());
    assert_eq!(remote_ref, RuntimeRef::new("gpu-1", "acp:opencode"));
    assert_eq!(remote_ref.to_string(), "gpu-1/acp:opencode");
    assert!(matches!(RuntimeRef::parse("claude"), Err(RuntimeRefParseError::InvalidFormat(_))));
    assert!(matches!(RuntimeRef::parse("a/b/c"), Err(RuntimeRefParseError::InvalidFormat(_))));
    assert!(matches!(RuntimeRef::parse("/claude"), Err(RuntimeRefParseError::EmptyMachineId(_))));
    assert!(matches!(RuntimeRef::parse("gpu-1/"), Err(RuntimeRefParseError::EmptyRuntimeId(_))));

    // Minimal Machine JSON omits optional fields while enriched Machine preserves them.
    round_value::<Machine>(&serde_json::json!({
        "id": "local",
        "name": "Mac",
        "here": true,
        "online": true,
        "joinedAt": 100,
    }));
    round_value::<Machine>(&serde_json::json!({
        "id": "sbx-1",
        "name": "Sandbox 1",
        "here": false,
        "online": true,
        "joinedAt": 200,
        "platform": "container",
        "status": "draining",
        "ephemeral": true,
        "runtimes": ["claude", "codex"],
    }));

    let removed = Fact::machine_removed(99, "sbx-1");
    assert_eq!(removed.at(), 99);
    round_value::<Fact>(&serde_json::json!({
        "type": "machineRemoved",
        "at": 99,
        "id": "sbx-1",
    }));

    // Routing and owner fields on IssueRequest / IssueUpdate / IssueUpdateInput serialize cleanly.
    round_value::<IssueRequest>(&serde_json::json!({
        "title": "Run on GPU",
        "machineId": "gpu-1",
        "owner": { "kind": "user", "id": "self" },
    }));
    round_value::<IssueUpdate>(&serde_json::json!({
        "machineId": "gpu-1",
        "owner": { "kind": "agent", "id": "arch" },
    }));
    round_value::<IssueUpdateInput>(&serde_json::json!({
        "id": "i1",
        "machineId": "gpu-1",
        "owner": { "kind": "user", "id": "" },
    }));

    let ep = endpoint("machine.list").expect("machine.list endpoint");
    assert_eq!(ep.module, "machine");
    assert_eq!(ep.can, &[Caller::User, Caller::Remote]);
    assert_eq!(ep.input, None);
    assert_eq!(ep.result, Some("Vec<MachineInfo>"));
    assert_eq!(<ops::MachineList as Op>::NAME, "machine.list");
}
