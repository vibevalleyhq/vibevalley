//! `debug`: CDP-like live remote inspection and automation over VDP (VibeValley DevTools Protocol).

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use clap::{Args, Subcommand, ValueEnum};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;
use vibevalley_protocol::{
    Next, VdpCaptureScreenshotParams, VdpCommand, VdpDispatchKeyParams, VdpDispatchMouseParams, VdpEndpointInfo, VdpError, VdpEvent, VdpInputResult,
    VdpMouseButton, VdpMouseEventKind, VdpNotification, VdpRequest, VdpScreenshotResult, VdpScreenshotTarget, VdpServerInvokeParams, VdpServerSliceParams,
    VdpShellNavigateParams, VdpShellResizeParams, VdpShellSetThemeParams, VdpTarget, VdpTargetListResult, VdpTypeTextParams, VdpUiBounds, VdpUiGetTreeParams,
    VdpUiNode, VdpUiPressParams, VdpUiPressResult, VdpUiQueryParams, VdpUiQueryResult, VdpUiTreeResult, VdpUiWaitForParams, VdpUiWaitForResult, VdpVersionInfo,
    VdpWireMessage, home,
};

use crate::auth::Secret;
use crate::client::{Client, Done, Failure, decode_failure, exit, no_dry_run};
use crate::output::{line, out, read_json_input};

pub(crate) const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct DebugCmd {
    #[command(flatten)]
    pub target: DebugTargetArgs,

    #[command(subcommand)]
    pub action: DebugAction,
}

#[derive(Debug, Clone, Default, Args)]
pub struct DebugTargetArgs {
    /// VibeValley home directory containing debug.json
    #[arg(long, global = true, value_name = "DIR")]
    pub home: Option<PathBuf>,

    /// Loopback VDP port (reads token from --token or matching debug.json)
    #[arg(long, global = true, value_name = "PORT")]
    pub port: Option<u16>,

    /// Explicit VDP WebSocket or HTTP URL (e.g. ws://127.0.0.1:9222/devtools)
    #[arg(long, global = true, value_name = "URL")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ScreenshotTargetArg {
    Shell,
    Webview,
}

