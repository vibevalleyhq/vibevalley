//! Integration & unit test suite for `vibevalley-mcp`:
//! - SEP-2575 stateless calls without `initialize` + `server/discover` + `_meta`
//! - SEP-2243 Routable Streamable HTTP header match & `-32020` mismatch
//! - Legacy `initialize` / `notifications/initialized` / `ping` compatibility
//! - SEP-2640 Skills over MCP (`skills/list`, `skills/get`, `skill://` `resources/read`, embedded & directory loaders)
//! - Async stdio JSON-RPC 2.0 loop (`serve_io`)
//! - Pure `McpServerConfig` / `McpTransportSpec` serialization roundtrip
//! - Secret redaction (`scrub_secrets`, `scrub_tool_result`, `scrub_resource_content`)

use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_mcp::{
    BoxFuture, ContentBlock, EXT_SKILLS, HEADER_METHOD, HEADER_NAME, HEADER_PROTOCOL_VERSION, HttpHeaders, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION,
    McpHandler, McpServerConfig, McpTransportSpec, PROTOCOL_LEGACY, PROTOCOL_STATELESS, RequestContext, ResourceContent, ResourceDef, ResourceTemplateDef,
    RpcError, SUPPORTED_PROTOCOLS, ServerCapabilities, ServerInfo, SkillCatalog, ToolCallResult, ToolDef, builtin_artifact_skills, dispatch_http, error_code,
    scrub_resource_content, scrub_secrets, scrub_tool_result, serve_io,
};

struct DemoHandler {
    skills: SkillCatalog,
}

impl DemoHandler {
    fn new(skills: SkillCatalog) -> Self {
        Self { skills }
    }
}

impl McpHandler for DemoHandler {
    fn server_info(&self) -> ServerInfo {
        ServerInfo::new("vibevalley-test", "1.2.3")
    }

    fn capabilities(&self) -> ServerCapabilities {
        let mut caps = ServerCapabilities::default().with_tools().with_resources();
        if !self.skills.is_empty() {
            caps = caps.with_skills_extension(true);
        }
        caps
    }

    fn skills(&self) -> Option<&SkillCatalog> {
        Some(&self.skills)
    }

    fn list_tools<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ToolDef>, RpcError>> {
        Box::pin(async {
            Ok(vec![ToolDef {
                name: "echo_meta".into(),
                description: "Echoes request metadata and arguments".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "msg": { "type": "string" }
                    }
                }),
            }])
        })
    }

    fn call_tool<'a>(&'a self, ctx: &'a RequestContext, name: &'a str, arguments: Value) -> BoxFuture<'a, Result<ToolCallResult, RpcError>> {
        let protocol_version = ctx.protocol_version.clone();
        let meta_version = ctx.meta.protocol_version.clone();
        let client_caps = ctx.meta.client_capabilities.clone();
        let name = name.to_owned();
        Box::pin(async move {
            if name != "echo_meta" {
                return Ok(ToolCallResult::error(format!("unknown tool: {name}")));
            }
            Ok(ToolCallResult::json(&json!({
                "tool": name,
                "protocolVersion": protocol_version,
                "metaProtocolVersion": meta_version,
                "clientCapabilities": client_caps,
                "arguments": arguments,
            })))
        })
    }

    fn list_resources<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ResourceDef>, RpcError>> {
        Box::pin(async {
            Ok(vec![ResourceDef {
                uri: "vv://issues".into(),
                name: "Open Issues".into(),
                description: Some("All open issues".into()),
                mime_type: Some("application/json".into()),
            }])
        })
    }

    fn list_resource_templates<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ResourceTemplateDef>, RpcError>> {
        Box::pin(async {
            Ok(vec![ResourceTemplateDef {
                uri_template: "vv://issue/{id}".into(),
                name: "Issue".into(),
                description: None,
                mime_type: Some("application/json".into()),
            }])
        })
    }

    fn read_resource<'a>(&'a self, _ctx: &'a RequestContext, uri: &'a str) -> BoxFuture<'a, Result<ResourceContent, RpcError>> {
        let uri = uri.to_owned();
        Box::pin(async move {
            if uri == "vv://issues" {
                Ok(ResourceContent::text(uri, "application/json", "[]"))
            } else {
                Err(RpcError::resource_not_found(format!("missing resource: {uri}")))
            }
        })
    }
}

fn sample_embedded_skills() -> SkillCatalog {
    SkillCatalog::from_embedded_entries(
        "artifact",
        &[
            (
                "outline/SKILL.md",
                "---\nname: outline\ndescription: Hierarchical tree outline guide\ntags: [artifact, writing]\n---\n# Outline\nUse nodes.\n",
            ),
            ("outline/references/format.md", "# Outline JSON Format\nRoot ids and nodes.\n"),
            ("docs/SKILL.md", "# docs: Collaborative Document\nMulti-section markdown.\n"),
        ],
    )
}

