use std::path::PathBuf;

use serde_json::json;
use vibevalley_agent::mcp::{McpConfig, McpHub, content_text, tool_name};

fn config() -> McpConfig {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/echo_mcp.py");
    serde_json::from_value(json!({"mcpServers": {
        "echo srv": {"command": "python3", "args": ["-I", script]},
        "gone": {"command": "/definitely/not/a/binary"}
    }}))
    .unwrap()
}

#[test]
fn a_stdio_server_s_tools_are_offered_and_called() {
    let hub = McpHub::connect(&config());
    assert_eq!(hub.failures.len(), 1, "{:?}", hub.failures);
    assert!(hub.failures[0].1.starts_with("连不上 MCP 服务 gone"));
    let tools = hub.tools();
    let names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
    assert_eq!(names, vec!["echo_srv__echo", "echo_srv__fail"]);
    let echo = &tools[0];
    assert!(echo.spec().description.starts_with("（echo srv）"));
    assert_eq!(echo.spec().parameters["required"], json!(["text"]));
    assert!(echo.replay_safe(), "readOnlyHint makes it safe to replay");
    let out = echo.execute(&json!({"text": "你好"}));
    assert_eq!((out.is_error, out.text.as_str()), (false, "echo: 你好"));
    let failed = tools[1].execute(&json!({}));
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

#[test]
fn an_http_server_s_tools_are_offered_and_called() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        for _ in 0..4 {
            let Ok((mut stream, _)) = listener.accept() else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut content_len = 0usize;
            let mut auth_ok = false;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    break;
                }
                if let Some((k, v)) = trimmed.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        content_len = v.trim().parse().unwrap_or(0);
                    } else if k.eq_ignore_ascii_case("authorization") && v.trim() == "Bearer secret-key" {
                        auth_ok = true;
                    }
                }
            }
            assert!(auth_ok, "expected Authorization header");
            let mut body = vec![0u8; content_len];
            reader.read_exact(&mut body).unwrap();
            let msg: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let id = msg.get("id").cloned();
            let resp = match msg["method"].as_str().unwrap_or_default() {
                "initialize" => json!({"jsonrpc": "2.0", "id": id, "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "http", "version": "1.0"}
                }}),
                "notifications/initialized" => {
                    let _ = stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    continue;
                }
                "tools/list" => json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [
                    {"name": "ping", "description": "Pings over SSE", "annotations": {"readOnlyHint": true}, "inputSchema": {"type": "object"}}
                ]}}),
                "tools/call" => {
                    let sse = format!(
                        "event: message\ndata: {}\n\n",
                        json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": "pong"}]}})
                    );
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        sse.len(),
                        sse
                    );
                    stream.write_all(reply.as_bytes()).unwrap();
                    continue;
                }
                _ => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no"}}),
            };
            let bytes = serde_json::to_vec(&resp).unwrap();
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: s1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });

    let cfg: McpConfig = serde_json::from_value(json!({"mcpServers": {
        "remote": {
            "url": format!("http://{addr}/mcp"),
            "headers": {"Authorization": "Bearer secret-key"}
        }
    }}))
    .unwrap();
    let hub = McpHub::connect(&cfg);
    assert!(hub.failures.is_empty(), "{:?}", hub.failures);
    let tools = hub.tools();
    assert_eq!(tools.len(), 1);
    let out = tools[0].execute(&json!({}));
    assert_eq!((out.is_error, out.text.as_str()), (false, "pong"));
    handle.join().unwrap();
}
