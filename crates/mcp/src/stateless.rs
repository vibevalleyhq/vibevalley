//! SEP-2575 Stateless Core (`server/discover`, self-describing `_meta`) and
//! SEP-2243 Routable Streamable HTTP header validation (`MCP-Protocol-Version`,
//! `Mcp-Method`, `Mcp-Name`).

use std::future::Future;
use std::pin::Pin;

use serde_json::{Value, json};

use crate::protocol::{
    HEADER_METHOD, HEADER_NAME, HEADER_PROTOCOL_VERSION, InitializeParams, InitializeResult, JSONRPC_VERSION, PROTOCOL_LEGACY, PROTOCOL_STATELESS, RequestMeta,
    ResourceContent, ResourceDef, ResourceReadParams, ResourceTemplateDef, RpcError, RpcId, RpcRequest, RpcResponse, SUPPORTED_PROTOCOLS, ServerCapabilities,
    ServerDiscoverResult, ServerInfo, ToolCallParams, ToolCallResult, ToolDef, ToolsCapability, is_supported_protocol,
};
use crate::skills::{SkillCatalog, SkillGetParams, SkillListParams};

/// Heap-allocated `Send` future returned by [`McpHandler`] async methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Per-request metadata passed to [`McpHandler`] implementations.
#[derive(Debug, Clone, Default)]
pub struct RequestContext {
    /// Protocol version negotiated from `MCP-Protocol-Version` header or `_meta`.
    pub protocol_version: Option<String>,
    /// Decoded SEP-2575 `params._meta` envelope.
    pub meta: RequestMeta,
    /// Optional Bearer token supplied by HTTP transport (empty/None for stdio or unauthenticated loopback).
    pub bearer_token: Option<String>,
}

/// Narrow async server handler trait shared by HTTP (`vibevalley-server`) and stdio (`vibevalley-cli`) servers.
pub trait McpHandler: Send + Sync {
    fn server_info(&self) -> ServerInfo;

    fn capabilities(&self) -> ServerCapabilities {
        let mut caps = ServerCapabilities {
            tools: Some(ToolsCapability::default()),
            resources: None,
            extensions: Default::default(),
        };
        if self.skills().is_some_and(|c| !c.is_empty()) {
            caps = caps.with_skills_extension(true);
        }
        caps
    }

    fn supported_protocols(&self) -> &'static [&'static str] {
        SUPPORTED_PROTOCOLS
    }

    /// Optional SEP-2640 skill catalog served via `skills/list`, `skills/get`, and `resources/read` (`skill://`).
    fn skills(&self) -> Option<&SkillCatalog> {
        None
    }

    /// Optional read-access authorization hook checked before serving `skills/*` and `skill://` reads.
    fn authorize_read<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<(), RpcError>> {
        Box::pin(async { Ok(()) })
    }

    fn list_tools<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ToolDef>, RpcError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn call_tool<'a>(&'a self, _ctx: &'a RequestContext, name: &'a str, _arguments: Value) -> BoxFuture<'a, Result<ToolCallResult, RpcError>> {
        let msg = format!("unknown tool: {name}");
        Box::pin(async move { Ok(ToolCallResult::error(msg)) })
    }

    fn list_resources<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ResourceDef>, RpcError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn list_resource_templates<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ResourceTemplateDef>, RpcError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn read_resource<'a>(&'a self, _ctx: &'a RequestContext, uri: &'a str) -> BoxFuture<'a, Result<ResourceContent, RpcError>> {
        let msg = format!("resource not found: {uri}");
        Box::pin(async move { Err(RpcError::resource_not_found(msg)) })
    }
}

/// SEP-2243 Routable Streamable HTTP headers extracted from an incoming HTTP request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpHeaders {
    pub protocol_version: Option<String>,
    pub method: Option<String>,
    pub name: Option<String>,
}

/// Result of validating an incoming Streamable HTTP JSON body against [`HttpHeaders`].
#[derive(Debug, Clone)]
pub struct ValidatedHttpBody {
    pub requests: Vec<RpcRequest>,
    pub is_batch: bool,
    pub negotiated_protocol: String,
    pub cacheable: bool,
}

/// Validation failure produced before invoking the MCP handler.
#[derive(Debug, Clone)]
pub struct HttpValidationError {
    pub status: u16,
    pub response: RpcResponse,
    pub headers: ResponseHeaders,
}