#[tokio::test]
async fn sep_2575_stateless_discover_and_meta_call_without_initialize() {
    let handler = DemoHandler::new(sample_embedded_skills());

    // 1. server/discover returns supported versions, skills extension, serverInfo, stateless=true.
    let discover_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "server/discover",
        "params": {}
    })
    .to_string();
    let reply = dispatch_http(&handler, &HttpHeaders::default(), None, &discover_req).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.headers.protocol_version, PROTOCOL_STATELESS);
    assert_eq!(reply.headers.cache_control, "private, max-age=60");
    let body: Value = serde_json::from_str(reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["result"]["stateless"], true);
    assert_eq!(body["result"]["serverInfo"]["name"], "vibevalley-test");
    assert_eq!(body["result"]["serverInfo"]["version"], "1.2.3");
    assert_eq!(body["result"]["supportedProtocolVersions"], json!(SUPPORTED_PROTOCOLS));
    assert_eq!(body["result"]["capabilities"]["extensions"][EXT_SKILLS]["directoryRead"], true);

    // 2. Direct stateless tools/call with _meta works with ZERO prior initialize!
    let call_req = json!({
        "jsonrpc": "2.0",
        "id": "call-1",
        "method": "tools/call",
        "params": {
            "name": "echo_meta",
            "arguments": { "msg": "hello stateless" },
            "_meta": {
                META_PROTOCOL_VERSION: PROTOCOL_STATELESS,
                META_CLIENT_CAPABILITIES: { "roots": { "listChanged": true } }
            }
        }
    })
    .to_string();
    let call_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &call_req).await;
    assert_eq!(call_reply.status, 200);
    assert_eq!(call_reply.headers.protocol_version, PROTOCOL_STATELESS);
    assert_eq!(call_reply.headers.cache_control, "no-store");
    let call_body: Value = serde_json::from_str(call_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(call_body["id"], "call-1");
    assert_eq!(call_body["result"]["isError"], false);
    let inner: Value = serde_json::from_str(call_body["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(inner["metaProtocolVersion"], PROTOCOL_STATELESS);
    assert_eq!(inner["clientCapabilities"]["roots"]["listChanged"], true);
    assert_eq!(inner["arguments"]["msg"], "hello stateless");
}

#[tokio::test]
async fn sep_2243_routable_http_headers_validate_match_and_reject_mismatch_with_32020() {
    let handler = DemoHandler::new(sample_embedded_skills());
    let req = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {
            "name": "echo_meta",
            "arguments": { "msg": "ok" },
            "_meta": {
                META_PROTOCOL_VERSION: PROTOCOL_STATELESS
            }
        }
    })
    .to_string();

    // Matching headers succeed.
    let good = HttpHeaders::from_pairs([
        (HEADER_PROTOCOL_VERSION, PROTOCOL_STATELESS),
        (HEADER_METHOD, "tools/call"),
        (HEADER_NAME, "echo_meta"),
    ]);
    let ok_reply = dispatch_http(&handler, &good, None, &req).await;
    assert_eq!(ok_reply.status, 200);
    assert_eq!(ok_reply.headers.protocol_version, PROTOCOL_STATELESS);
    let ok_body: Value = serde_json::from_str(ok_reply.body.as_deref().unwrap()).unwrap();
    assert!(ok_body.get("error").is_none());

    // Mismatched MCP-Protocol-Version against _meta -> -32020.
    let bad_ver = HttpHeaders::from_pairs([(HEADER_PROTOCOL_VERSION, PROTOCOL_LEGACY)]);
    let ver_reply = dispatch_http(&handler, &bad_ver, None, &req).await;
    assert_eq!(ver_reply.status, 400);
    let ver_body: Value = serde_json::from_str(ver_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(ver_body["id"], 7);
    assert_eq!(ver_body["error"]["code"], error_code::HEADER_MISMATCH);
    assert_eq!(ver_body["error"]["data"]["header"], HEADER_PROTOCOL_VERSION);

    // Mismatched Mcp-Method -> -32020.
    let bad_method = HttpHeaders::from_pairs([(HEADER_METHOD, "tools/list")]);
    let method_reply = dispatch_http(&handler, &bad_method, None, &req).await;
    assert_eq!(method_reply.status, 400);
    let method_body: Value = serde_json::from_str(method_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(method_body["error"]["code"], error_code::HEADER_MISMATCH);
    assert_eq!(method_body["error"]["data"]["header"], HEADER_METHOD);

    // Mismatched Mcp-Name -> -32020.
    let bad_name = HttpHeaders::from_pairs([(HEADER_NAME, "other_tool")]);
    let name_reply = dispatch_http(&handler, &bad_name, None, &req).await;
    assert_eq!(name_reply.status, 400);
    let name_body: Value = serde_json::from_str(name_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(name_body["error"]["code"], error_code::HEADER_MISMATCH);
    assert_eq!(name_body["error"]["data"]["header"], HEADER_NAME);

    // Absent headers remain lenient for legacy clients.
    let legacy_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &req).await;
    assert_eq!(legacy_reply.status, 200);
}

#[tokio::test]
async fn legacy_initialize_notifications_and_ping_remain_compatible() {
    let handler = DemoHandler::new(SkillCatalog::new());

    let init = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": { "protocolVersion": "2025-03-26" }
    })
    .to_string();
    let init_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &init).await;
    assert_eq!(init_reply.status, 200);
    assert_eq!(init_reply.headers.protocol_version, "2025-03-26");
    let init_body: Value = serde_json::from_str(init_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(init_body["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init_body["result"]["serverInfo"]["name"], "vibevalley-test");

    // Notification returns 202 Accepted with no body.
    let notif = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    })
    .to_string();
    let notif_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &notif).await;
    assert_eq!(notif_reply.status, 202);
    assert!(notif_reply.body.is_none());

    // Ping returns empty object.
    let ping = json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }).to_string();
    let ping_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &ping).await;
    assert_eq!(ping_reply.status, 200);
    let ping_body: Value = serde_json::from_str(ping_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(ping_body["result"], json!({}));
}