impl From<ScreenshotTargetArg> for VdpScreenshotTarget {
    fn from(arg: ScreenshotTargetArg) -> Self {
        match arg {
            ScreenshotTargetArg::Shell => VdpScreenshotTarget::Shell,
            ScreenshotTargetArg::Webview => VdpScreenshotTarget::Webview,
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum DebugAction {
    /// Discover all live local debuggable VibeValley instances
    #[command(after_help = "Examples:\n  vibevalley debug discover\n  vibevalley debug discover --home /tmp/vv-sandbox --json")]
    Discover,

    /// Fetch VDP version and host metadata via GET /json/version
    #[command(after_help = "Examples:\n  vibevalley debug version\n  vibevalley debug version --port 9222 --json")]
    Version,

    /// List live inspectable targets (Target.list)
    #[command(after_help = "Examples:\n  vibevalley debug targets\n  vibevalley debug targets --home /tmp/vv-sandbox --json")]
    Targets,

    /// Inspect live Shell state snapshot (Shell.getState)
    #[command(after_help = "Examples:\n  vibevalley debug state\n  vibevalley debug state --json")]
    State,

    /// Navigate the desktop workbench to a route (Shell.navigate)
    #[command(after_help = "Examples:\n  vibevalley debug navigate /library\n  vibevalley debug navigate /issues --json")]
    Navigate {
        /// Target route path (e.g. /library, /issues, /channels)
        route: String,
    },

    /// Resize the desktop window (Shell.resize)
    #[command(after_help = "Examples:\n  vibevalley debug resize 1440 900\n  vibevalley debug resize 1280 800 --json")]
    Resize {
        /// Target window width in logical pixels
        width: f32,
        /// Target window height in logical pixels
        height: f32,
    },

    /// Set or toggle the desktop theme (Shell.setTheme)
    #[command(after_help = "Examples:\n  vibevalley debug theme --dark\n  vibevalley debug theme --light\n  vibevalley debug theme --toggle")]
    Theme {
        /// Switch to dark theme
        #[arg(long, conflicts_with_all = ["light", "toggle"])]
        dark: bool,
        /// Switch to light theme
        #[arg(long, conflicts_with_all = ["dark", "toggle"])]
        light: bool,
        /// Toggle the active theme (default when no flag is set)
        #[arg(long, conflicts_with_all = ["dark", "light"])]
        toggle: bool,
    },

    /// Dispatch a key chord to the active window (Input.dispatchKey)
    #[command(after_help = "Examples:\n  vibevalley debug key cmd-k\n  vibevalley debug key enter --json")]
    Key {
        /// Keystroke descriptor (e.g. cmd-1, cmd-k, escape, enter)
        keys: String,
    },

    /// Type text into the focused element (Input.typeText)
    #[command(after_help = "Examples:\n  vibevalley debug type \"hello world\"\n  vibevalley debug type \"/library\" --json")]
    Type {
        /// UTF-8 text to type
        text: String,
    },

    /// Dispatch a mouse click at logical window coordinates (Input.dispatchMouse)
    #[command(after_help = "Examples:\n  vibevalley debug click 320 180\n  vibevalley debug click 320 180 --right --json")]
    Click {
        /// Logical X coordinate
        x: f32,
        /// Logical Y coordinate
        y: f32,
        /// Use right mouse button instead of left
        #[arg(long)]
        right: bool,
    },

    /// Capture a live screenshot and write the decoded image to disk (Page.captureScreenshot)
    #[command(
        after_help = "Examples:\n  vibevalley debug screenshot /tmp/shell.png\n  vibevalley debug screenshot /tmp/web.png --target webview --width 1280 --height 720"
    )]
    Screenshot {
        /// Destination file path for the captured PNG/JPEG
        output: PathBuf,
        /// Capture target surface (shell or webview)
        #[arg(long, value_enum)]
        target: Option<ScreenshotTargetArg>,
        /// Optional requested capture width
        #[arg(long)]
        width: Option<u32>,
        /// Optional requested capture height
        #[arg(long)]
        height: Option<u32>,
    },

    /// Inspect the live UI node tree from vdpProbe (UI.getTree)
    #[command(after_help = "Examples:\n  vibevalley debug ui-tree\n  vibevalley debug ui-tree --view workbench --max-depth 4 --json")]
    UiTree {
        /// Optional view id (e.g. workbench)
        #[arg(long)]
        view: Option<String>,
        /// Optional maximum tree depth
        #[arg(long)]
        max_depth: Option<u32>,
    },

    /// Query mounted UI nodes and bounds by testID, text, or role (UI.query)
    #[command(
        after_help = "Examples:\n  vibevalley debug ui-query --test-id nav-library\n  vibevalley debug ui-query --text Library --role button --view workbench"
    )]
    UiQuery {
        /// Match nodes by testID
        #[arg(long)]
        test_id: Option<String>,
        /// Match nodes containing this text substring
        #[arg(long)]
        text: Option<String>,
        /// Match nodes by accessibility/semantic role
        #[arg(long)]
        role: Option<String>,
        /// Optional view id (e.g. workbench)
        #[arg(long)]
        view: Option<String>,
    },

    /// Press a UI element by testID without pixel coordinates (UI.press)
    #[command(after_help = "Examples:\n  vibevalley debug ui-press nav-library\n  vibevalley debug ui-press nav-library --view workbench --json")]
    UiPress {
        /// Element testID to press
        test_id: String,
        /// Optional view id (e.g. workbench)
        #[arg(long)]
        view: Option<String>,
    },

    /// Wait until a UI node matching testID or text appears (UI.waitFor)
    #[command(
        after_help = "Examples:\n  vibevalley debug ui-wait --test-id library-grid\n  vibevalley debug ui-wait --text \"No issues\" --timeout-ms 5000 --json"
    )]
    UiWait {
        /// Wait for a node matching this testID
        #[arg(long)]
        test_id: Option<String>,
        /// Wait for a node containing this text substring
        #[arg(long)]
        text: Option<String>,
        /// Optional view id (e.g. workbench)
        #[arg(long)]
        view: Option<String>,
        /// Wait timeout in milliseconds
        #[arg(long, default_value_t = 5000)]
        timeout_ms: u64,
    },

    /// Fetch a live server state slice through the VDP host (Server.slice)
    #[command(after_help = "Examples:\n  vibevalley debug server-slice board\n  vibevalley debug server-slice sessions --json")]
    ServerSlice {
        /// Slice name (board, sessions, collab, inbox, ops, farm)
        name: String,
    },

    /// Invoke a server RPC method through the VDP host (Server.invoke)
    #[command(after_help = "Examples:\n  vibevalley debug server-rpc debug.snapshot\n  vibevalley debug server-rpc issue.list '{\"limit\":5}' --json")]
    ServerRpc {
        /// Server RPC method name (e.g. debug.snapshot, issue.list)
        method: String,
        /// Optional JSON params inline, '-' for stdin, or '@path' for file
        params: Option<String>,
    },

    /// Send a raw JSON-RPC 2.0 VDP command (any method and params JSON)
    #[command(after_help = "Examples:\n  vibevalley debug call Page.getMetrics\n  vibevalley debug call Shell.navigate '{\"route\":\"/library\"}' --json")]
    Call {
        /// VDP method name (e.g. Target.list, Shell.getState, Page.getMetrics)
        method: String,
        /// Optional JSON params inline, '-' for stdin, or '@path' for file
        params: Option<String>,
        /// Optional attached target session id
        #[arg(long)]
        session_id: Option<String>,
    },

    /// Enable Log.enable and stream live VDP events until Ctrl+C or --limit
    #[command(after_help = "Examples:\n  vibevalley debug watch\n  vibevalley debug watch --limit 20 --json")]
    Watch {
        /// Stop after printing this many events
        #[arg(long)]
        limit: Option<usize>,
    },
}

/// Resolved VDP target coordinates and optional bearer token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedEndpoint {
    pub(crate) http_url: String,
    pub(crate) ws_url: String,
    pub(crate) token: Option<Secret>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotSaved {
    path: String,
    mime: String,
    width: u32,
    height: u32,
    bytes: usize,
}

fn debug_start_hint() -> Vec<Next> {
    vec![Next {
        say: "Start VibeValley with --remote-debugging-port=<port> or VIBEVALLEY_DEBUG_PORT=0".into(),
        run: None,
    }]
}

