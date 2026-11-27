//! JSON-RPC MCP handler (`Mcp`) serving helper tools, `vv://` resources, and SEP-2640 skills.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use vibevalley_mcp::{
    McpHandler, RequestContext, ResourceContent, ResourceDef, ResourceTemplateDef, RpcError, ServerCapabilities, ServerInfo, SkillCatalog, ToolCallResult,
    ToolDef, dispatch_json, error_code, scrub_resource_content, scrub_tool_result,
};

use super::{ToolDispatchPort, mode, skills};
use crate::BoxFuture;
use crate::context::api::Mcp as McpGateway;

const UNKNOWN_CALLER: &str = "没认出你是谁：这些工具只给执行会话用";

/// JSON-RPC MCP endpoint serving helper tools, `vv://` resources, and SEP-2640 skills over `POST /mcp`.
pub struct Mcp {
    dispatch: Arc<dyn ToolDispatchPort>,
    tools: Vec<ToolDef>,
    version: String,
    home: Option<PathBuf>,
}

impl Mcp {
    pub fn new(dispatch: Arc<dyn ToolDispatchPort>, version: String) -> Arc<Mcp> {
        let tools = mode::to_tool_defs(dispatch.helper_tools());
        Arc::new(Mcp {
            dispatch,
            tools,
            version,
            home: None,
        })
    }

    pub fn with_home(dispatch: Arc<dyn ToolDispatchPort>, version: String, home: PathBuf) -> Arc<Mcp> {
        let tools = mode::to_tool_defs(dispatch.helper_tools());
        Arc::new(Mcp {
            dispatch,
            tools,
            version,
            home: Some(home),
        })
    }
}

impl McpHandler for Mcp {
    fn server_info(&self) -> ServerInfo {
        ServerInfo::new("vibevalley", self.version.clone())
    }

    fn capabilities(&self) -> ServerCapabilities {
        ServerCapabilities::default().with_tools().with_resources().with_skills_extension(true)
    }

    fn skills(&self) -> Option<&SkillCatalog> {
        Some(&skills::NOTE_SKILLS)
    }

