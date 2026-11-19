use serde_json::{Value, json};
use std::{
    process::{Command, Stdio},
    time::Duration,
};
use vibevalley_chord::{
    link::{Endpoint, Options, Principal},
    ws,
};

#[path = "interop/process.rs"]
mod process;
use process::Peer;

#[tokio::test]
#[ignore = "run tests/interop/verify.sh --app to build the pinned Go server"]
async fn rust_client_observes_its_issue_write_on_the_go_control_plane() {
    let binary = std::env::var_os("VIBEVALLEY_GO_SERVER").unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut process = Peer(
        Command::new(binary)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("VIBEVALLEY_HOME", temp.path())
            .env("VIBEVALLEY_TEST_RUNTIMES", "1")
            .current_dir(temp.path())
            .args([
                "--addr",
                "127.0.0.1:0",
                "--preview-addr",
                "disabled",
                "--db",
                "isolated.db",
                "--work-root",
                "work",
                "--ready-json",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let ready = process.ready_line();
    let ready: Value = serde_json::from_str(&ready).unwrap();
    let addr = ready["addr"].as_str().unwrap();
    assert!(addr.starts_with("127.0.0.1:"));
    tokio::time::timeout(Duration::from_secs(15), async {
        let (transport, _) = ws::dial(format!("ws://{addr}/chord/ws")).await.unwrap();
        let link = Endpoint::default()
            .connect(transport, Options::new(Principal::user_device("rust-go-acceptance")))
            .await
            .unwrap();
        assert_eq!(link.peer().id, "vibe-server");
        let pong = link.call("health.ping", json!({}), None).await.unwrap();
        assert_eq!(pong["ok"], true);
        let mut space = link.watch("space", 0, None).unwrap();
        let initial = space.recv().await.unwrap().rev;
        let created = link
            .call(
                "issue.create",
                json!({"issue":{"id":"probe-issue","title":"Interop","repoId":"repo-1"},"dispatch":false}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(created["issue"]["id"], "probe-issue");
        let contains = |rows: &Value| {
            rows.as_array()
                .is_some_and(|items| items.iter().any(|v| v["id"] == "probe-issue" && v["title"] == "Interop"))
        };
        let updated = loop {
            let e = space.recv().await.unwrap();
            if contains(&json!(e.snapshot)["issues"]) {
                break e;
            }
        };
        assert!(updated.rev > initial && !updated.ops.is_empty());
        assert!(contains(&link.call("issue.list", json!({"statuses":["draft"]}), None).await.unwrap()));
        let snapshot = link.call("space.snapshot", json!(null), None).await.unwrap();
        assert!(contains(&snapshot["view"]["issues"]));
        assert!(snapshot["rev"].as_i64().unwrap() >= updated.rev);
        link.close();
        link.closed().await;
    })
    .await
    .expect("Go control-plane update timed out");
}
