//! `vv_vdp_*` live desktop inspection and debugging MCP tools.

use std::path::PathBuf;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_mcp::{ContentBlock, ToolCallResult, ToolDef};
use vibevalley_protocol::{
    Attachment, AttachmentUpload, VdpCaptureScreenshotParams, VdpCommand, VdpDispatchKeyParams, VdpDispatchMouseParams, VdpInputResult, VdpMouseButton,
    VdpMouseEventKind, VdpScreenshotResult, VdpScreenshotTarget, VdpShellNavigateParams, VdpShellResizeParams, VdpShellSetThemeParams, VdpTargetListResult,
    VdpTypeTextParams, VdpUiPressParams, VdpUiPressResult, VdpUiQueryParams, VdpUiQueryResult, VdpVersionInfo, home, ops,
};

use super::{McpServer, format_failure, non_empty_trimmed, redact_result, tool_def};
use crate::auth::Secret;
use crate::client::Failure;
use crate::domains::debug::{self, DEFAULT_RPC_TIMEOUT, DebugTargetArgs, ResolvedEndpoint, VdpWsClient};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VdpOverrideArgs {
    #[serde(default)]
    pub(super) home: Option<String>,
    #[serde(default)]
    pub(super) port: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpDiscoverArgs {
    #[serde(default)]
    extra_homes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpNavigateArgs {
    route: String,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpResizeArgs {
    width: f32,
    height: f32,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ThemeMode {
    Light,
    Dark,
    Toggle,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpThemeArgs {
    mode: ThemeMode,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpUiQueryArgs {
    #[serde(default)]
    test_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    view: Option<String>,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpUiPressArgs {
    test_id: String,
    #[serde(default)]
    view: Option<String>,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpScreenshotArgs {
    #[serde(default)]
    target: Option<VdpScreenshotTarget>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    out_path: Option<String>,
    #[serde(default)]
    upload_attachment: bool,
    #[serde(default)]
    attachment_name: Option<String>,
    #[serde(flatten)]
    vdp: VdpOverrideArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum InputKind {
    Key,
    Type,
    Click,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpInputArgs {
    kind: InputKind,
    #[serde(default)]
    keys: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    x: Option<f32>,
    #[serde(default)]
    y: Option<f32>,
    #[serde(default)]
    right: bool,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpCallArgs {
    method: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

pub(super) fn tool_definitions() -> Vec<ToolDef> {
    let vdp_target_props = || {
        json!({
            "home": { "type": "string", "description": "Optional VibeValley home directory override containing debug.json." },
            "port": { "type": "integer", "minimum": 1, "maximum": 65535, "description": "Optional loopback VDP port override." }
        })
    };

    let merge_vdp_props = |mut props: serde_json::Map<String, Value>| -> Value {
        if let Value::Object(target_map) = vdp_target_props() {
            props.extend(target_map);
        }
        Value::Object(props)
    };

    vec![
        tool_def(
            "vv_vdp_discover",
            "Discover running local debuggable VibeValley instances (never returns auth tokens).",
            json!({
                "type": "object",
                "properties": {
                    "extraHomes": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional extra VibeValley home directories to scan for debug.json."
                    }
                }
            }),
        ),
        tool_def(
            "vv_vdp_targets",
            "List live inspectable VDP targets (shell, view:*, diorama, webview, server) on a running VibeValley app.",
            json!({
                "type": "object",
                "properties": vdp_target_props()
            }),
        ),
        tool_def(
            "vv_vdp_state",
            "Get live Shell.getState snapshot (active route, theme, window bounds, panes) from a running VibeValley app.",
            json!({
                "type": "object",
                "properties": vdp_target_props()
            }),
        ),
        tool_def(
            "vv_vdp_navigate",
            "Navigate the live VibeValley desktop app to a route (e.g. /issues, /library, /farm, /chat, /settings).",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "route": { "type": "string", "description": "Target route path (e.g. /issues, /library, /farm)." }
                })).expect("static schema")),
                "required": ["route"]
            }),
        ),
        tool_def(
            "vv_vdp_resize",
            "Resize the live VibeValley desktop window in logical pixels.",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "width": { "type": "number", "exclusiveMinimum": 0, "description": "Target window width in logical pixels." },
                    "height": { "type": "number", "exclusiveMinimum": 0, "description": "Target window height in logical pixels." }
                })).expect("static schema")),
                "required": ["width", "height"]
            }),
        ),
        tool_def(
            "vv_vdp_theme",
            "Switch or toggle the live VibeValley desktop theme.",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "mode": { "type": "string", "enum": ["light", "dark", "toggle"], "description": "Target theme mode." }
                })).expect("static schema")),
                "required": ["mode"]
            }),
        ),
        tool_def(
            "vv_vdp_ui_query",
            "Query mounted UI nodes and measured layout bounds by testId, text substring, or semantic role.",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "testId": { "type": "string", "description": "Exact or matching testID." },
                    "text": { "type": "string", "description": "Text substring to match." },
                    "role": { "type": "string", "description": "Semantic/accessibility role." },
                    "view": { "type": "string", "description": "Optional view id (e.g. workbench)." }
                })).expect("static schema"))
            }),
        ),
        tool_def(
            "vv_vdp_ui_press",
            "Press a mounted UI element in the live app by its testID without needing pixel coordinates.",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "testId": { "type": "string", "description": "Element testID to press." },
                    "view": { "type": "string", "description": "Optional view id (e.g. workbench)." }
                })).expect("static schema")),
                "required": ["testId"]
            }),
        ),
        tool_def(
            "vv_vdp_screenshot",
            "Capture a live PNG screenshot via Page.captureScreenshot, optionally save to outPath and/or upload as a VibeValley attachment, and return both an inline image block and a text summary.",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "target": { "type": "string", "enum": ["shell", "webview"], "description": "Capture target surface (default shell)." },
                    "width": { "type": "integer", "minimum": 1, "description": "Optional capture width." },
                    "height": { "type": "integer", "minimum": 1, "description": "Optional capture height." },
                    "outPath": { "type": "string", "description": "Optional destination path to save the decoded PNG file." },
                    "uploadAttachment": { "type": "boolean", "description": "When true, upload the captured PNG via attachment.create and include attachmentId in the summary." },
                    "attachmentName": { "type": "string", "description": "Optional filename when uploadAttachment is true (default screenshot.png)." }
                })).expect("static schema"))
            }),
        ),
        tool_def(
            "vv_vdp_input",
            "Inject keyboard or mouse input into the live VibeValley window.",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "kind": { "type": "string", "enum": ["key", "type", "click"], "description": "Input event kind." },
                    "keys": { "type": "string", "description": "Keystroke descriptor when kind is 'key' (e.g. cmd-k, enter, escape)." },
                    "text": { "type": "string", "description": "UTF-8 text to type when kind is 'type'." },
                    "x": { "type": "number", "description": "Logical X coordinate when kind is 'click'." },
                    "y": { "type": "number", "description": "Logical Y coordinate when kind is 'click'." },
                    "right": { "type": "boolean", "description": "Use right mouse button instead of left when kind is 'click'." }
                })).expect("static schema")),
                "required": ["kind"]
            }),
        ),
        tool_def(
            "vv_vdp_call",
            "Send a raw VDP JSON-RPC 2.0 command (escape hatch for any VDP method).",
            json!({
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "method": { "type": "string", "description": "VDP JSON-RPC method name (e.g. Page.getMetrics, UI.getTree, Server.slice)." },
                    "params": { "type": "object", "description": "Optional JSON params object." },
                    "sessionId": { "type": "string", "description": "Optional attached VDP target session id." }
                })).expect("static schema")),
                "required": ["method"]
            }),
        ),
    ]
}

