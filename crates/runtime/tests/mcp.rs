use serde_json::json;
use vibevalley_runtime::agent::resources::mcp::{McpConfig, McpHub, content_text, tool_name};

fn config() -> McpConfig {
    serde_json::from_value(json!({"mcpServers": {
        "echo srv": {"command": env!("CARGO_BIN_EXE_vv_test_fixture"), "args": ["echo_mcp"]},
        "gone": {"command": "/definitely/not/a/binary"}
    }}))
    .unwrap()
}

#[tokio::test]
async fn a_stdio_server_s_tools_are_offered_and_called() {
    let hub = McpHub::connect(&config()).await;
    assert_eq!(hub.failures.len(), 1, "{:?}", hub.failures);
    assert!(hub.failures[0].1.starts_with("连不上 MCP 服务 gone"));
    let tools = hub.tools();
    let names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
    assert_eq!(names, vec!["echo_srv__echo", "echo_srv__fail"]);
    let echo = &tools[0];
    assert!(echo.spec().description.starts_with("（echo srv）"));
    assert_eq!(echo.spec().parameters["required"], json!(["text"]));
    assert!(echo.replay_safe(), "readOnlyHint makes it safe to replay");
    let out = echo.execute(&json!({"text": "你好"})).await;
    assert_eq!((out.is_error, out.text.as_str()), (false, "echo: 你好"));
    let failed = tools[1].execute(&json!({})).await;
    assert_eq!((failed.is_error, failed.text.as_str()), (true, "it broke"));
    assert!(!tools[1].replay_safe());
}

#[test]
fn names_and_content_follow_vibevalley() {
    assert_eq!(tool_name("my.server", "do thing"), "my_server__do_thing");
    assert_eq!(tool_name(&"x".repeat(70), "t").len(), 64);
    let text = content_text(&[
        json!({"type": "text", "text": "a"}),
        json!({"type": "image", "data": ""}),
        json!({"type": "resource", "resource": {"uri": "file:///x"}}),
        json!({"type": "resource", "resource": {"text": "inline"}}),
    ]);
    assert_eq!(text, "a\n[image]\n[file:///x]\ninline");
    assert!(McpConfig::read(std::path::Path::new("/no/such.json")).is_err());
}

#[tokio::test]
async fn an_http_server_s_tools_are_offered_and_called() {
    use std::convert::Infallible;
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::body::Bytes;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::IntoResponse;
    use axum::response::sse::{Event, Sse};
    use axum::routing::get;
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;

    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let check_auth = |headers: &HeaderMap, errors: &Mutex<Vec<String>>| {
        if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some("Bearer secret-key") {
            errors.lock().unwrap().push("missing or wrong Authorization header".into());
        }
    };
    let get_errors = errors.clone();
    let post_errors = errors.clone();
    let app = Router::new().route(
        "/mcp",
        get(move |headers: HeaderMap| {
            let errors = get_errors.clone();
            async move {
                check_auth(&headers, &errors);
                if headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) != Some("s1") {
                    errors.lock().unwrap().push("GET /mcp missing Mcp-Session-Id: s1".into());
                }
                StatusCode::METHOD_NOT_ALLOWED
            }
        })
        .post(move |headers: HeaderMap, body: Bytes| {
            let errors = post_errors.clone();
            async move {
                check_auth(&headers, &errors);
                let session = headers.get("mcp-session-id").and_then(|v| v.to_str().ok());
                let msg: serde_json::Value = serde_json::from_slice(&body).unwrap();
                if msg["method"] != "initialize" && session != Some("s1") {
                    errors.lock().unwrap().push(format!("expected Mcp-Session-Id: s1 for {msg}"));
                }
                let id = msg.get("id").cloned();
                let resp = match msg["method"].as_str().unwrap_or_default() {
                    "initialize" => json!({"jsonrpc": "2.0", "id": id, "result": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "http", "version": "1.0"}
                    }}),
                    "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
                    "tools/list" => json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [
                        {"name": "ping", "description": "Pings over SSE", "annotations": {"readOnlyHint": true}, "inputSchema": {"type": "object"}}
                    ]}}),
                    "tools/call" => {
                        let data = json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": "pong"}]}}).to_string();
                        let stream = futures_util::stream::once(async move { Ok::<_, Infallible>(Event::default().event("message").data(data)) });
                        return Sse::new(stream).into_response();
                    }
                    _ => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no"}}),
                };
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE.as_str(), "application/json"), ("mcp-session-id", "s1")],
                    resp.to_string(),
                )
                    .into_response()
            }
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let _guard = cancel.clone().drop_guard();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
    });

    let cfg: McpConfig = serde_json::from_value(json!({"mcpServers": {
        "remote": {
            "url": format!("http://{addr}/mcp"),
            "headers": {"Authorization": "Bearer secret-key"}
        }
    }}))
    .unwrap();
    let hub = McpHub::connect(&cfg).await;
    assert!(hub.failures.is_empty(), "{:?}", hub.failures);
    let tools = hub.tools();
    assert_eq!(tools.len(), 1);
    let out = tools[0].execute(&json!({})).await;
    assert_eq!((out.is_error, out.text.as_str()), (false, "pong"));
    assert!(errors.lock().unwrap().is_empty(), "{:?}", errors.lock().unwrap());
}

#[tokio::test]
async fn regression_cancelling_an_mcp_call_preserves_its_peer_and_dropping_the_last_tool_stops_the_child() {
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;
    use tokio::process::Command;
    use tokio_util::sync::CancellationToken;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cfg = serde_json::from_value(json!({"mcpServers": {"slow": {
        "command": env!("CARGO_BIN_EXE_vv_test_fixture"),
        "args": ["cancellable_mcp"],
        "env": {"MCP_TEST_PORT": listener.local_addr().unwrap().port().to_string()}
    }}}))
    .unwrap();
    let hub = McpHub::connect(&cfg).await;
    assert!(hub.failures.is_empty(), "{:?}", hub.failures);
    let tool = hub.tools().pop().unwrap();
    let (events, _) = listener.accept().await.unwrap();
    let mut lines = BufReader::new(events).lines();
    let pid = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let cancel = CancellationToken::new();
    let cancel_token = cancel.clone();
    let tool: std::sync::Arc<dyn vibevalley_runtime::agent::Tool> = std::sync::Arc::from(tool);
    let running_tool = tool.clone();
    let running = tokio::spawn(async move {
        let ctx = vibevalley_runtime::agent::ToolContext::with_cancel(vibevalley_runtime::agent::ai::CancelToken::from_tokio(cancel_token));
        running_tool.execute_with_context(&json!({}), &ctx).await
    });
    let sent = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let id = sent.strip_prefix("begin:").unwrap();
    cancel.cancel();
    let cancelled_line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(cancelled_line, format!("cancel:{id}"));
    let result = running.await.unwrap();
    assert!(result.is_error && result.text.contains("aborted"), "{result:?}");
    drop(hub);
    assert_eq!(tool.execute(&json!({"ping":true})).await.text, "pong");
    drop(tool);
    let eof = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap();
    assert!(eof.is_none(), "MCP process still owns its socket");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Command::new("kill").args(["-0", &pid]).stderr(Stdio::null()).status().await.unwrap().success() {
        assert!(Instant::now() < deadline, "MCP child {pid} was not reaped");
        tokio::task::yield_now().await;
    }
}