/// HTTP response headers emitted for Streamable HTTP replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHeaders {
    pub protocol_version: String,
    pub cache_control: &'static str,
}

/// Complete HTTP response produced by [`dispatch_http`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub headers: ResponseHeaders,
    pub body: Option<String>,
}

impl HttpHeaders {
    /// Parses `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` case-insensitively from HTTP header pairs.
    pub fn from_pairs<'a>(iter: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut out = Self::default();
        for (key, value) in iter {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }
            if key.eq_ignore_ascii_case(HEADER_PROTOCOL_VERSION) {
                out.protocol_version = Some(trimmed.to_owned());
            } else if key.eq_ignore_ascii_case(HEADER_METHOD) {
                out.method = Some(trimmed.to_owned());
            } else if key.eq_ignore_ascii_case(HEADER_NAME) {
                out.name = Some(trimmed.to_owned());
            }
        }
        out
    }

    /// Validates present routing headers against a single parsed [`RpcRequest`].
    ///
    /// Missing headers are permitted so legacy HTTP clients continue working unchanged.
    /// Any present header that disagrees with the JSON-RPC body returns `-32020` (`HEADER_MISMATCH`).
    pub fn validate(&self, req: &RpcRequest) -> Result<(), RpcError> {
        let meta = req.meta();

        if let Some(hdr_ver) = self.protocol_version.as_deref() {
            if let Some(meta_ver) = meta.protocol_version.as_deref().map(str::trim).filter(|s| !s.is_empty())
                && hdr_ver != meta_ver
            {
                return Err(RpcError::header_mismatch(
                    HEADER_PROTOCOL_VERSION,
                    Some(meta_ver),
                    hdr_ver,
                    format!("{HEADER_PROTOCOL_VERSION} header '{hdr_ver}' does not match _meta protocolVersion '{meta_ver}'"),
                ));
            }
            if let Some(init_ver) = req.initialize_protocol_version()
                && hdr_ver != init_ver
            {
                return Err(RpcError::header_mismatch(
                    HEADER_PROTOCOL_VERSION,
                    Some(init_ver),
                    hdr_ver,
                    format!("{HEADER_PROTOCOL_VERSION} header '{hdr_ver}' does not match initialize protocolVersion '{init_ver}'"),
                ));
            }
        }

        if let Some(hdr_method) = self.method.as_deref() {
            let body_method = req.method.trim();
            if hdr_method != body_method {
                return Err(RpcError::header_mismatch(
                    HEADER_METHOD,
                    (!body_method.is_empty()).then_some(body_method),
                    hdr_method,
                    format!("{HEADER_METHOD} header '{hdr_method}' does not match JSON-RPC method '{body_method}'"),
                ));
            }
        }

        if let Some(hdr_name) = self.name.as_deref() {
            let body_name = req.target_name();
            if body_name != Some(hdr_name) {
                return Err(RpcError::header_mismatch(
                    HEADER_NAME,
                    body_name,
                    hdr_name,
                    format!(
                        "{HEADER_NAME} header '{hdr_name}' does not match request target name '{}'",
                        body_name.unwrap_or("<none>")
                    ),
                ));
            }
        }

        Ok(())
    }

    /// Parses and validates a single JSON-RPC message or JSON-RPC batch against SEP-2243 headers.
    pub fn validate_raw_json(&self, raw_json: &str) -> Result<ValidatedHttpBody, Box<HttpValidationError>> {
        let parsed: Value = serde_json::from_str(raw_json).map_err(|err| {
            Box::new(HttpValidationError {
                status: 400,
                response: RpcResponse::err(RpcId::Null, RpcError::parse_error(format!("parse error: {err}"))),
                headers: ResponseHeaders {
                    protocol_version: self.protocol_version.clone().unwrap_or_else(|| PROTOCOL_STATELESS.to_owned()),
                    cache_control: "no-store",
                },
            })
        })?;

        let (requests, is_batch) = match parsed {
            Value::Array(items) => {
                let mut reqs = Vec::with_capacity(items.len());
                for item in items {
                    let req: RpcRequest = serde_json::from_value(item).map_err(|err| {
                        Box::new(HttpValidationError {
                            status: 400,
                            response: RpcResponse::err(RpcId::Null, RpcError::invalid_request(format!("invalid batch item: {err}"))),
                            headers: ResponseHeaders {
                                protocol_version: self.protocol_version.clone().unwrap_or_else(|| PROTOCOL_STATELESS.to_owned()),
                                cache_control: "no-store",
                            },
                        })
                    })?;
                    reqs.push(req);
                }
                (reqs, true)
            }
            other => {
                let req: RpcRequest = serde_json::from_value(other).map_err(|err| {
                    Box::new(HttpValidationError {
                        status: 400,
                        response: RpcResponse::err(RpcId::Null, RpcError::invalid_request(format!("invalid request: {err}"))),
                        headers: ResponseHeaders {
                            protocol_version: self.protocol_version.clone().unwrap_or_else(|| PROTOCOL_STATELESS.to_owned()),
                            cache_control: "no-store",
                        },
                    })
                })?;
                (vec![req], false)
            }
        };

        for req in &requests {
            if let Err(err) = self.validate(req) {
                let id = req.id.clone().unwrap_or(RpcId::Null);
                let negotiated = self
                    .protocol_version
                    .clone()
                    .or_else(|| req.meta().protocol_version)
                    .unwrap_or_else(|| PROTOCOL_STATELESS.to_owned());
                return Err(Box::new(HttpValidationError {
                    status: 400,
                    response: RpcResponse::err(id, err),
                    headers: ResponseHeaders {
                        protocol_version: negotiated,
                        cache_control: "no-store",
                    },
                }));
            }
        }

        let negotiated_protocol = negotiate_response_protocol(self, &requests);
        let cacheable = !is_batch && requests.first().is_some_and(|r| is_cacheable_method(r.method.trim()));

        Ok(ValidatedHttpBody {
            requests,
            is_batch,
            negotiated_protocol,
            cacheable,
        })
    }
}