impl McpServer {
    pub(super) fn resolve_vdp_target(&self, override_args: &VdpOverrideArgs) -> DebugTargetArgs {
        let override_home = non_empty_trimmed(override_args.home.clone()).map(PathBuf::from);
        if let Some(port) = override_args.port {
            DebugTargetArgs {
                home: override_home.or_else(|| self.defaults.home.clone()),
                port: Some(port),
                url: None,
            }
        } else if let Some(home_dir) = override_home {
            DebugTargetArgs {
                home: Some(home_dir),
                port: None,
                url: None,
            }
        } else {
            self.defaults.clone()
        }
    }

    async fn with_vdp_ws<F, Fut>(&self, override_args: &VdpOverrideArgs, f: F) -> ToolCallResult
    where
        F: FnOnce(VdpWsClient) -> Fut,
        Fut: std::future::Future<Output = Result<(ToolCallResult, VdpWsClient), (Failure, VdpWsClient)>>,
    {
        let target = self.resolve_vdp_target(override_args);
        let client = self.client.read().await;
        let endpoint: ResolvedEndpoint = match debug::resolve_endpoint(&client, &target) {
            Ok(ep) => ep,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
        };
        let secrets = Self::known_secrets(&client, Some(&endpoint));
        let ws = match VdpWsClient::connect(&endpoint).await {
            Ok(ws) => ws,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &secrets),
        };
        let result = match f(ws).await {
            Ok((res, ws)) => {
                ws.close().await;
                res
            }
            Err((failure, ws)) => {
                ws.close().await;
                ToolCallResult::error(format_failure(&failure))
            }
        };
        redact_result(result, &secrets)
    }

    pub(super) async fn tool_vdp_discover(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpDiscoverArgs = match Self::decode_args("vv_vdp_discover", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let client = self.client.read().await;
        let mut extra: Vec<PathBuf> = args
            .extra_homes
            .into_iter()
            .filter_map(|p| {
                let trimmed = p.trim();
                (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
            })
            .collect();
        if let Some(default_home) = &self.defaults.home {
            extra.push(default_home.clone());
        }
        extra.push(client.home.clone());

        let discovered = home::discover_local_debug_endpoints(&extra);
        let tokens: Vec<Secret> = discovered.iter().map(|ep| Secret::new(ep.token.clone())).collect();
        // `VdpEndpointInfo::version_info()` structurally omits `token`.
        let instances: Vec<VdpVersionInfo> = discovered.into_iter().map(|ep| ep.version_info()).collect();
        let mut secrets = Self::known_secrets(&client, None);
        for tok in &tokens {
            secrets.push(tok);
        }
        redact_result(
            ToolCallResult::json(&json!({
                "count": instances.len(),
                "instances": instances,
            })),
            &secrets,
        )
    }

    pub(super) async fn tool_vdp_targets(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpOverrideArgs = match Self::decode_args("vv_vdp_targets", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.with_vdp_ws(&args, |mut ws| async move {
            match ws.call_typed::<VdpTargetListResult>(&VdpCommand::TargetList, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((ToolCallResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_state(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpOverrideArgs = match Self::decode_args("vv_vdp_state", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.with_vdp_ws(&args, |mut ws| async move {
            match ws.call_command(&VdpCommand::ShellGetState, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((ToolCallResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_navigate(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpNavigateArgs = match Self::decode_args("vv_vdp_navigate", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let route = args.route.trim().to_string();
        if route.is_empty() {
            return ToolCallResult::error("vv_vdp_navigate requires a non-empty route");
        }
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::ShellNavigate(VdpShellNavigateParams { route });
            match ws.call_command(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((ToolCallResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_resize(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpResizeArgs = match Self::decode_args("vv_vdp_resize", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        if !args.width.is_finite() || !args.height.is_finite() || args.width <= 0.0 || args.height <= 0.0 {
            return ToolCallResult::error("vv_vdp_resize requires positive finite width and height");
        }
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::ShellResize(VdpShellResizeParams {
                width: args.width,
                height: args.height,
            });
            match ws.call_command(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((ToolCallResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_theme(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpThemeArgs = match Self::decode_args("vv_vdp_theme", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let dark = match args.mode {
            ThemeMode::Dark => Some(true),
            ThemeMode::Light => Some(false),
            ThemeMode::Toggle => None,
        };
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::ShellSetTheme(VdpShellSetThemeParams { dark });
            match ws.call_command(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((ToolCallResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_ui_query(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpUiQueryArgs = match Self::decode_args("vv_vdp_ui_query", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::UiQuery(VdpUiQueryParams {
                test_id: non_empty_trimmed(args.test_id),
                text: non_empty_trimmed(args.text),
                role: non_empty_trimmed(args.role),
                view: non_empty_trimmed(args.view),
            });
            match ws.call_typed::<VdpUiQueryResult>(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((ToolCallResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_ui_press(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpUiPressArgs = match Self::decode_args("vv_vdp_ui_press", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let test_id = args.test_id.trim().to_string();
        if test_id.is_empty() {
            return ToolCallResult::error("vv_vdp_ui_press requires a non-empty testId");
        }
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::UiPress(VdpUiPressParams {
                test_id,
                view: non_empty_trimmed(args.view),
            });
            match ws.call_typed::<VdpUiPressResult>(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((ToolCallResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_screenshot(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpScreenshotArgs = match Self::decode_args("vv_vdp_screenshot", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let out_path = non_empty_trimmed(args.out_path).map(PathBuf::from);
        let upload_attachment = args.upload_attachment;
        let attachment_name = non_empty_trimmed(args.attachment_name)
            .or_else(|| out_path.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()).map(ToString::to_string))
            .unwrap_or_else(|| "screenshot.png".into());

        if upload_attachment {
            self.refresh_client().await;
        }

        let target = self.resolve_vdp_target(&args.vdp);
        let client = self.client.read().await;
        let endpoint = match debug::resolve_endpoint(&client, &target) {
            Ok(ep) => ep,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
        };
        let secrets = Self::known_secrets(&client, Some(&endpoint));
        let mut ws = match VdpWsClient::connect(&endpoint).await {
            Ok(ws) => ws,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &secrets),
        };

        let cmd = VdpCommand::PageCaptureScreenshot(VdpCaptureScreenshotParams {
            target: args.target,
            width: args.width,
            height: args.height,
        });
        let shot_res: Result<VdpScreenshotResult, Failure> = ws.call_typed(&cmd, DEFAULT_RPC_TIMEOUT).await;
        ws.close().await;

        let shot = match shot_res {
            Ok(s) => s,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &secrets),
        };

        let raw_b64 = shot.data.trim().to_string();
        let bytes = match base64::engine::general_purpose::STANDARD.decode(&raw_b64) {
            Ok(b) => b,
            Err(err) => {
                return redact_result(ToolCallResult::error(format!("Decode: invalid screenshot base64 payload: {err}")), &secrets);
            }
        };

        if let Some(ref path) = out_path {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty())
                && let Err(err) = std::fs::create_dir_all(parent)
            {
                return redact_result(
                    ToolCallResult::error(format!("File: failed to create directory {}: {err}", parent.display())),
                    &secrets,
                );
            }
            if let Err(err) = std::fs::write(path, &bytes) {
                return redact_result(ToolCallResult::error(format!("File: failed to write {}: {err}", path.display())), &secrets);
            }
        }

        let mime = if shot.mime.trim().is_empty() { "image/png".to_string() } else { shot.mime };

        let uploaded: Option<Attachment> = if upload_attachment {
            let req = AttachmentUpload {
                name: attachment_name,
                r#type: mime.clone(),
                data: raw_b64.clone(),
            };
            match client.ask::<ops::AttachmentCreate>(&req).await {
                Ok(att) => Some(att),
                Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &secrets),
            }
        } else {
            None
        };

        let mut summary = format!("Captured {}x{} screenshot ({mime}, {} bytes)", shot.width, shot.height, bytes.len());
        if let Some(ref path) = out_path {
            summary.push_str(&format!(" saved to {}", path.display()));
        }
        if let Some(ref att) = uploaded {
            summary.push_str(&format!(" attachmentId={}", att.id));
        }

        redact_result(
            ToolCallResult {
                content: vec![
                    ContentBlock::Image {
                        data: raw_b64,
                        mime_type: mime,
                    },
                    ContentBlock::Text { text: summary },
                ],
                is_error: false,
            },
            &secrets,
        )
    }

    pub(super) async fn tool_vdp_input(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpInputArgs = match Self::decode_args("vv_vdp_input", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let cmd = match args.kind {
            InputKind::Key => {
                let Some(keys) = non_empty_trimmed(args.keys) else {
                    return ToolCallResult::error("vv_vdp_input with kind='key' requires non-empty 'keys'");
                };
                VdpCommand::InputDispatchKey(VdpDispatchKeyParams { keys })
            }
            InputKind::Type => {
                let Some(text) = args.text else {
                    return ToolCallResult::error("vv_vdp_input with kind='type' requires 'text'");
                };
                VdpCommand::InputTypeText(VdpTypeTextParams { text })
            }
            InputKind::Click => {
                let (Some(x), Some(y)) = (args.x, args.y) else {
                    return ToolCallResult::error("vv_vdp_input with kind='click' requires numeric 'x' and 'y'");
                };
                if !x.is_finite() || !y.is_finite() {
                    return ToolCallResult::error("vv_vdp_input click coordinates must be finite numbers");
                }
                VdpCommand::InputDispatchMouse(VdpDispatchMouseParams {
                    kind: VdpMouseEventKind::Click,
                    x,
                    y,
                    button: Some(if args.right { VdpMouseButton::Right } else { VdpMouseButton::Left }),
                    end_x: None,
                    end_y: None,
                })
            }
        };

        self.with_vdp_ws(&args.target, |mut ws| async move {
            match ws.call_typed::<VdpInputResult>(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((ToolCallResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    pub(super) async fn tool_vdp_call(&self, raw_args: Value) -> ToolCallResult {
        let args: VdpCallArgs = match Self::decode_args("vv_vdp_call", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let method = args.method.trim().to_string();
        if method.is_empty() {
            return ToolCallResult::error("vv_vdp_call requires a non-empty method");
        }
        let params = args.params.filter(|v| !v.is_null()).unwrap_or_else(|| json!({}));
        let session_id = non_empty_trimmed(args.session_id);
        self.with_vdp_ws(&args.target, |mut ws| async move {
            match ws.call_raw(&method, params, session_id, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((ToolCallResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }
}