fn normalize_explicit_url(raw: &str, flag_token: Option<Secret>) -> Result<ResolvedEndpoint, Failure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Failure::usage("InvalidValue", "--url must not be empty"));
    }
    let parsed = Url::parse(trimmed).map_err(|e| Failure::usage("InvalidValue", format!("invalid --url {trimmed:?}: {e}")))?;
    if parsed.host_str().is_none() {
        return Err(Failure::usage("InvalidValue", format!("--url must include a host: {trimmed:?}")));
    }

    let query_token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .filter(|t| !t.trim().is_empty())
        .map(Secret::new);
    let token = flag_token.and_then(|t| t.trimmed()).or(query_token);

    let (http_scheme, ws_scheme) = match parsed.scheme() {
        "ws" | "http" => ("http", "ws"),
        "wss" | "https" => ("https", "wss"),
        other => {
            return Err(Failure::usage(
                "InvalidValue",
                format!("unsupported --url scheme {other:?}; expected ws://, wss://, http://, or https://"),
            ));
        }
    };

    let mut http = parsed.clone();
    let _ = http.set_scheme(http_scheme);
    http.set_query(None);
    http.set_fragment(None);
    let clean_path = http.path().trim_end_matches('/').to_string();
    if clean_path == "/devtools" {
        http.set_path("");
    } else if let Some(prefix) = clean_path.strip_suffix("/devtools") {
        http.set_path(prefix);
    } else {
        http.set_path(&clean_path);
    }
    let http_url = http.as_str().trim_end_matches('/').to_string();

    let mut ws = parsed;
    let _ = ws.set_scheme(ws_scheme);
    ws.set_fragment(None);
    // Strip token query parameter from the stored ws_url; auth is sent via Authorization header.
    let kept_pairs: Vec<(String, String)> = ws
        .query_pairs()
        .filter(|(k, _)| k != "token")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept_pairs.is_empty() {
        ws.set_query(None);
    } else {
        let mut ser = ws.query_pairs_mut();
        ser.clear();
        for (k, v) in kept_pairs {
            ser.append_pair(&k, &v);
        }
    }
    if ws.path().is_empty() || ws.path() == "/" {
        ws.set_path("/devtools");
    }
    let ws_url = ws.into();

    Ok(ResolvedEndpoint { http_url, ws_url, token })
}

fn endpoint_from_info(info: VdpEndpointInfo, flag_token: Option<Secret>) -> ResolvedEndpoint {
    let token = flag_token.and_then(|t| t.trimmed()).or_else(|| Secret::new(info.token).trimmed());
    ResolvedEndpoint {
        http_url: info.http_url.trim_end_matches('/').to_string(),
        ws_url: info.ws_url,
        token,
    }
}

fn format_ambiguous_endpoints(endpoints: &[VdpEndpointInfo]) -> String {
    let mut msg = String::from("multiple live VDP instances found; select one with --home <DIR> or --port <PORT>:");
    for info in endpoints {
        let _ = write!(msg, "\n  channel={} pid={} port={} home={}", info.channel, info.pid, info.port, info.home);
    }
    msg
}

fn resolve_endpoint_with<FRead, FDiscover>(
    target: &DebugTargetArgs,
    flag_token: Option<Secret>,
    current_home: &Path,
    read_home: FRead,
    discover_local: FDiscover,
) -> Result<ResolvedEndpoint, Failure>
where
    FRead: Fn(&Path) -> Option<VdpEndpointInfo>,
    FDiscover: Fn(&[PathBuf]) -> Vec<VdpEndpointInfo>,
{
    let flag_token = flag_token.and_then(|t| t.trimmed());

    if let Some(raw_url) = target.url.as_deref() {
        return normalize_explicit_url(raw_url, flag_token);
    }

    if let Some(port) = target.port {
        let token = if flag_token.is_some() {
            flag_token
        } else {
            let mut extra = Vec::new();
            if let Some(h) = &target.home {
                extra.push(h.clone());
            }
            extra.push(current_home.to_path_buf());
            let matched = target
                .home
                .as_deref()
                .and_then(&read_home)
                .filter(|info| info.port == port)
                .or_else(|| read_home(current_home).filter(|info| info.port == port))
                .or_else(|| discover_local(&extra).into_iter().find(|info| info.port == port));
            matched.and_then(|info| Secret::new(info.token).trimmed())
        };
        return Ok(ResolvedEndpoint {
            http_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}/devtools"),
            token,
        });
    }

    if let Some(home_dir) = &target.home {
        let Some(info) = read_home(home_dir) else {
            let mut failure = Failure::new(
                exit::UNREACHABLE,
                "Unreachable",
                format!("no live VDP debug endpoint in {} (missing or stale debug.json)", home_dir.display()),
            );
            failure.next = debug_start_hint();
            return Err(failure);
        };
        return Ok(endpoint_from_info(info, flag_token));
    }

    if let Some(info) = read_home(current_home) {
        return Ok(endpoint_from_info(info, flag_token));
    }

    let mut discovered = discover_local(&[]);
    match discovered.len() {
        0 => {
            let mut failure = Failure::new(exit::UNREACHABLE, "Unreachable", "no live VDP debug endpoints found");
            failure.next = debug_start_hint();
            Err(failure)
        }
        1 => Ok(endpoint_from_info(discovered.remove(0), flag_token)),
        _ => Err(Failure::usage("AmbiguousTarget", format_ambiguous_endpoints(&discovered))),
    }
}

pub(crate) fn resolve_endpoint(client: &Client, target: &DebugTargetArgs) -> Result<ResolvedEndpoint, Failure> {
    resolve_endpoint_with(
        target,
        client.flag_token().cloned(),
        &client.home,
        home::read_debug_endpoint,
        home::discover_local_debug_endpoints,
    )
}

