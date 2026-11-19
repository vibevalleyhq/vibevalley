use serde_json::json;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::Notify, time};
use vibevalley_chord::{
    delta::{Op, Snapshot},
    link::{Client, Endpoint, Options, Principal, RpcError},
    watch::Document,
    ws,
};

#[path = "interop/process.rs"]
mod process;
use process::Peer;

fn build_peer() -> (tempfile::TempDir, PathBuf) {
    let reference = std::env::var("VIBEVALLEY_GO_SOURCE").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("peer");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/interop");
    assert!(
        Command::new("go")
            .env_remove("GOROOT")
            .env("CGO_ENABLED", "0")
            .current_dir(reference)
            .arg("build")
            .args(["-o"])
            .arg(&bin)
            .arg(source.join("peer.go"))
            .arg(source.join("server.go"))
            .arg(source.join("product.go"))
            .status()
            .unwrap()
            .success()
    );

    (dir, bin)
}

#[tokio::test]
#[ignore = "set VIBEVALLEY_GO_SOURCE to the Go reference checkout"]
async fn go_client_rust_server_bidirectional_rpc_and_watch() {
    let (_dir, bin) = build_peer();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/chord/ws", listener.local_addr().unwrap());
    let mut peer = Peer(Command::new(bin).arg(url).spawn().unwrap());
    let exercise = async {
        let (stream, _) = listener.accept().await.unwrap();
        let transport = ws::accept(stream).await.unwrap();
        let endpoint = Endpoint::default();
        let doc = Document::new(Snapshot::new(json!({"count":7})));
        let ready = Arc::new(Notify::new());
        let finish = Arc::new(Notify::new());
        let entered = Arc::new(Notify::new());
        let cancelled = Arc::new(Notify::new());
        endpoint.handle("rust.block", {
            let entered = entered.clone();
            let cancelled = cancelled.clone();
            move |_, _| {
                let (entered, cancelled) = (entered.clone(), Cancelled(cancelled.clone()));
                async move {
                    entered.notify_one();
                    let _on_drop = cancelled;
                    std::future::pending().await
                }
            }
        });
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
        entered.notified().await;
        link.call("go.entered", json!(null), None).await.unwrap();
        cancelled.notified().await;
        ready.notified().await;
        finish.notify_one();
        link.closed().await;
    };
    time::timeout(Duration::from_secs(20), exercise).await.expect("Go/Rust peer exchange timed out");
    assert!(peer.0.wait().unwrap().success());
}

struct Cancelled(Arc<Notify>);
impl Drop for Cancelled {
    fn drop(&mut self) {
        self.0.notify_one()
    }
}

#[tokio::test]
#[ignore = "set VIBEVALLEY_GO_SOURCE to the Go reference checkout"]
async fn rust_client_go_server_cancel_and_resume_watches_over_websocket() {
    let (_dir, bin) = build_peer();
    let mut server = Peer(Command::new(bin).arg("serve").stdout(Stdio::piped()).spawn().unwrap());
    let url = server.ready_line().trim().to_owned();
    time::timeout(Duration::from_secs(15), async {
        let endpoint = Endpoint::default();
        let entered = Arc::new(Notify::new());
        endpoint.handle("rust.entered", {
            let entered = entered.clone();
            move |_, _| {
                let entered = entered.clone();
                async move {
                    entered.notify_one();
                    Ok(json!(null))
                }
            }
        });
        endpoint.handle("rust.callback", |principal, v| async move { Ok(json!([principal.id, v])) });
        let mut options = Options::new(Principal::user_device("rust-client"));
        options.heartbeat = Duration::from_millis(20);
        options.heartbeat_timeout = Duration::from_secs(5);
        options.authenticate = Some(Arc::new(|p| {
            if p.id == "go-reference" && p.kind == "machine_node" {
                Ok(())
            } else {
                Err(RpcError::new("unauthorized", "unexpected peer"))
            }
        }));
        let client = Client::connect(endpoint, options, move || {
            let url = url.clone();
            async move { ws::dial(url).await.map(|(tr, _)| tr) }
        })
        .await
        .unwrap();
        assert_eq!(
            client.call("go.reverse", json!({"from":"Rust"}), None).await.unwrap(),
            json!(["go-reference",{"from":"Rust"}])
        );
        assert_eq!(client.call("go.heartbeat", json!(null), None).await.unwrap(), true);
        let connection = client.active_link().unwrap();
        let long = tokio::spawn(async move { connection.call("go.block", json!(null), None).await });
        entered.notified().await;
        long.abort();
        assert!(long.await.unwrap_err().is_cancelled());
        assert_eq!(client.call("go.cancelled", json!(null), None).await.unwrap(), true);
        let mut watch = client.watch("go.doc");
        assert_eq!(watch.recv().await.unwrap().rev, 1);
        let through = client.call("go.advance", json!(12), None).await.unwrap().as_i64().unwrap();
        while watch.revision() < through {
            tokio::task::yield_now().await;
        }
        let burst = watch.recv().await.unwrap();
        assert_eq!(burst.rev, 13);
        assert_eq!(json!(burst.snapshot), json!({"count":12}));
        assert_eq!(json!(burst.ops), json!([["r", ["count"], 12]]));
        for (steps, rev, ops) in [(1, 14, json!([["r", ["count"], 13]])), (4, 18, json!([["r",{"count":17}]]))] {
            client.call("go.advanceOnDisconnect", json!(steps), None).await.unwrap();
            client.active_link().unwrap().close();
            let next = watch.recv().await.unwrap();
            assert_eq!(next.rev, rev);
            assert_eq!(json!(next.ops), ops);
            assert_eq!(json!(next.snapshot), json!({"count":rev-1}));
        }
        client.call("go.retire", json!(null), None).await.unwrap();
        let retired = watch.recv().await.unwrap();
        assert!(retired.retired);
        assert_eq!(retired.rev, 18);
        client.call("go.rebuild", json!(null), None).await.unwrap();
        let rebuilt = watch.recv().await.unwrap();
        assert!(!rebuilt.retired);
        assert_eq!(rebuilt.rev, 19);
        assert_eq!(json!(rebuilt.ops), json!([["r",{"count":0}]]));
        client.call("go.overflow", json!(null), None).await.unwrap();
        let overflow = watch.recv().await.unwrap();
        assert!(overflow.overflow);
        assert_eq!(overflow.rev, 20);
        assert_eq!(json!(overflow.ops), json!([["r",{"count":0,"a":1,"b":1,"c":1}]]));
        client.close().await;
    })
    .await
    .expect("Rust/Go WebSocket watch or RPC timed out");
}