#[tokio::test]
async fn sep_2640_skills_list_get_resource_read_and_directory_loader() {
    let dir = tempfile::tempdir().unwrap();
    let skill_dir = dir.path().join("deploy");
    std::fs::create_dir_all(skill_dir.join("references")).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: deploy\ndescription: Zero-downtime deploy guide\ntags: [ops, release]\n---\n# Deploy\nFollow checklist.\n",
    )
    .unwrap();
    std::fs::write(skill_dir.join("references/rollback.md"), "# Rollback\nRevert tag.\n").unwrap();

    let catalog = SkillCatalog::from_directory("ops", dir.path()).unwrap();
    let handler = DemoHandler::new(catalog);

    // skills/list with tag filter.
    let list_req = json!({ "jsonrpc": "2.0", "id": 1, "method": "skills/list", "params": { "tag": "release" } }).to_string();
    let list_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &list_req).await;
    let list_body: Value = serde_json::from_str(list_reply.body.as_deref().unwrap()).unwrap();
    let skills = list_body["result"]["skills"].as_array().unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0]["uri"], "skill://ops/deploy");
    assert_eq!(skills[0]["description"], "Zero-downtime deploy guide");
    assert!(skills[0]["files"].as_array().unwrap().contains(&json!("references/rollback.md")));

    // skills/get by name with progressive disclosure sub-file.
    let get_sub = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "skills/get",
        "params": { "name": "deploy", "file": "references/rollback.md" }
    })
    .to_string();
    let sub_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &get_sub).await;
    let sub_body: Value = serde_json::from_str(sub_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(sub_body["result"]["uri"], "skill://ops/deploy/references/rollback.md");
    assert!(sub_body["result"]["content"].as_str().unwrap().contains("Revert tag"));

    // resources/read with skill:// URI and path traversal rejection.
    let read_main = json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": { "uri": "skill://ops/deploy" } }).to_string();
    let main_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &read_main).await;
    let main_body: Value = serde_json::from_str(main_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(main_body["result"]["contents"][0]["mimeType"], "text/markdown");
    assert!(main_body["result"]["contents"][0]["text"].as_str().unwrap().contains("Follow checklist"));

    let traversal = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "resources/read",
        "params": { "uri": "skill://ops/deploy/../etc/passwd" }
    })
    .to_string();
    let trav_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &traversal).await;
    let trav_body: Value = serde_json::from_str(trav_reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(trav_body["error"]["code"], error_code::RESOURCE_NOT_FOUND);

    // resources/list includes both domain vv:// resources and skill:// entries.
    let res_list = json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/list", "params": {} }).to_string();
    let res_reply = dispatch_http(&handler, &HttpHeaders::default(), None, &res_list).await;
    let res_body: Value = serde_json::from_str(res_reply.body.as_deref().unwrap()).unwrap();
    let resources = res_body["result"]["resources"].as_array().unwrap();
    assert!(resources.iter().any(|r| r["uri"] == "vv://issues"));
    assert!(resources.iter().any(|r| r["uri"] == "skill://ops/deploy"));
}