fn is_loopback_url(raw: &str) -> bool {
    Url::parse(raw).ok().and_then(|u| u.host_str().map(str::to_owned)).is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

fn build_http_client(base_url: &str) -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(5));
    if is_loopback_url(base_url) {
        builder = builder.no_proxy();
    }
    builder.build().expect("reqwest VDP client")
}

fn vdp_error_failure(err: VdpError) -> Failure {
    let (code, tag) = match err.code {
        VdpError::UNAUTHORIZED => (exit::REFUSED, "Unauthorized"),
        VdpError::INVALID_PARAMS | VdpError::INVALID_REQUEST | VdpError::PARSE_ERROR => (exit::USAGE, "InvalidInput"),
        VdpError::METHOD_NOT_FOUND => (exit::MISSING, "MethodNotFound"),
        VdpError::TIMEOUT => (exit::OTHER, "Timeout"),
        VdpError::UNAVAILABLE => (exit::REFUSED, "Unavailable"),
        _ => (exit::OTHER, "VdpError"),
    };
    Failure::new(code, tag, format!("{} (code {})", err.message, err.code))
}

fn http_status_failure(status: u16, body: &str) -> Failure {
    let (code, tag) = match status {
        401 => (exit::REFUSED, "Unauthorized"),
        403 => (exit::REFUSED, "Forbidden"),
        404 => (exit::MISSING, "Missing"),
        400 => (exit::USAGE, "InvalidInput"),
        _ => (exit::OTHER, "Server"),
    };
    let text = body.trim();
    let msg = if text.is_empty() {
        format!("VDP HTTP request failed with status {status}")
    } else {
        text.to_string()
    };
    let mut failure = Failure::new(code, tag, msg);
    failure.status = Some(status);
    failure
}

pub(crate) struct VdpWsClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    buffered_events: Vec<VdpEvent>,
}