fn is_cacheable_method(method: &str) -> bool {
    matches!(method, "server/discover" | "skills/list" | "skills/get")
}

fn negotiate_response_protocol(headers: &HttpHeaders, requests: &[RpcRequest]) -> String {
    if let Some(ver) = headers.protocol_version.as_deref()
        && is_supported_protocol(ver)
    {
        return ver.to_owned();
    }
    for req in requests {
        if let Some(ver) = req.meta().protocol_version.as_deref().map(str::trim).filter(|s| !s.is_empty())
            && is_supported_protocol(ver)
        {
            return ver.to_owned();
        }
        if let Some(ver) = req.initialize_protocol_version() {
            return ver.to_owned();
        }
    }
    if requests.iter().any(|r| r.method.trim() == "initialize") {
        PROTOCOL_LEGACY.to_owned()
    } else {
        PROTOCOL_STATELESS.to_owned()
    }
}

/// Computes `MCP-Protocol-Version` and `Cache-Control` response headers for an HTTP reply.
pub fn build_response_headers(validated: &ValidatedHttpBody, response_json: Option<&str>) -> ResponseHeaders {
    // If an `initialize` reply negotiated an explicit protocolVersion, echo it in the header.
    let mut protocol_version = validated.negotiated_protocol.clone();
    if let Some(raw) = response_json
        && let Ok(val) = serde_json::from_str::<Value>(raw)
        && let Some(ver) = val
            .get("result")
            .and_then(|r| r.get("protocolVersion"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        protocol_version = ver.to_owned();
    }
    let cache_control = if validated.cacheable { "private, max-age=60" } else { "no-store" };
    ResponseHeaders {
        protocol_version,
        cache_control,
    }
}

/// Dispatches a single decoded [`RpcRequest`] through `handler` using SEP-2575 stateless semantics
/// with full backward compatibility for legacy `initialize` / `notifications/initialized` / `ping`.
///
/// Returns `None` for JSON-RPC notifications (omitted or null `id`).
pub async fn dispatch_request<H: McpHandler + ?Sized>(handler: &H, base_ctx: &RequestContext, req: RpcRequest) -> Option<RpcResponse> {
    let is_notification = req.is_notification();
    let id = req.id.clone().unwrap_or(RpcId::Null);

    if let Some(version) = req.jsonrpc.as_deref()
        && version != JSONRPC_VERSION
    {
        return (!is_notification).then(|| RpcResponse::err(id, RpcError::invalid_request(format!("unsupported jsonrpc version: {version}"))));
    }

    let method = req.method.trim();
    if method.is_empty() {
        return (!is_notification).then(|| RpcResponse::err(id, RpcError::invalid_request("missing JSON-RPC method")));
    }

    if is_notification {
        return None;
    }

    let meta = req.meta();
    let mut ctx = base_ctx.clone();
    if ctx.protocol_version.is_none() {
        ctx.protocol_version = meta.protocol_version.clone();
    }
    ctx.meta = meta;

    let outcome: Result<Value, RpcError> = match method {
        "server/discover" => {
            let result = ServerDiscoverResult {
                supported_protocol_versions: handler.supported_protocols().iter().map(|s| (*s).to_owned()).collect(),
                capabilities: handler.capabilities(),
                server_info: handler.server_info(),
                stateless: true,
            };
            serde_json::to_value(result).map_err(|e| RpcError::internal(e.to_string()))
        }
        "initialize" => {
            let init: InitializeParams = serde_json::from_value(req.params).unwrap_or_default();
            let negotiated = init
                .protocol_version
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or(PROTOCOL_LEGACY)
                .to_owned();
            let result = InitializeResult {
                protocol_version: negotiated,
                capabilities: handler.capabilities(),
                server_info: handler.server_info(),
            };
            serde_json::to_value(result).map_err(|e| RpcError::internal(e.to_string()))
        }
        "notifications/initialized" | "ping" => Ok(json!({})),
        "tools/list" => handler.list_tools(&ctx).await.map(|tools| json!({ "tools": tools })),
        "tools/call" => match serde_json::from_value::<ToolCallParams>(req.params) {
            Ok(call) if !call.name.trim().is_empty() => {
                let args = match call.arguments {
                    Value::Object(map) => Value::Object(map),
                    _ => Value::Object(Default::default()),
                };
                match handler.call_tool(&ctx, call.name.trim(), args).await {
                    Ok(res) => serde_json::to_value(res).map_err(|e| RpcError::internal(e.to_string())),
                    Err(err) => Err(err),
                }
            }
            Ok(_) => Err(RpcError::invalid_params("tools/call requires a non-empty tool name")),
            Err(err) => Err(RpcError::invalid_params(format!("invalid tools/call params: {err}"))),
        },
        "resources/list" => match handler.list_resources(&ctx).await {
            Ok(mut resources) => {
                if let Some(catalog) = handler.skills() {
                    for skill_res in catalog.as_resources() {
                        if !resources.iter().any(|existing| existing.uri == skill_res.uri) {
                            resources.push(skill_res);
                        }
                    }
                }
                Ok(json!({ "resources": resources }))
            }
            Err(err) => Err(err),
        },
        "resources/templates/list" => match handler.list_resource_templates(&ctx).await {
            Ok(mut templates) => {
                if let Some(catalog) = handler.skills() {
                    for skill_tpl in catalog.as_resource_templates() {
                        if !templates.iter().any(|existing| existing.uri_template == skill_tpl.uri_template) {
                            templates.push(skill_tpl);
                        }
                    }
                }
                Ok(json!({ "resourceTemplates": templates }))
            }
            Err(err) => Err(err),
        },
        "resources/read" => {
            let read: ResourceReadParams = serde_json::from_value(req.params).unwrap_or_default();
            let uri = read.uri.trim();
            if uri.is_empty() {
                Err(RpcError::invalid_params("missing resource uri"))
            } else if SkillCatalog::is_skill_uri(uri) {
                if let Err(err) = handler.authorize_read(&ctx).await {
                    Err(err)
                } else if let Some(content) = handler.skills().and_then(|c| c.read_resource(uri)) {
                    Ok(json!({ "contents": [content] }))
                } else {
                    Err(RpcError::resource_not_found(format!("skill not found: {uri}")))
                }
            } else {
                handler.read_resource(&ctx, uri).await.map(|content| json!({ "contents": [content] }))
            }
        }
        "skills/list" => match handler.authorize_read(&ctx).await {
            Ok(()) => {
                let params: SkillListParams = serde_json::from_value(req.params).unwrap_or_default();
                let skills = handler.skills().map(|c| c.list(params.tag.as_deref())).unwrap_or_default();
                Ok(json!({ "skills": skills }))
            }
            Err(err) => Err(err),
        },
        "skills/get" => match handler.authorize_read(&ctx).await {
            Ok(()) => {
                let params: SkillGetParams = serde_json::from_value(req.params).unwrap_or_default();
                let key = params
                    .uri
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .or_else(|| params.name.as_deref().map(str::trim).filter(|s| !s.is_empty()));
                match key {
                    None => Err(RpcError::invalid_params("skills/get requires 'uri' or 'name'")),
                    Some(selector) => match handler.skills().and_then(|c| c.get(selector, params.file.as_deref())) {
                        Some(doc) => serde_json::to_value(doc).map_err(|e| RpcError::internal(e.to_string())),
                        None => Err(RpcError::resource_not_found(format!("skill not found: {selector}"))),
                    },
                }
            }
            Err(err) => Err(err),
        },
        other => Err(RpcError::method_not_found(other)),
    };

    Some(match outcome {
        Ok(result) => RpcResponse::ok(id, result),
        Err(err) => RpcResponse::err(id, err),
    })
}

/// Parses and dispatches one JSON-RPC line (for stdio transports).
///
/// Blank lines return `None`; malformed JSON returns a JSON-RPC `-32700` parse error.
pub async fn dispatch_line<H: McpHandler + ?Sized>(handler: &H, ctx: &RequestContext, line: &str) -> Option<RpcResponse> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let req: RpcRequest = match serde_json::from_str(trimmed) {
        Ok(req) => req,
        Err(err) => return Some(RpcResponse::err(RpcId::Null, RpcError::parse_error(format!("parse error: {err}")))),
    };
    dispatch_request(handler, ctx, req).await
}