    fn resolve_skills_async<'a>(&'a self, _ctx: &'a RequestContext) -> vibevalley_mcp::BoxFuture<'a, Option<Cow<'a, SkillCatalog>>> {
        Box::pin(async move { Some(skills::catalog_for_home(self.home.as_deref()).await) })
    }

    fn authorize_read<'a>(&'a self, ctx: &'a RequestContext) -> vibevalley_mcp::BoxFuture<'a, Result<(), RpcError>> {
        Box::pin(async move {
            let token = ctx.bearer_token.as_deref().unwrap_or("");
            if !token.is_empty() && self.dispatch.session_for_token(token).await.is_none() {
                return Err(RpcError::unauthorized(UNKNOWN_CALLER));
            }
            Ok(())
        })
    }

    fn list_tools<'a>(&'a self, ctx: &'a RequestContext) -> vibevalley_mcp::BoxFuture<'a, Result<Vec<ToolDef>, RpcError>> {
        Box::pin(async move {
            mode::tools_for_token_async(self.dispatch.as_ref(), &self.tools, ctx.bearer_token.as_deref())
                .await
                .ok_or_else(|| RpcError::unauthorized(UNKNOWN_CALLER))
        })
    }

    fn call_tool<'a>(&'a self, ctx: &'a RequestContext, name: &'a str, arguments: Value) -> vibevalley_mcp::BoxFuture<'a, Result<ToolCallResult, RpcError>> {
        Box::pin(async move {
            let token = ctx.bearer_token.as_deref().unwrap_or("");
            let args_json = serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_string());
            let called = mode::dispatch_tool_for_token_async(self.dispatch.as_ref(), ctx.bearer_token.as_deref(), name, &args_json, UNKNOWN_CALLER).await;
            let mut result = match called {
                Ok(text) => ToolCallResult::text(text),
                Err(why) if why == UNKNOWN_CALLER || why.starts_with("没成：") => ToolCallResult::error(why),
                Err(why) => ToolCallResult::error(format!("没成：{why}")),
            };
            if !token.is_empty() {
                scrub_tool_result(&mut result, &[token]);
            }
            Ok(result)
        })
    }

    fn list_resources<'a>(&'a self, ctx: &'a RequestContext) -> vibevalley_mcp::BoxFuture<'a, Result<Vec<ResourceDef>, RpcError>> {
        Box::pin(async move {
            self.authorize_read(ctx).await?;
            let resources = self
                .dispatch
                .list_resources_async()
                .await
                .into_iter()
                .map(|r| ResourceDef {
                    uri: r.uri,
                    name: r.name,
                    description: r.description,
                    mime_type: Some(r.mime_type),
                })
                .collect();
            Ok(resources)
        })
    }

    fn list_resource_templates<'a>(&'a self, ctx: &'a RequestContext) -> vibevalley_mcp::BoxFuture<'a, Result<Vec<ResourceTemplateDef>, RpcError>> {
        Box::pin(async move {
            self.authorize_read(ctx).await?;
            let templates = self
                .dispatch
                .list_resource_templates()
                .into_iter()
                .map(|t| ResourceTemplateDef {
                    uri_template: t.uri_template,
                    name: t.name,
                    description: t.description,
                    mime_type: Some(t.mime_type),
                })
                .collect();
            Ok(templates)
        })
    }

    fn read_resource<'a>(&'a self, ctx: &'a RequestContext, uri: &'a str) -> vibevalley_mcp::BoxFuture<'a, Result<ResourceContent, RpcError>> {
        Box::pin(async move {
            let token = ctx.bearer_token.as_deref().unwrap_or("");
            let session = if token.is_empty() {
                None
            } else {
                let Some(me) = self.dispatch.session_for_token(token).await else {
                    return Err(RpcError::unauthorized(UNKNOWN_CALLER));
                };
                Some(me)
            };
            let wire = self.dispatch.read_resource_async(session, uri).await.map_err(RpcError::resource_not_found)?;
            let mut content = ResourceContent::text(wire.uri, wire.mime_type, wire.text);
            if !token.is_empty() {
                scrub_resource_content(&mut content, &[token]);
            }
            Ok(content)
        })
    }
}

impl McpGateway for Mcp {
    fn message_json(&self, _token: &str, message_json: &str) -> Option<String> {
        let req: vibevalley_mcp::RpcRequest = serde_json::from_str(message_json).ok()?;
        let id = req.id.filter(|id| !id.is_null())?;
        let resp = vibevalley_mcp::RpcResponse::err(
            id,
            RpcError::new(error_code::INTERNAL_ERROR, "sync Mcp::message_json is unsupported; use Mcp::message_json_async"),
        );
        serde_json::to_string(&resp).ok()
    }

