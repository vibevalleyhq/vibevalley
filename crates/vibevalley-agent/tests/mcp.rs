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
