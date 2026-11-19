use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Notify, time};
use vibevalley_chord::{
    delta::{Op, Snapshot},
    link::{Client, Endpoint, Error, Options, Principal, RpcError, Transport},
    watch::Document,
    ws,
};

fn options(id: &str) -> Options {
    Options::new(Principal::user_device(id))
}

async fn accept_socket(listener: &TcpListener) -> Transport {
    let (stream, _) = listener.accept().await.unwrap();
    ws::accept(stream).await.unwrap()
}

#[tokio::test]
async fn mutual_auth_and_rejection() {
    let endpoint = Endpoint::default();
    let (a, b) = Transport::pipe(1);
    let mut opts = options("server");
    opts.authenticate = Some(Arc::new(|peer| Err(RpcError::new("unauthorized", peer.id.clone()))));
    let (l, r) = tokio::join!(endpoint.connect(a, opts), endpoint.connect(b, options("unexpected")));
    for result in [l, r] {
        assert!(matches!(result,Err(Error::Rpc(RpcError{code,..})) if code=="unauthorized"));
    }
}

#[tokio::test]
async fn rpc_watch_chunking_and_cancel_over_websocket() {
    let server = Endpoint::default();
    let client = Endpoint::default();
    server.handle("echo", |p, v| async move { Ok(json!([p.id, v])) });
    client.handle("callback", |p, _| async move { Ok(json!(p.id)) });
    let entered = Arc::new(Notify::new());
    let cancelled = Arc::new(Notify::new());
    struct OnCancel(Arc<Notify>);
    impl Drop for OnCancel {
        fn drop(&mut self) {
            self.0.notify_one();
        }
    }
    server.handle("wait", {
        let entered = entered.clone();
        let cancelled = cancelled.clone();
        move |_, _| {
            let entered = entered.clone();
            let on_cancel = OnCancel(cancelled.clone());
            async move {
                let _guard = on_cancel;
                entered.notify_one();
                std::future::pending().await
            }
        }
    });
    let doc = Document::new(Snapshot::new(json!({"text":""})));
    server.publish("space", doc.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (server_socket, dialled) = tokio::join!(accept_socket(&listener), ws::dial(url));
    let (client_socket, _) = dialled.unwrap();
    let mut small = options("client");
    small.max_frame_bytes = 768;
    let (l, r) = tokio::join!(server.connect(server_socket, options("server")), client.connect(client_socket, small));
    let (l, r) = (l.unwrap(), r.unwrap());
    let payload = json!("abc".repeat(100_000));
    let (big, small) = tokio::join!(r.call("echo", payload.clone(), None), l.call("callback", json!(null), None));
    assert_eq!(big.unwrap(), json!(["client", payload]));
    assert_eq!(small.unwrap(), "server");
    let mut watch = r.watch("space", 0, None).unwrap();
    assert_eq!(watch.recv().await.unwrap().rev, 1);
    doc.mutate(|draft| draft.apply(Op::AppendText(vec!["text".into()], "hello".into()))).unwrap();
    let event = watch.recv().await.unwrap();
    assert_eq!(json!(event.snapshot), json!({"text":"hello"}));
    assert!(matches!(r.watch("missing",0,None).unwrap().recv().await,Err(Error::Rpc(e)) if e.code=="not_found"));
    let waiter = tokio::spawn({
        let r = r.clone();
        async move { r.call("wait", json!(null), None).await }
    });
    time::timeout(Duration::from_secs(2), entered.notified()).await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    time::timeout(Duration::from_secs(2), cancelled.notified()).await.unwrap();
    assert!(matches!(
        r.call("wait", json!(null), Some(Duration::from_millis(25))).await,
        Err(Error::Deadline) | Err(Error::Rpc(_))
    ));
    l.close();
    assert_eq!(l.closed().await, Error::Closed);
    assert_eq!(watch.recv().await.unwrap_err(), r.closed().await);
}

#[tokio::test]
async fn reconnect_resumes_live_watch_over_websocket() {
    let server = Endpoint::default();
    let doc = Document::with_limits(Snapshot::new(json!({"count":1})), 1, 8);
    server.publish("space", doc.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let accept_link = || async { server.connect(accept_socket(&listener).await, options("server")).await.unwrap() };
    let connect = Client::connect(Endpoint::default(), options("client"), move || {
        let url = url.clone();
        async move { ws::dial(url).await.map(|(tr, _)| tr) }
    });
    let (mut link, client) = tokio::join!(accept_link(), connect);
    let client = client.unwrap();
    let mut sub = client.watch("space");
    assert_eq!(sub.recv().await.unwrap().rev, 1);
    for (missed, expected_ops) in [(2..=2, json!([["r", ["count"], 2]])), (3..=4, json!([["r", {"count":4}]]))] {
        link.close();
        link.closed().await;
        let latest = *missed.end();
        for count in missed {
            doc.mutate(|draft| draft.apply(Op::Replace(vec!["count".into()], json!(count)))).unwrap();
        }
        link = time::timeout(Duration::from_secs(5), accept_link()).await.unwrap();
        let next = time::timeout(Duration::from_secs(5), sub.recv()).await.unwrap().unwrap();
        assert_eq!(next.rev, latest);
        assert_eq!(json!(next.snapshot), json!({"count":latest}));
        assert_eq!(json!(next.ops), expected_ops);
    }
    client.close().await;
    assert_eq!(link.closed().await, Error::Closed);
}

#[tokio::test]
async fn heartbeat_closes_unresponsive_link_and_fails_calls() {
    let endpoint = Endpoint::default();
    let (a, b) = Transport::pipe(8);
    let mut opts = options("server");
    opts.heartbeat = Duration::from_millis(10);
    opts.heartbeat_timeout = Duration::from_millis(30);
    let (link, ()) = tokio::join!(endpoint.connect(a, opts), async {
        let _ = b.recv().await.unwrap();
        b.send(br#"{"kind":"hello","principal":{"kind":"user_device","id":"noop"}}"#.to_vec())
            .await
            .unwrap();
        b.send(br#"{"kind":"hello_ack"}"#.to_vec()).await.unwrap();
        let _ = b.recv().await.unwrap();
    });
    let link = link.unwrap();
    let (_, result) = tokio::join!(link.closed(), link.call("stall", json!(null), None));
    assert_eq!(result, Err(Error::Heartbeat));
}

#[tokio::test]
async fn thousand_concurrent_calls_and_two_hundred_open_watches() {
    let a = Endpoint::default();
    let b = Endpoint::default();
    for service in [&a, &b] {
        service.handle("identity", |_, v| async move { Ok(v) });
    }
    let docs: Vec<_> = (0..200)
        .map(|i| {
            let doc = Document::new(Snapshot::new(json!(i)));
            a.publish(i.to_string(), doc.clone());
            doc
        })
        .collect();
    let (left, right) = Transport::pipe(8);
    let (left, right) = tokio::join!(a.connect(left, options("a")), b.connect(right, options("b")));
    let (a, b) = (left.unwrap(), right.unwrap());
    let mut subs: Vec<_> = (0..docs.len()).map(|i| b.watch(i.to_string(), 0, None).unwrap()).collect();
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..1000 {
        let link = if i % 2 == 0 { a.clone() } else { b.clone() };
        tasks.spawn(async move {
            assert_eq!(link.call("identity", json!(i), Some(Duration::from_secs(10))).await.unwrap(), i);
        });
    }
    for (i, sub) in subs.iter_mut().enumerate() {
        assert_eq!(json!(sub.recv().await.unwrap().snapshot), i);
        docs[i].rebuild(Snapshot::new(json!([i])));
    }
    for (i, sub) in subs.iter_mut().enumerate() {
        assert_eq!(json!(sub.recv().await.unwrap().snapshot), json!([i]));
    }
    while let Some(task) = tasks.join_next().await {
        task.unwrap();
    }
    drop(subs);
    a.close();
    b.close();
    time::timeout(Duration::from_secs(3), async {
        tokio::join!(a.closed(), b.closed());
    })
    .await
    .unwrap();
}

#[tokio::test]
#[allow(clippy::result_large_err, reason = "the WebSocket handshake callback returns an HTTP rejection response")]
async fn fragmented_utf8_and_interleaved_ping_on_upgraded_socket() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::{
        Message,
        client::IntoClientRequest,
        protocol::frame::{
            Frame,
            coding::{Data, OpCode},
        },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut request = format!("ws://{}", listener.local_addr().unwrap()).into_client_request().unwrap();
    request.headers_mut().insert("sec-websocket-protocol", "chord.v1".parse().unwrap());
    let accept = async {
        let (stream, _) = listener.accept().await.unwrap();
        ws::accept_with(
            stream,
            |req: &Request, mut rsp: Response| {
                assert_eq!(req.headers()["sec-websocket-protocol"], "chord.v1");
                rsp.headers_mut().insert("sec-websocket-protocol", "chord.v1".parse().unwrap());
                Ok(rsp)
            },
            32,
        )
        .await
        .unwrap()
    };
    let (server, connected) = tokio::join!(accept, tokio_tungstenite::connect_async(request));
    let (mut client, response) = connected.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "chord.v1");
    for packet in [
        Message::Frame(Frame::message(vec![0xe7], OpCode::Data(Data::Text), false)),
        Message::Ping(vec![9].into()),
        Message::Frame(Frame::message(vec![0x94, 0xb0], OpCode::Data(Data::Continue), true)),
    ] {
        client.send(packet).await.unwrap();
    }
    assert_eq!(time::timeout(Duration::from_secs(2), server.recv()).await.unwrap().unwrap(), "田".as_bytes());
    assert_eq!(client.next().await.unwrap().unwrap(), Message::Pong(vec![9].into()));
    assert_eq!(server.send(vec![0; 33]).await, Err(Error::TooLarge));
    client.send(Message::Binary(vec![1; 33].into())).await.unwrap();
    assert_eq!(server.recv().await, Err(Error::TooLarge));
}