    fn message_json_async(self: Arc<Self>, token: String, message_json: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async move {
            let ctx = RequestContext {
                protocol_version: None,
                meta: Default::default(),
                bearer_token: (!token.is_empty()).then_some(token),
            };
            dispatch_json(self.as_ref(), &ctx, &message_json).await.ok().flatten()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::mcp::{McpResourceContentWire, McpResourceTemplateWire, McpResourceWire, ToolSpecWire};
    use vibevalley_mcp::{EXT_SKILLS, HttpHeaders, PROTOCOL_STATELESS, dispatch_http, error_code};
    use vibevalley_protocol::Session;

    struct StubDispatch;

    impl ToolDispatchPort for StubDispatch {
        fn helper_tools(&self) -> Vec<ToolSpecWire> {
            vec![ToolSpecWire {
                name: "issue_list".into(),
                description: "List issues".into(),
                parameters_json: r#"{"properties":{}}"#.into(),
            }]
        }

        fn session_for_token<'a>(&'a self, _token: &'a str) -> BoxFuture<'a, Option<Session>> {
            Box::pin(async { None })
        }

        fn session_mode_async<'a>(&'a self, _session: &'a Session) -> BoxFuture<'a, crate::agent::mcp::HelperRunMode> {
            Box::pin(async { crate::agent::mcp::HelperRunMode::Execution })
        }

        fn call_helper_async<'a>(&'a self, _session: Session, _name: &'a str, _args_json: &'a str) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Ok("ok".into()) })
        }

        fn call_readonly_issue_tool_async<'a>(&'a self, _name: &'a str, _args_json: &'a str) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Ok("[]".into()) })
        }

        fn list_resources_async<'a>(&'a self) -> BoxFuture<'a, Vec<McpResourceWire>> {
            Box::pin(async { Vec::new() })
        }

        fn list_resource_templates(&self) -> Vec<McpResourceTemplateWire> {
            Vec::new()
        }

        fn read_resource_async<'a>(&'a self, _session: Option<Session>, uri: &'a str) -> BoxFuture<'a, Result<McpResourceContentWire, String>> {
            let msg = format!("missing: {uri}");
            Box::pin(async move { Err(msg) })
        }
    }

    #[tokio::test]
    async fn server_mcp_exposes_discover_and_all_4_note_skills() {
        let mcp = Mcp::new(Arc::new(StubDispatch), "0.1.0-test".into());

        // SEP-2575 server/discover without initialize.
        let discover_req = r#"{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}"#;
        let reply = dispatch_http(mcp.as_ref(), &HttpHeaders::default(), None, discover_req).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.headers.protocol_version, PROTOCOL_STATELESS);
        let body: Value = serde_json::from_str(reply.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["result"]["stateless"], true);
        assert_eq!(body["result"]["capabilities"]["extensions"][EXT_SKILLS]["directoryRead"], true);

        // SEP-2640 skills/list exposes all 4 embedded note types.
        let list_req = r#"{"jsonrpc":"2.0","id":2,"method":"skills/list","params":{}}"#;
        let list_reply = dispatch_http(mcp.as_ref(), &HttpHeaders::default(), None, list_req).await;
        let list_body: Value = serde_json::from_str(list_reply.body.as_deref().unwrap()).unwrap();
        let skills = list_body["result"]["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 4, "{skills:?}");
        for slug in ["doc", "base", "canvas", "media"] {
            let expected_uri = format!("skill://note/{slug}");
            assert!(skills.iter().any(|s| s["uri"] == expected_uri), "missing {expected_uri}");
        }

        // SEP-2640 skills/get + supporting file + resources/read on skill://.
        let get_req = r#"{"jsonrpc":"2.0","id":3,"method":"skills/get","params":{"uri":"skill://note/doc"}}"#;
        let get_reply = dispatch_http(mcp.as_ref(), &HttpHeaders::default(), None, get_req).await;
        let get_body: Value = serde_json::from_str(get_reply.body.as_deref().unwrap()).unwrap();
        assert_eq!(get_body["result"]["uri"], "skill://note/doc");
        assert!(get_body["result"]["content"].as_str().unwrap().contains("doc"));

        let read_ref = r#"{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"skill://note/doc/references/format.md"}}"#;
        let read_reply = dispatch_http(mcp.as_ref(), &HttpHeaders::default(), None, read_ref).await;
        let read_body: Value = serde_json::from_str(read_reply.body.as_deref().unwrap()).unwrap();
        assert_eq!(read_body["result"]["contents"][0]["uri"], "skill://note/doc/references/format.md");
        assert_eq!(read_body["result"]["contents"][0]["mimeType"], "text/markdown");
        assert!(!read_body["result"]["contents"][0]["text"].as_str().unwrap().is_empty());

        // SEP-2243 header mismatch returns -32020.
        let bad_headers = HttpHeaders {
            protocol_version: Some(PROTOCOL_STATELESS.into()),
            method: Some("tools/call".into()),
            name: None,
        };
        let mismatch = dispatch_http(mcp.as_ref(), &bad_headers, None, list_req).await;
        assert_eq!(mismatch.status, 400);
        let mismatch_body: Value = serde_json::from_str(mismatch.body.as_deref().unwrap()).unwrap();
        assert_eq!(mismatch_body["error"]["code"], error_code::HEADER_MISMATCH);
    }
}
