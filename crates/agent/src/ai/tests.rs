use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use axum::routing::get;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::BrainError;
use crate::ai::ModelClient;
use crate::ai::models::{DEFAULT_MODEL, catalog, charge_usd, deepseek_price, find_model};
use crate::ai::providers::deepseek::{OpenAiClient, request_body};
use crate::ai::retry::{RetryPolicy, parse_retry_after};
use crate::ai::stream::{CancelHandle, CancelToken, fold_stream};
use crate::ai::types::{ChatRequest, Delta, FinishReason, Message, ResponseFormat, Role, ToolCall, Usage};

async fn spawn_mock(router: Router) -> (SocketAddr, DropGuard) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let guard = cancel.clone().drop_guard();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
    });
    (addr, guard)
}

#[tokio::test]
async fn retry_policy_retries_429_with_retry_after_header_and_succeeds() {
    let hits = Arc::new(AtomicUsize::new(0));
    let server_hits = hits.clone();
    let app = Router::new().fallback(move || {
        let n = server_hits.fetch_add(1, Ordering::SeqCst);
        async move {
            if n == 0 {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(header::RETRY_AFTER, "1"), (header::CONTENT_TYPE, "application/json")],
                    r#"{"error":{"message":"rate limited"}}"#,
                )
                    .into_response()
            } else {
                let body = concat!(
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n",
                    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n",
                    "data: [DONE]\n\n"
                );
                (StatusCode::OK, [(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }
    });
    let (addr, _guard) = spawn_mock(app).await;

    let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-test".into())).with_retry(RetryPolicy {
        max_retries: 2,
        initial_backoff: Duration::from_millis(10),
        max_backoff: Duration::from_secs(2),
    });
    let req = ChatRequest {
        model: DEFAULT_MODEL.into(),
        messages: vec![Message::user("ping")],
        ..Default::default()
    };
    let start = Instant::now();
    let completion = client.complete(&req, &mut |_| {}).await.unwrap();
    assert!(start.elapsed() >= Duration::from_millis(900), "expected Retry-After: 1s to be honored");
    assert_eq!(completion.message.content.as_deref(), Some("ok"));
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn mid_stream_cancellation_returns_under_500ms() {
    let stream_cancel = CancellationToken::new();
    let stream_cancel_for_route = stream_cancel.clone();
    let app = Router::new().fallback(move || {
        let cancel = stream_cancel_for_route.clone();
        let stream = futures_util::stream::unfold((true, cancel), |(first, cancel)| async move {
            if first {
                Some((
                    Ok::<_, Infallible>(Event::default().data(r#"{"choices":[{"index":0,"delta":{"content":"hello "}}]}"#)),
                    (false, cancel),
                ))
            } else {
                cancel.cancelled().await;
                None
            }
        });
        async move { Sse::new(stream) }
    });
    let (addr, _guard) = spawn_mock(app).await;
    let _stream_guard = stream_cancel.drop_guard();

    let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-test".into())).with_retry(RetryPolicy::none());
    let handle = Arc::new(CancelHandle::new());
    let token = handle.token();
    let req = ChatRequest {
        model: DEFAULT_MODEL.into(),
        messages: vec![Message::user("stream")],
        ..Default::default()
    };
    let mut cancelled_at: Option<Instant> = None;
    let err = client
        .complete_cancellable(&req, &token, &mut |delta| {
            if matches!(delta, Delta::Text(_)) && cancelled_at.is_none() {
                cancelled_at = Some(Instant::now());
                handle.cancel();
            }
        })
        .await
        .unwrap_err();
    assert!(matches!(err, BrainError::Cancelled), "expected Cancelled, got {err:?}");
    let elapsed = cancelled_at.expect("received first chunk").elapsed();
    assert!(elapsed < Duration::from_millis(500), "cancellation took {elapsed:?}");
}

#[tokio::test]
async fn cancel_aborts_retry_backoff_immediately() {
    let handle = Arc::new(CancelHandle::new());
    let cancel_after_hit = handle.clone();
    let app = Router::new().fallback(move || {
        let cancel_after_hit = cancel_after_hit.clone();
        async move {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(40)).await;
                cancel_after_hit.cancel();
            });
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CONTENT_TYPE, "application/json")],
                r#"{"error":{"message":"unavailable"}}"#,
            )
        }
    });
    let (addr, _guard) = spawn_mock(app).await;

    let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-test".into())).with_retry(RetryPolicy {
        max_retries: 3,
        initial_backoff: Duration::from_secs(10),
        max_backoff: Duration::from_secs(10),
    });
    let req = ChatRequest {
        model: DEFAULT_MODEL.into(),
        messages: vec![Message::user("hi")],
        ..Default::default()
    };
    let start = Instant::now();
    let err = client.complete_cancellable(&req, &handle.token(), &mut |_| {}).await.unwrap_err();
    assert!(matches!(err, BrainError::Cancelled), "expected Cancelled, got {err:?}");
    assert!(start.elapsed() < Duration::from_millis(500));
}

