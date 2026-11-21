use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::agent::BrainError;
use crate::agent::ai::ModelClient;
use crate::agent::ai::models::{DEFAULT_MODEL, catalog, charge_usd, deepseek_price, find_model};
use crate::agent::ai::providers::deepseek::{OpenAiClient, request_body};
use crate::agent::ai::retry::{RetryPolicy, parse_retry_after};
use crate::agent::ai::stream::{CancelHandle, CancelToken, fold_stream};
use crate::agent::ai::types::{ChatRequest, Delta, FinishReason, Message, ResponseFormat, Role, ToolCall, Usage};

fn read_http_request(stream: &std::net::TcpStream) -> (String, Vec<(String, String)>) {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    let _ = reader.read_line(&mut request_line);
    let mut headers = vec![];
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap_or(0);
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" {
                content_len = val.parse().unwrap_or(0);
            }
            headers.push((key, val));
        }
    }
    if content_len > 0 {
        let mut body = vec![0u8; content_len];
        let _ = std::io::Read::read_exact(&mut reader, &mut body);
    }
    (request_line, headers)
}

#[test]
fn retry_policy_retries_429_with_retry_after_header_and_succeeds() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let server_hits = hits.clone();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = read_http_request(&sock);
            let n = server_hits.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                let body = r#"{"error":{"message":"rate limited"}}"#;
                let resp = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                sock.write_all(resp.as_bytes()).unwrap();
            } else {
                let body = concat!(
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n",
                    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n",
                    "data: [DONE]\n\n"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                sock.write_all(resp.as_bytes()).unwrap();
            }
            sock.flush().unwrap();
        }
    });

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
    let completion = client.complete(&req, &mut |_| {}).unwrap();
    assert!(start.elapsed() >= Duration::from_millis(900), "expected Retry-After: 1s to be honored");
    assert_eq!(completion.message.content.as_deref(), Some("ok"));
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    server.join().unwrap();
}

#[test]
fn mid_stream_cancellation_returns_under_500ms() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (release_tx, release_rx) = flume::bounded::<()>(1);
    let server = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let _ = read_http_request(&sock);
        sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
            .unwrap();
        let chunk = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello \"}}]}\n\n";
        let frame = format!("{:x}\r\n{}\r\n", chunk.len(), chunk);
        sock.write_all(frame.as_bytes()).unwrap();
        sock.flush().unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
    });

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
        .unwrap_err();
    assert!(matches!(err, BrainError::Cancelled), "expected Cancelled, got {err:?}");
    let elapsed = cancelled_at.expect("received first chunk").elapsed();
    assert!(elapsed < Duration::from_millis(500), "cancellation took {elapsed:?}");
    let _ = release_tx.send(());
    server.join().unwrap();
}

#[test]
fn cancel_aborts_retry_backoff_immediately() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = Arc::new(CancelHandle::new());
    let cancel_after_hit = handle.clone();
    let server = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let _ = read_http_request(&sock);
        let body = r#"{"error":{"message":"unavailable"}}"#;
        let resp = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        sock.write_all(resp.as_bytes()).unwrap();
        sock.flush().unwrap();
        std::thread::sleep(Duration::from_millis(40));
        cancel_after_hit.cancel();
    });

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
    let err = client.complete_cancellable(&req, &handle.token(), &mut |_| {}).unwrap_err();
    assert!(matches!(err, BrainError::Cancelled), "expected Cancelled, got {err:?}");
    assert!(start.elapsed() < Duration::from_millis(500));
    server.join().unwrap();
}

#[test]
fn fetch_balance_parses_user_balance_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let (req_line, headers) = read_http_request(&sock);
        assert!(req_line.starts_with("GET /user/balance "), "{req_line}");
        assert!(headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer sk-bal"), "{headers:?}");
        let body = r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"42.50","granted_balance":"2.50","topped_up_balance":"40.00"}]}"#;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        sock.write_all(resp.as_bytes()).unwrap();
        sock.flush().unwrap();
    });

    let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-bal".into())).with_retry(RetryPolicy::none());
    let bal = client.fetch_balance().unwrap();
    assert!(bal.is_available);
    assert_eq!(bal.balance_infos.len(), 1);
    assert_eq!(bal.balance_infos[0].currency, "CNY");
    assert!((bal.balance_infos[0].total_balance - 42.50).abs() < 1e-6);
    assert!((bal.balance_infos[0].granted_balance - 2.50).abs() < 1e-6);
    assert!((bal.balance_infos[0].topped_up_balance - 40.00).abs() < 1e-6);
    server.join().unwrap();
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

#[test]
fn catalog_models_pricing_and_stream_cancel() {
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
        .unwrap_err();
    assert!(matches!(no_key, BrainError::NoKey));
}
