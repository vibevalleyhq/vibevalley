use serde_json::json;
use std::{path::Path, process::Command, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Notify, time};
use vibevalley_chord::{
    delta::{Op, Snapshot},
    link::{Endpoint, Options, Principal},
    watch::Document,
    ws,
};

#[tokio::test]
#[ignore = "set VIBEVALLEY_GO_SOURCE to the Go reference checkout"]
async fn go_client_rust_server_bidirectional_rpc_and_watch() {
    let reference = std::env::var("VIBEVALLEY_GO_SOURCE").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("peer");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/interop/peer.go");
    assert!(
        Command::new("go")
            .env_remove("GOROOT")
            .env("CGO_ENABLED", "0")
            .current_dir(reference)
            .arg("build")
            .args(["-o"])
            .arg(&bin)
            .arg(source)
            .status()
            .unwrap()
            .success()
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/chord/ws", listener.local_addr().unwrap());
    let mut peer = Command::new(bin).arg(url).spawn().unwrap();
    let exercise = async {
        let (stream, _) = listener.accept().await.unwrap();
        let transport = ws::accept(stream).await.unwrap();
        let endpoint = Endpoint::default();
        let doc = Document::new(Snapshot::new(json!({"count":7})));
        let ready = Arc::new(Notify::new());
        let finish = Arc::new(Notify::new());
        endpoint.publish("rust.doc", doc.clone());
        endpoint.handle("rust.echo", |p, v| async move {
            assert_eq!(p.id, "go-oracle");
            Ok(v)
        });
        endpoint.handle("rust.next", move |_, _| {
            let doc = doc.clone();
            async move {
                doc.mutate(|d| d.apply(Op::Replace(vec!["count".into()], json!(8)))).unwrap();
                Ok(json!(null))
            }
        });
        endpoint.handle("rust.ready", {
            let ready = ready.clone();
            let finish = finish.clone();
            move |_, _| {
                let ready = ready.clone();
                let finish = finish.clone();
                async move {
                    ready.notify_one();
                    finish.notified().await;
                    Ok(json!(true))
                }
            }
        });
        let link = endpoint.connect(transport, Options::new(Principal::user_device("rust"))).await.unwrap();
        assert_eq!(link.peer().kind, "machine_node");
        let big = "田".repeat(150_000);
        assert_eq!(link.call("go.echo", json!(big), None).await.unwrap(), json!({"peer":"rust","data":big}));
        let mut sub = link.watch("go.doc", 0, None).unwrap();
        assert_eq!(json!(sub.recv().await.unwrap().snapshot), json!({"go":"初始"}));
        ready.notified().await;
        finish.notify_one();
        link.closed().await;
    };
    if time::timeout(Duration::from_secs(20), exercise).await.is_err() {
        let _ = peer.kill();
        let _ = peer.wait();
        panic!("Go/Rust peer exchange timed out");
    }
    assert!(peer.wait().unwrap().success());
}