#[tokio::test]
async fn fetch_balance_parses_user_balance_endpoint() {
    let seen_auth = Arc::new(Mutex::new(None::<String>));
    let seen_for_route = seen_auth.clone();
    let app = Router::new().route(
        "/user/balance",
        get(move |headers: HeaderMap| {
            let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(ToString::to_string);
            *seen_for_route.lock() = auth;
            async move {
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json")],
                    r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"42.50","granted_balance":"2.50","topped_up_balance":"40.00"}]}"#,
                )
            }
        }),
    );
    let (addr, _guard) = spawn_mock(app).await;

    let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-bal".into())).with_retry(RetryPolicy::none());
    let bal = client.fetch_balance().await.unwrap();
    assert_eq!(seen_auth.lock().as_deref(), Some("Bearer sk-bal"));
    assert!(bal.is_available);
    assert_eq!(bal.balance_infos.len(), 1);
    assert_eq!(bal.balance_infos[0].currency, "CNY");
    assert!((bal.balance_infos[0].total_balance - 42.50).abs() < 1e-6);
    assert!((bal.balance_infos[0].granted_balance - 2.50).abs() < 1e-6);
    assert!((bal.balance_infos[0].topped_up_balance - 40.00).abs() < 1e-6);
}

#[test]
fn request_body_serializes_response_format_max_tokens_temperature_and_effort() {
    let req = ChatRequest {
        model: "deepseek-v4-pro".into(),
        messages: vec![
            Message::system("sys"),
            Message::user("hi"),
            Message {
                role: Role::Assistant,
                content: None,
                reasoning: Some("plan".into()),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    arguments: r#"{"path":"a.rs"}"#.into(),
                }],
                tool_call_id: None,
            },
        ],
        tools: vec![],
        effort: Some("max".into()),
        response_format: Some(ResponseFormat::JsonObject),
        max_tokens: Some(1024),
        temperature: Some(0.25),
    };
    let body = request_body(&req);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["reasoning_effort"], "max");
    assert_eq!(body["response_format"], json!({"type": "json_object"}));
    assert_eq!(body["max_tokens"], 1024);
    assert_eq!(body["temperature"], 0.25);
    assert_eq!(body["messages"][2]["content"], serde_json::Value::Null);
    assert_eq!(body["messages"][2]["reasoning_content"], "plan");

    let text_req = ChatRequest {
        response_format: Some(ResponseFormat::Text),
        ..Default::default()
    };
    assert_eq!(request_body(&text_req)["response_format"], json!({"type": "text"}));
}