impl VdpWsClient {
    pub(crate) async fn connect(endpoint: &ResolvedEndpoint) -> Result<Self, Failure> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut request = endpoint
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| Failure::usage("InvalidValue", format!("invalid VDP WebSocket URL {:?}: {e}", endpoint.ws_url)))?;
        if let Some(tok) = endpoint.token.as_ref().filter(|t| !t.is_empty()) {
            let header_value = format!("Bearer {}", tok.expose())
                .parse()
                .map_err(|_| Failure::usage("InvalidValue", "VDP token contains invalid HTTP header characters"))?;
            request.headers_mut().insert("Authorization", header_value);
        }
        request.headers_mut().insert("X-VibeValley-Client", "cli".parse().expect("valid static header"));

        let connect_res = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(request))
            .await
            .map_err(|_| Failure::new(exit::UNREACHABLE, "Unreachable", format!("timed out connecting to {}", endpoint.ws_url)))?;

        let (ws, _) = match connect_res {
            Ok(pair) => pair,
            Err(WsError::Http(resp)) => {
                let status = resp.status().as_u16();
                let body = resp.body().as_deref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
                return Err(http_status_failure(status, &body));
            }
            Err(err) => {
                let mut failure = Failure::new(exit::UNREACHABLE, "Unreachable", format!("cannot connect to VDP at {}: {err}", endpoint.ws_url));
                failure.next = debug_start_hint();
                return Err(failure);
            }
        };

        Ok(Self {
            ws,
            next_id: 1,
            buffered_events: Vec::new(),
        })
    }

    pub(crate) async fn call_raw(&mut self, method: &str, params: Value, session_id: Option<String>, timeout: Duration) -> Result<Value, Failure> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let req = VdpRequest::new(id, method, params, session_id);
        let wire = serde_json::to_string(&req).map_err(decode_failure)?;
        self.ws
            .send(WsMessage::Text(wire.into()))
            .await
            .map_err(|e| Failure::new(exit::UNREACHABLE, "Disconnected", format!("failed to send VDP request {method}: {e}")))?;

        tokio::time::timeout(timeout, async {
            loop {
                match self.ws.next().await {
                    Some(Ok(WsMessage::Text(text))) => {
                        let msg: VdpWireMessage = serde_json::from_str(text.as_str()).map_err(decode_failure)?;
                        match msg {
                            VdpWireMessage::Response(res) if res.id == id => {
                                return res.into_result().map_err(vdp_error_failure);
                            }
                            VdpWireMessage::Response(_) => continue,
                            VdpWireMessage::Event(ev) => self.buffered_events.push(ev),
                        }
                    }
                    Some(Ok(WsMessage::Ping(payload))) => {
                        let _ = self.ws.send(WsMessage::Pong(payload)).await;
                    }
                    Some(Ok(WsMessage::Pong(_) | WsMessage::Binary(_) | WsMessage::Frame(_))) => continue,
                    Some(Ok(WsMessage::Close(_))) | None => {
                        return Err(Failure::new(
                            exit::UNREACHABLE,
                            "Disconnected",
                            format!("VDP connection closed while waiting for {method}"),
                        ));
                    }
                    Some(Err(err)) => {
                        return Err(Failure::new(exit::UNREACHABLE, "Disconnected", format!("VDP WebSocket error: {err}")));
                    }
                }
            }
        })
        .await
        .map_err(|_| Failure::new(exit::OTHER, "Timeout", format!("VDP call {method} timed out after {}ms", timeout.as_millis())))?
    }

    pub(crate) async fn call_command(&mut self, cmd: &VdpCommand, timeout: Duration) -> Result<Value, Failure> {
        self.call_raw(cmd.method(), cmd.to_params(), None, timeout).await
    }

    pub(crate) async fn call_typed<T: DeserializeOwned>(&mut self, cmd: &VdpCommand, timeout: Duration) -> Result<T, Failure> {
        let value = self.call_command(cmd, timeout).await?;
        serde_json::from_value(value).map_err(decode_failure)
    }

    fn drain_buffered_events(&mut self) -> Vec<VdpEvent> {
        std::mem::take(&mut self.buffered_events)
    }

    async fn next_event(&mut self) -> Result<Option<VdpEvent>, Failure> {
        loop {
            match self.ws.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    let msg: VdpWireMessage = serde_json::from_str(text.as_str()).map_err(decode_failure)?;
                    match msg {
                        VdpWireMessage::Event(ev) => return Ok(Some(ev)),
                        VdpWireMessage::Response(_) => continue,
                    }
                }
                Some(Ok(WsMessage::Ping(payload))) => {
                    let _ = self.ws.send(WsMessage::Pong(payload)).await;
                }
                Some(Ok(WsMessage::Pong(_) | WsMessage::Binary(_) | WsMessage::Frame(_))) => continue,
                Some(Ok(WsMessage::Close(_))) | None => return Ok(None),
                Some(Err(err)) => {
                    return Err(Failure::new(exit::UNREACHABLE, "Disconnected", format!("VDP WebSocket error: {err}")));
                }
            }
        }
    }

    pub(crate) async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut term) = sigterm {
                    term.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn version_line(v: &VdpVersionInfo) -> String {
    line(&[
        &v.channel,
        &v.app_version,
        &format!("pid {}", v.pid),
        &format!("port {}", v.port),
        &v.ws_url,
        &v.home,
    ])
}

fn target_line(t: &VdpTarget) -> String {
    line(&[
        &t.id,
        t.kind.as_str(),
        &t.title,
        t.url.as_deref().unwrap_or(""),
        if t.attached { "attached" } else { "" },
    ])
}

fn format_bounds(b: VdpUiBounds) -> String {
    format!("{{x: {}, y: {}, width: {}, height: {}}}", b.x, b.y, b.width, b.height)
}

fn format_ui_node_line(node: &VdpUiNode, indent: usize) -> String {
    let prefix = "  ".repeat(indent);
    let mut parts: Vec<String> = Vec::new();
    if let Some(id) = &node.test_id {
        parts.push(format!("#{id}"));
    }
    if let Some(role) = &node.role {
        parts.push(format!("[{role}]"));
    }
    if let Some(text) = &node.text
        && !text.is_empty()
    {
        parts.push(format!("{text:?}"));
    }
    if let Some(bounds) = node.bounds {
        parts.push(format_bounds(bounds));
    }
    if node.pressable == Some(true) {
        parts.push("pressable".into());
    }
    if parts.is_empty() {
        format!("{prefix}(node)")
    } else {
        format!("{prefix}{}", parts.join("  "))
    }
}

fn append_ui_tree(out_lines: &mut Vec<String>, nodes: &[VdpUiNode], indent: usize) {
    for node in nodes {
        out_lines.push(format_ui_node_line(node, indent));
        if let Some(children) = &node.children {
            append_ui_tree(out_lines, children, indent + 1);
        }
    }
}

fn format_ui_tree(tree: &VdpUiTreeResult) -> String {
    let mut lines = vec![line(&["view", &tree.view, tree.route.as_deref().unwrap_or("")])];
    append_ui_tree(&mut lines, &tree.nodes, 1);
    lines.join("\n")
}

fn format_ui_query(res: &VdpUiQueryResult) -> String {
    if res.nodes.is_empty() {
        return line(&["view", &res.view, "0 matches"]);
    }
    let mut lines = vec![line(&["view", &res.view, &format!("{} matches", res.nodes.len())])];
    for node in &res.nodes {
        lines.push(format_ui_node_line(node, 1));
    }
    lines.join("\n")
}

fn format_ui_wait(res: &VdpUiWaitForResult) -> String {
    let status = if res.matched { "matched" } else { "timed-out" };
    let mut lines = vec![line(&["view", &res.view, status, &format!("{}ms", res.elapsed_ms)])];
    if let Some(node) = &res.node {
        lines.push(format_ui_node_line(node, 1));
    }
    lines.join("\n")
}

fn format_value_pretty(val: &Value) -> String {
    serde_json::to_string_pretty(val).unwrap_or_else(|_| val.to_string())
}

fn format_shell_state(val: &Value) -> String {
    let Some(obj) = val.as_object() else {
        return format_value_pretty(val);
    };
    let mut summary = Vec::new();
    if let Some(route) = obj.get("route").and_then(Value::as_str) {
        summary.push(format!("route {route}"));
    }
    if let Some(dark) = obj.get("themeDark").or_else(|| obj.get("dark")).and_then(Value::as_bool) {
        summary.push(format!("theme {}", if dark { "dark" } else { "light" }));
    }
    if let (Some(w), Some(h)) = (obj.get("width").and_then(Value::as_f64), obj.get("height").and_then(Value::as_f64)) {
        summary.push(format!("{w:.0}x{h:.0}"));
    }
    if let Some(panes) = obj.get("panes").and_then(Value::as_array) {
        summary.push(format!("panes {}", panes.len()));
    }
    if summary.is_empty() { format_value_pretty(val) } else { summary.join("  ") }
}

fn format_event_line(ev: &VdpEvent) -> String {
    match ev.decode_notification() {
        Ok(VdpNotification::TargetCreated(e)) => line(&["Target.created", &target_line(&e.target)]),
        Ok(VdpNotification::TargetDestroyed(e)) => line(&["Target.destroyed", &e.target_id]),
        Ok(VdpNotification::LogEntry(e)) => line(&["Log.entry", e.level.as_str(), &e.source, &e.message]),
        Ok(VdpNotification::PageFrame(e)) => {
            let dims = match (e.width, e.height) {
                (Some(w), Some(h)) => format!("{w:.0}x{h:.0}"),
                _ => String::new(),
            };
            line(&["Page.frame", &format!("{:.2}ms", e.frame_ms), &dims])
        }
        Ok(VdpNotification::UiConsole(e)) => line(&["UI.console", &e.view, e.level.as_str(), &e.message]),
        Ok(VdpNotification::ServerEvent(e)) => line(&["Server.event", &e.topic, &e.payload.to_string()]),
        Err(_) => line(&[&ev.method, &ev.params.to_string()]),
    }
}

fn emit_event(json_mode: bool, ev: &VdpEvent) {
    if json_mode {
        out(&serde_json::to_string(ev).unwrap_or_else(|_| "null".into()));
    } else {
        out(&format_event_line(ev));
    }
}

async fn fetch_version(endpoint: &ResolvedEndpoint) -> Result<VdpVersionInfo, Failure> {
    let http = build_http_client(&endpoint.http_url);
    let url = format!("{}/json/version", endpoint.http_url.trim_end_matches('/'));
    let mut req = http.get(&url).header("accept", "application/json").header("x-vibevalley-client", "cli");
    if let Some(tok) = endpoint.token.as_ref().filter(|t| !t.is_empty()) {
        req = req.header("authorization", format!("Bearer {}", tok.expose()));
    }
    let response = req.send().await.map_err(|err| {
        let mut failure = Failure::new(exit::UNREACHABLE, "Unreachable", format!("cannot reach VDP at {url}: {err}"));
        failure.next = debug_start_hint();
        failure
    })?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|err| Failure::new(exit::UNREACHABLE, "Unreachable", format!("failed reading VDP response from {url}: {err}")))?;
    if status >= 300 {
        return Err(http_status_failure(status, &text));
    }
    serde_json::from_str(&text).map_err(decode_failure)
}