/// Dispatches one JSON-RPC request object or a JSON-RPC batch array and returns serialized JSON.
///
/// Returns `Ok(None)` when the message (or every item in a batch) is a notification.
pub async fn dispatch_json<H: McpHandler + ?Sized>(handler: &H, ctx: &RequestContext, raw_json: &str) -> Result<Option<String>, RpcError> {
    let parsed: Value = serde_json::from_str(raw_json).map_err(|e| RpcError::parse_error(format!("parse error: {e}")))?;
    match parsed {
        Value::Array(items) => {
            let mut responses = Vec::with_capacity(items.len());
            for item in items {
                let req: RpcRequest = serde_json::from_value(item).map_err(|e| RpcError::invalid_request(format!("invalid batch item: {e}")))?;
                if let Some(resp) = dispatch_request(handler, ctx, req).await {
                    responses.push(resp);
                }
            }
            if responses.is_empty() {
                Ok(None)
            } else {
                serde_json::to_string(&responses).map(Some).map_err(|e| RpcError::internal(e.to_string()))
            }
        }
        other => {
            let req: RpcRequest = serde_json::from_value(other).map_err(|e| RpcError::invalid_request(format!("invalid request: {e}")))?;
            match dispatch_request(handler, ctx, req).await {
                Some(resp) => serde_json::to_string(&resp).map(Some).map_err(|e| RpcError::internal(e.to_string())),
                None => Ok(None),
            }
        }
    }
}