#[tokio::test]
async fn stdio_serve_io_handles_stateless_discover_skills_notifications_and_parse_errors() {
    let handler = Arc::new(DemoHandler::new(sample_embedded_skills()));
    let input = concat!(
        "\n",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{}}\n",
        "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        "not-json\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"skills/list\",\"params\":{}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"echo_meta\",\"arguments\":{\"msg\":\"hi\"}}}\n",
    );
    let mut output = Vec::new();
    serve_io(handler.as_ref(), tokio::io::BufReader::new(input.as_bytes()), &mut output)
        .await
        .unwrap();

    let lines: Vec<Value> = String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[0]["result"]["stateless"], true);
    assert_eq!(lines[1]["error"]["code"], error_code::PARSE_ERROR);
    assert_eq!(lines[2]["id"], 2);
    assert_eq!(lines[2]["result"]["skills"].as_array().unwrap().len(), 2);
    assert_eq!(lines[3]["id"], 3);
    assert_eq!(lines[3]["result"]["isError"], false);
}

#[test]
fn config_spec_roundtrips_stdio_and_streamable_http() {
    let stdio_cfg =
        McpServerConfig::stdio("vibevalley", "vibevalley", vec!["mcp".into(), "--channel".into(), "alpha".into()]).with_env("VIBEVALLEY_HOME", "/tmp/vv");
    let http_cfg = McpServerConfig::streamable_http("vibevalley-http", "http://127.0.0.1:8790/mcp", true).with_header("Authorization", "Bearer tok");

    for cfg in [stdio_cfg, http_cfg] {
        let json = serde_json::to_string(&cfg).unwrap();
        let back: McpServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
    }

    let raw = r#"{"name":"remote","transport":{"type":"streamableHttp","url":"http://127.0.0.1:8790/mcp","stateless":true}}"#;
    let decoded: McpServerConfig = serde_json::from_str(raw).unwrap();
    assert!(matches!(decoded.transport, McpTransportSpec::StreamableHttp { stateless: true, .. }));
}

#[test]
fn secret_redaction_scrubs_longest_first_across_text_tool_and_resource() {
    let scrubbed = scrub_secrets("tok=abc and full=abcdef123", &["abc", "abcdef123", "  "]);
    assert_eq!(scrubbed, "tok=[redacted] and full=[redacted]");

    let mut result = ToolCallResult {
        content: vec![
            ContentBlock::Text {
                text: "bearer secret-xyz".into(),
            },
            ContentBlock::Image {
                data: "secret-xyz".into(),
                mime_type: "image/png".into(),
            },
            ContentBlock::Resource {
                resource: ResourceContent::text("vv://test", "text/plain", "embedded secret-xyz"),
            },
        ],
        is_error: false,
    };
    scrub_tool_result(&mut result, &["secret-xyz"]);
    assert_eq!(
        result.content[0],
        ContentBlock::Text {
            text: "bearer [redacted]".into()
        }
    );
    // Image payload bytes are untouched.
    assert_eq!(
        result.content[1],
        ContentBlock::Image {
            data: "secret-xyz".into(),
            mime_type: "image/png".into()
        }
    );
    assert_eq!(
        result.content[2],
        ContentBlock::Resource {
            resource: ResourceContent::text("vv://test", "text/plain", "embedded [redacted]")
        }
    );

    let mut res = ResourceContent::text("vv://x", "text/plain", "key=secret-xyz");
    scrub_resource_content(&mut res, &["secret-xyz"]);
    assert_eq!(res.text.as_deref(), Some("key=[redacted]"));
}

#[tokio::test]
async fn builtin_artifact_skills_catalog_exposes_all_12_types_and_merges_local() {
    let mut catalog = builtin_artifact_skills();
    assert_eq!(catalog.len(), 12);
    for slug in [
        "dashboard",
        "design",
        "design-system",
        "diagram",
        "docs",
        "motion",
        "outline",
        "prototype",
        "sheet",
        "slides",
        "storyboard",
        "whiteboard",
    ] {
        let uri = format!("skill://artifact/{slug}");
        let doc = catalog.get(&uri, None).unwrap_or_else(|| panic!("missing {uri}"));
        assert_eq!(doc.uri, uri);
        assert!(doc.files.iter().any(|f| f == "SKILL.en.md"), "{slug} missing SKILL.en.md");
    }

    let dir = tempfile::tempdir().unwrap();
    let local_skill = dir.path().join("triage");
    std::fs::create_dir_all(&local_skill).unwrap();
    std::fs::write(local_skill.join("SKILL.md"), "# triage: Local triage\nCheck issues.\n").unwrap();
    catalog.merge(SkillCatalog::from_directory("local", dir.path()).unwrap());
    assert_eq!(catalog.len(), 13);

    let handler = DemoHandler::new(catalog);
    let list_req = json!({ "jsonrpc": "2.0", "id": 1, "method": "skills/list", "params": { "tag": "artifact" } }).to_string();
    let reply = dispatch_http(&handler, &HttpHeaders::default(), None, &list_req).await;
    let body: Value = serde_json::from_str(reply.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["result"]["skills"].as_array().unwrap().len(), 12);
}