fn parse_optional_json(raw: Option<String>) -> Result<Option<Value>, Failure> {
    raw.map(|text| read_json_input::<Value>(&text)).transpose()
}

pub async fn run(client: &Client, cmd: DebugCmd) -> Done {
    match cmd.action {
        DebugAction::Discover => {
            let extra: Vec<PathBuf> = cmd.target.home.into_iter().collect();
            let instances: Vec<VdpVersionInfo> = home::discover_local_debug_endpoints(&extra).into_iter().map(|ep| ep.version_info()).collect();
            client
                .output
                .show(&instances, |list| list.iter().map(version_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }

        DebugAction::Version => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let version = fetch_version(&endpoint).await?;
            client.output.show(&version, version_line);
            Ok(())
        }

        DebugAction::Targets => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let result: VdpTargetListResult = ws.call_typed(&VdpCommand::TargetList, DEFAULT_RPC_TIMEOUT).await?;
            ws.close().await;
            client
                .output
                .show(&result, |res| res.targets.iter().map(target_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }

        DebugAction::State => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let state = ws.call_command(&VdpCommand::ShellGetState, DEFAULT_RPC_TIMEOUT).await?;
            ws.close().await;
            client.output.show(&state, format_shell_state);
            Ok(())
        }

        DebugAction::Navigate { route } => {
            if client.dry_run {
                return Err(no_dry_run("debug navigate"));
            }
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res = ws
                .call_command(&VdpCommand::ShellNavigate(VdpShellNavigateParams { route: route.clone() }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&res, |_| line(&["navigate", &route]));
            Ok(())
        }

        DebugAction::Resize { width, height } => {
            if client.dry_run {
                return Err(no_dry_run("debug resize"));
            }
            if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
                return Err(Failure::usage("InvalidValue", "width and height must be positive numbers"));
            }
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res = ws
                .call_command(&VdpCommand::ShellResize(VdpShellResizeParams { width, height }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&res, |_| line(&["resize", &format!("{width:.0}x{height:.0}")]));
            Ok(())
        }

        DebugAction::Theme { dark, light, toggle: _ } => {
            if client.dry_run {
                return Err(no_dry_run("debug theme"));
            }
            let dark_opt = if dark {
                Some(true)
            } else if light {
                Some(false)
            } else {
                None
            };
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res = ws
                .call_command(&VdpCommand::ShellSetTheme(VdpShellSetThemeParams { dark: dark_opt }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            let label = match dark_opt {
                Some(true) => "dark",
                Some(false) => "light",
                None => "toggle",
            };
            client.output.show(&res, |_| line(&["theme", label]));
            Ok(())
        }

        DebugAction::Key { keys } => {
            if client.dry_run {
                return Err(no_dry_run("debug key"));
            }
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res: VdpInputResult = ws
                .call_typed(&VdpCommand::InputDispatchKey(VdpDispatchKeyParams { keys }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&res, |r| format!("handled {}", r.handled));
            Ok(())
        }

        DebugAction::Type { text } => {
            if client.dry_run {
                return Err(no_dry_run("debug type"));
            }
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res: VdpInputResult = ws
                .call_typed(&VdpCommand::InputTypeText(VdpTypeTextParams { text }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&res, |r| format!("handled {}", r.handled));
            Ok(())
        }

        DebugAction::Click { x, y, right } => {
            if client.dry_run {
                return Err(no_dry_run("debug click"));
            }
            if !x.is_finite() || !y.is_finite() {
                return Err(Failure::usage("InvalidValue", "click coordinates must be finite numbers"));
            }
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res: VdpInputResult = ws
                .call_typed(
                    &VdpCommand::InputDispatchMouse(VdpDispatchMouseParams {
                        kind: VdpMouseEventKind::Click,
                        x,
                        y,
                        button: Some(if right { VdpMouseButton::Right } else { VdpMouseButton::Left }),
                        end_x: None,
                        end_y: None,
                    }),
                    DEFAULT_RPC_TIMEOUT,
                )
                .await?;
            ws.close().await;
            client.output.show(&res, |r| format!("handled {}", r.handled));
            Ok(())
        }

        DebugAction::Screenshot { output, target, width, height } => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let shot: VdpScreenshotResult = ws
                .call_typed(
                    &VdpCommand::PageCaptureScreenshot(VdpCaptureScreenshotParams {
                        target: target.map(Into::into),
                        width,
                        height,
                    }),
                    DEFAULT_RPC_TIMEOUT,
                )
                .await?;
            ws.close().await;

            let raw_b64 = shot.data.trim();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw_b64)
                .map_err(|e| Failure::new(exit::OTHER, "Decode", format!("invalid screenshot base64 payload: {e}")))?;

            if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)
                    .map_err(|e| Failure::new(exit::OTHER, "File", format!("failed to create directory {}: {e}", parent.display())))?;
            }
            std::fs::write(&output, &bytes).map_err(|e| Failure::new(exit::OTHER, "File", format!("failed to write {}: {e}", output.display())))?;

            let saved = ScreenshotSaved {
                path: output.display().to_string(),
                mime: shot.mime,
                width: shot.width,
                height: shot.height,
                bytes: bytes.len(),
            };
            client.output.show(&saved, |s| {
                line(&[&format!("{}x{}", s.width, s.height), &s.mime, &format!("{} bytes", s.bytes), &s.path])
            });
            Ok(())
        }

        DebugAction::UiTree { view, max_depth } => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let tree: VdpUiTreeResult = ws
                .call_typed(&VdpCommand::UiGetTree(VdpUiGetTreeParams { view, max_depth }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&tree, format_ui_tree);
            Ok(())
        }

        DebugAction::UiQuery { test_id, text, role, view } => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res: VdpUiQueryResult = ws
                .call_typed(&VdpCommand::UiQuery(VdpUiQueryParams { test_id, text, role, view }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&res, format_ui_query);
            Ok(())
        }

        DebugAction::UiPress { test_id, view } => {
            if client.dry_run {
                return Err(no_dry_run("debug ui-press"));
            }
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let res: VdpUiPressResult = ws
                .call_typed(&VdpCommand::UiPress(VdpUiPressParams { test_id, view }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client
                .output
                .show(&res, |r| line(&[&r.view, &r.test_id, if r.pressed { "pressed" } else { "not-pressed" }]));
            Ok(())
        }

        DebugAction::UiWait {
            test_id,
            text,
            view,
            timeout_ms,
        } => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let rpc_timeout = Duration::from_millis(timeout_ms.saturating_add(5_000));
            let res: VdpUiWaitForResult = ws
                .call_typed(
                    &VdpCommand::UiWaitFor(VdpUiWaitForParams {
                        test_id,
                        text,
                        view,
                        timeout_ms: Some(timeout_ms),
                    }),
                    rpc_timeout,
                )
                .await?;
            ws.close().await;
            client.output.show(&res, format_ui_wait);
            Ok(())
        }

        DebugAction::ServerSlice { name } => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let value = ws
                .call_command(&VdpCommand::ServerSlice(VdpServerSliceParams { name }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&value, format_value_pretty);
            Ok(())
        }

        DebugAction::ServerRpc { method, params } => {
            if client.dry_run {
                return Err(no_dry_run("debug server-rpc"));
            }
            let params = parse_optional_json(params)?;
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let value = ws
                .call_command(&VdpCommand::ServerInvoke(VdpServerInvokeParams { method, params }), DEFAULT_RPC_TIMEOUT)
                .await?;
            ws.close().await;
            client.output.show(&value, format_value_pretty);
            Ok(())
        }

        DebugAction::Call { method, params, session_id } => {
            if client.dry_run {
                return Err(no_dry_run("debug call"));
            }
            let params = parse_optional_json(params)?.unwrap_or_else(|| json!({}));
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let value = ws.call_raw(&method, params, session_id, DEFAULT_RPC_TIMEOUT).await?;
            ws.close().await;
            client.output.show(&value, format_value_pretty);
            Ok(())
        }

        DebugAction::Watch { limit } => {
            let endpoint = resolve_endpoint(client, &cmd.target)?;
            let mut ws = VdpWsClient::connect(&endpoint).await?;
            let _ = ws.call_command(&VdpCommand::LogEnable, DEFAULT_RPC_TIMEOUT).await?;

            let mut count = 0usize;
            for ev in ws.drain_buffered_events() {
                if limit.is_some_and(|max| count >= max) {
                    break;
                }
                emit_event(client.output.json, &ev);
                count += 1;
            }

            if limit.is_none_or(|max| count < max) {
                loop {
                    tokio::select! {
                        biased;
                        () = wait_for_shutdown_signal() => break,
                        next = ws.next_event() => {
                            match next? {
                                Some(ev) => {
                                    emit_event(client.output.json, &ev);
                                    count += 1;
                                    if limit.is_some_and(|max| count >= max) {
                                        break;
                                    }
                                }
                                None => break,
                            }
                        }
                    }
                }
            }

            let _ = ws.call_command(&VdpCommand::LogDisable, Duration::from_secs(2)).await;
            ws.close().await;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_info(channel: &str, pid: u32, port: u16, home_path: &str, token: &str) -> VdpEndpointInfo {
        VdpEndpointInfo {
            protocol_version: vibevalley_protocol::VDP_PROTOCOL_VERSION.into(),
            pid,
            channel: channel.into(),
            app_version: "0.1.0-test".into(),
            home: home_path.into(),
            port,
            http_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}/devtools"),
            token: token.into(),
            started_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn explicit_url_normalization_handles_ws_http_and_query_token() {
        let ep = normalize_explicit_url("ws://127.0.0.1:9222/devtools?token=abc123", None).unwrap();
        assert_eq!(ep.http_url, "http://127.0.0.1:9222");
        assert_eq!(ep.ws_url, "ws://127.0.0.1:9222/devtools");
        assert_eq!(ep.token.as_ref().map(Secret::expose), Some("abc123"));

        let overridden = normalize_explicit_url("http://127.0.0.1:9222", Some(Secret::new("override-tok"))).unwrap();
        assert_eq!(overridden.http_url, "http://127.0.0.1:9222");
        assert_eq!(overridden.ws_url, "ws://127.0.0.1:9222/devtools");
        assert_eq!(overridden.token.as_ref().map(Secret::expose), Some("override-tok"));

        let err = normalize_explicit_url("ftp://127.0.0.1:9222", None).unwrap_err();
        assert_eq!(err.code, exit::USAGE);
    }

    #[test]
    fn resolution_precedence_and_ambiguity_checks() {
        let dev = sample_info("dev", 101, 9222, "/tmp/dev", "tok-dev");
        let alpha = sample_info("alpha", 102, 9223, "/tmp/alpha", "tok-alpha");

        // 1. Explicit --url wins over --port and --home.
        let target = DebugTargetArgs {
            home: Some(PathBuf::from("/tmp/dev")),
            port: Some(9222),
            url: Some("ws://127.0.0.1:9999/devtools".into()),
        };
        let ep = resolve_endpoint_with(&target, Some(Secret::new("tok-url")), Path::new("/tmp/cur"), |_| Some(dev.clone()), |_| vec![]).unwrap();
        assert_eq!(ep.ws_url, "ws://127.0.0.1:9999/devtools");
        assert_eq!(ep.token.as_ref().map(Secret::expose), Some("tok-url"));

        // 2. Explicit --port discovers matching token from debug.json when --token omitted.
        let port_target = DebugTargetArgs {
            home: None,
            port: Some(9223),
            url: None,
        };
        let ep = resolve_endpoint_with(&port_target, None, Path::new("/tmp/cur"), |_| None, |_| vec![dev.clone(), alpha.clone()]).unwrap();
        assert_eq!(ep.ws_url, "ws://127.0.0.1:9223/devtools");
        assert_eq!(ep.token.as_ref().map(Secret::expose), Some("tok-alpha"));

        // 3. Explicit --home reads that home's debug.json and fails if missing.
        let home_target = DebugTargetArgs {
            home: Some(PathBuf::from("/tmp/missing")),
            port: None,
            url: None,
        };
        let err = resolve_endpoint_with(&home_target, None, Path::new("/tmp/dev"), |_| None, |_| vec![dev.clone()]).unwrap_err();
        assert_eq!(err.code, exit::UNREACHABLE);

        // 4. Current VIBEVALLEY_HOME takes precedence over fallback discovery.
        let empty_target = DebugTargetArgs::default();
        let ep = resolve_endpoint_with(
            &empty_target,
            None,
            Path::new("/tmp/dev"),
            |p| (p == Path::new("/tmp/dev")).then(|| dev.clone()),
            |_| vec![dev.clone(), alpha.clone()],
        )
        .unwrap();
        assert_eq!(ep.ws_url, "ws://127.0.0.1:9222/devtools");

        // 5a. Single discovered local instance succeeds.
        let ep = resolve_endpoint_with(&empty_target, None, Path::new("/tmp/none"), |_| None, |_| vec![alpha.clone()]).unwrap();
        assert_eq!(ep.ws_url, "ws://127.0.0.1:9223/devtools");

        // 5b. Multiple discovered local instances return AmbiguousTarget listing both.
        let err = resolve_endpoint_with(&empty_target, None, Path::new("/tmp/none"), |_| None, |_| vec![dev.clone(), alpha.clone()]).unwrap_err();
        assert_eq!(err.code, exit::USAGE);
        assert_eq!(err.tag, "AmbiguousTarget");
        assert!(err.text.contains("port=9222"));
        assert!(err.text.contains("port=9223"));

        // 5c. Zero discovered instances return Unreachable.
        let err = resolve_endpoint_with(&empty_target, None, Path::new("/tmp/none"), |_| None, |_| vec![]).unwrap_err();
        assert_eq!(err.code, exit::UNREACHABLE);
    }
}