/// All-in-one SEP-2575 + SEP-2243 Streamable HTTP dispatcher combining header validation,
/// single/batch execution, HTTP status mapping (200 / 202 / 400), and response header emission.
pub async fn dispatch_http<H: McpHandler + ?Sized>(handler: &H, headers: &HttpHeaders, bearer_token: Option<String>, body_json: &str) -> HttpReply {
    let validated = match headers.validate_raw_json(body_json) {
        Ok(v) => v,
        Err(err) => {
            let body = serde_json::to_string(&err.response).ok();
            return HttpReply {
                status: err.status,
                headers: err.headers,
                body,
            };
        }
    };

    let ctx = RequestContext {
        protocol_version: Some(validated.negotiated_protocol.clone()),
        meta: RequestMeta::default(),
        bearer_token,
    };

    let mut responses = Vec::with_capacity(validated.requests.len());
    for req in validated.requests.clone() {
        if let Some(resp) = dispatch_request(handler, &ctx, req).await {
            responses.push(resp);
        }
    }

    if responses.is_empty() {
        let resp_headers = build_response_headers(&validated, None);
        return HttpReply {
            status: 202,
            headers: resp_headers,
            body: None,
        };
    }

    let body = if validated.is_batch {
        serde_json::to_string(&responses).ok()
    } else {
        serde_json::to_string(&responses[0]).ok()
    };
    let resp_headers = build_response_headers(&validated, body.as_deref());
    HttpReply {
        status: 200,
        headers: resp_headers,
        body,
    }
}