#[tokio::test]
async fn catalog_models_pricing_and_stream_cancel() {
    assert_eq!(DEFAULT_MODEL, "deepseek-flash");
    let specs = catalog();
    assert_eq!(specs.len(), 4);
    for id in ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"] {
        let spec = find_model(id).unwrap();
        assert_eq!(spec.context_window, 128_000);
    }
    assert!(find_model("deepseek-flash").unwrap().is_default);
    assert_eq!(find_model("deepseek-flash").unwrap().effort_levels, ["high", "max"]);
    assert_eq!(find_model("").unwrap().id, DEFAULT_MODEL);
    let price = deepseek_price("deepseek-official/deepseek-flash").unwrap();
    let cost = charge_usd(
        price,
        Usage {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 500_000,
        },
    );
    assert!((cost - (0.5 * 0.14 + 0.28 + 0.5 * 0.028)).abs() < 1e-9);
    assert_eq!(parse_retry_after(" 3 "), Some(Duration::from_secs(3)));

    let handle = CancelHandle::new();
    handle.cancel();
    assert!(handle.token().is_cancelled());
    let err = fold_stream(std::io::Cursor::new("data: [DONE]\n"), &handle.token(), &mut |_| {}).unwrap_err();
    assert!(matches!(err, BrainError::Cancelled));
    handle.reset();
    assert!(!handle.token().is_cancelled());
    let ok = fold_stream(
        std::io::Cursor::new("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n"),
        &CancelToken::never(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(ok.finish, FinishReason::Stop);
    assert_eq!(ok.message.content.as_deref(), Some("hi"));

    let no_key = OpenAiClient::new("http://127.0.0.1:1", || None)
        .complete(&ChatRequest::default(), &mut |_| {})
        .await
        .unwrap_err();
    assert!(matches!(no_key, BrainError::NoKey));
}

#[test]
fn retry_policy_backoff_doubles_caps_and_honors_retry_after() {
    let policy = RetryPolicy::default();
    let seq: Vec<Duration> = policy.backoff().collect();
    assert_eq!(seq, vec![Duration::from_millis(250), Duration::from_millis(500), Duration::from_secs(1)]);
    assert_eq!(policy.delay_for(0, None), Duration::from_millis(250));
    assert_eq!(policy.delay_for(1, None), Duration::from_millis(500));
    assert_eq!(policy.delay_for(4, None), Duration::from_secs(4));
    assert_eq!(policy.delay_for(100, None), Duration::from_secs(4));
    assert_eq!(policy.delay_for(0, Some(Duration::from_secs(120))), Duration::from_secs(60));
    assert_eq!(RetryPolicy::none().backoff().next(), None);
}

#[tokio::test]
async fn deepseek_https_client_initializes_rustls_platform_verifier_without_webpki() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let _guard = cancel.clone().drop_guard();
    tokio::spawn(async move {
        tokio::select! {
            _ = cancel.cancelled() => {}
            _ = listener.accept() => {}
        }
    });

    let err = OpenAiClient::new(format!("https://{addr}"), || Some("sk-tls-test".into()))
        .with_retry(RetryPolicy::none())
        .fetch_balance()
        .await
        .unwrap_err();
    match err {
        BrainError::Network(msg) => {
            assert!(
                !msg.contains("requires feature") && !msg.contains("CryptoProvider") && !msg.contains("WebPki"),
                "HTTPS must initialize rustls + platform verifier cleanly, got: {msg}"
            );
        }
        other => panic!("expected network EOF during TLS handshake against closed socket, got: {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn complete_cancellable_async_honors_long_retry_after_on_virtual_clock() {
    let hits = Arc::new(AtomicUsize::new(0));
    let server_hits = hits.clone();
    let app = Router::new().fallback(move || {
        let n = server_hits.fetch_add(1, Ordering::SeqCst);
        async move {
            if n == 0 {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(header::RETRY_AFTER, "45"), (header::CONTENT_TYPE, "application/json")],
                    r#"{"error":{"message":"slow down"}}"#,
                )
                    .into_response()
            } else {
                let body = concat!(
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"virtual-ok\"}}]}\n\n",
                    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\n",
                    "data: [DONE]\n\n"
                );
                (StatusCode::OK, [(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }
    });

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_cancel = CancellationToken::new();
    let _server_guard = server_cancel.clone().drop_guard();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(server_cancel.cancelled_owned()).await;
    });

    let wall = std::time::Instant::now();
    let t0 = tokio::time::Instant::now();
    let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-test".into())).with_retry(RetryPolicy {
        max_retries: 2,
        initial_backoff: Duration::from_secs(1),
        max_backoff: Duration::from_secs(10),
    });
    let req = ChatRequest {
        model: DEFAULT_MODEL.into(),
        messages: vec![Message::user("ping")],
        ..Default::default()
    };
    let cancel = CancelToken::never();
    let mut on_delta = |_| {};
    let (res, ()) = tokio::join!(client.complete_cancellable_async(&req, &cancel, &mut on_delta), async {
        while hits.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        // Wait until the 45s retry timer is armed on the paused runtime.
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "must not retry before Retry-After: 45s");
        tokio::time::advance(Duration::from_secs(43)).await;
        tokio::task::yield_now().await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "must still be waiting at 44s");
        tokio::time::advance(Duration::from_secs(1)).await;
    });

    let completion = res.unwrap();
    assert_eq!(completion.message.content.as_deref(), Some("virtual-ok"));
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    assert!(t0.elapsed() >= Duration::from_secs(45), "expected >= 45s virtual delay, got {:?}", t0.elapsed());
    assert!(wall.elapsed() < Duration::from_secs(1), "virtual retry took {:?}", wall.elapsed());
}
