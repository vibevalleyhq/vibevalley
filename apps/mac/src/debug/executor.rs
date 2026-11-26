//! Single typed executor for shell inspection, input dispatch, screenshots, and commands.
//!
//! Both live VDP WebSocket requests (`vdp.rs`) and legacy `VIBEVALLEY_DEBUG_SCRIPT`
//! files (`script.rs`) execute through this module so command behavior never drifts.

use std::collections::HashSet;
use std::path::PathBuf;

use gpui::{
    App, Context, Entity, KeyUpEvent, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, Window, point, px,
};
use serde_json::{Value, json};
use vibevalley_protocol::{
    HostCapturedImage, VdpAckResult, VdpCaptureScreenshotParams, VdpDispatchKeyParams, VdpDispatchMouseParams, VdpError, VdpInputResult, VdpMouseButton,
    VdpMouseEventKind, VdpPageMetrics, VdpScreenshotTarget, VdpShellClosePaneParams, VdpShellGetTerminalGridParams, VdpShellNavigateParams,
    VdpShellOpenPaneParams, VdpShellResizeParams, VdpShellRunCommandParams, VdpShellSendTerminalInputParams, VdpShellSetThemeParams, VdpTarget, VdpTargetKind,
    VdpTypeTextParams,
};
use vibevalley_workspace::{DiffSpec, PaneKind, TabId};

use crate::hosted::frames::PaletteMode;
use crate::hosted::{Action, HostedView, ShellDebugHandle};
use crate::panes::{PaneEntity, tab_title};
use crate::shell::Shell;
use crate::theme::{ThemeChoice, Ui};

/// Result of executing a GPUI-thread VDP command; heavy encoding or async webview
/// captures return a pending handle so neither the GPUI thread nor Tokio blocks.
pub(crate) enum GpuiExecResult {
    Ready(Result<Value, VdpError>),
    PendingWebviewCapture(tokio::sync::oneshot::Receiver<Result<HostCapturedImage, String>>),
    #[cfg(feature = "shot")]
    PendingShellPng {
        image: image::RgbaImage,
        width: Option<u32>,
        height: Option<u32>,
    },
}

/// Converts a terminal grid snapshot into trimmed plain-text rows.
pub fn grid_text(snapshot: &vibevalley_terminal::Snapshot) -> Vec<String> {
    snapshot
        .rows
        .iter()
        .map(|row| {
            let mut line = String::new();
            let mut col = 0usize;
            for run in &row.runs {
                while col < run.start_col as usize {
                    line.push(' ');
                    col += 1;
                }
                line.push_str(&run.text);
                col = run.start_col as usize + run.cols as usize;
            }
            line.trim_end().to_string()
        })
        .collect()
}

/// Captures the full shell state snapshot shared by `VIBEVALLEY_DEBUG_DUMP` and `Shell.getState`.
pub fn dump(shell: &Shell, cx: &App) -> Value {
    let projects: Vec<Value> = shell
        .workspace
        .ws
        .projects()
        .iter()
        .map(|p| {
            let tabs: Vec<Value> = p
                .layout
                .tabs()
                .map(|t| {
                    let mut v = json!({
                        "id": t.id,
                        "kind": serde_json::to_value(&t.kind).unwrap_or(Value::Null),
                        "title": tab_title(shell, t, cx),
                    });
                    match &t.kind {
                        PaneKind::Terminal { terminal_id, .. } => {
                            if let Some(slot) = shell.workspace.terminals.get(terminal_id) {
                                let view = slot.view.read(cx);
                                v["spawned"] = json!(view.session().is_some());
                                v["exited"] = json!(view.has_exited());
                                v["grid"] = json!(view.snapshot().map(|s| grid_text(&s)).unwrap_or_default());
                            } else {
                                v["spawned"] = json!(false);
                            }
                            v["registered"] = json!(p.terminal(terminal_id).is_some());
                        }
                        _ => match shell.workspace.panes.get(&(p.id(), t.id)).map(|s| &s.entity) {
                            Some(PaneEntity::File(f)) => v["viewer"] = json!({ "status": f.read(cx).status(), "reloads": f.read(cx).reloads() }),
                            Some(PaneEntity::Markdown(m)) => v["markdown"] = json!({ "status": m.read(cx).status(), "reloads": m.read(cx).reloads() }),
                            Some(PaneEntity::Diff(d)) => v["diff"] = json!(d.read(cx).summary()),
                            Some(PaneEntity::Hosted(view)) => v["hosted"] = view.read(cx).debug_state(),
                            Some(PaneEntity::Diorama(view)) => v["diorama"] = view.read(cx).debug_state(),
                            None => {}
                        },
                    }
                    v
                })
                .collect();
            let view = shell.workspace.projects.get(&p.id());
            json!({
                "id": p.id(),
                "name": p.info.name,
                "root": p.root(),
                "active": shell.workspace.ws.active_id() == Some(p.id()),
                "layout": p.layout.to_json(),
                "focused_group": p.layout.focused,
                "tabs": tabs,
                "tree_dirs_loaded": view.map(|v| v.tree.children.len()),
                "git": view.map(|v| json!({
                    "branch": v.status.as_ref().and_then(|s| s.branch.clone()),
                    "entries": v.status.as_ref().map(|s| s.entries.len()),
                    "error": v.git_error,
                })),
                "indexed_files": view.and_then(|v| v.index.as_ref().map(|i| i.len())),
            })
        })
        .collect();
    let route = shell.chrome.last_route.as_deref().unwrap_or("/issues");
    json!({
        "loaded": shell.workspace.loaded,
        "load_error": shell.workspace.load_error,
        "route": route,
        "startup_failure": shell.overlays.startup.failure.as_ref().map(|f| json!({
            "kind": f.kind.as_str(),
            "summary": f.summary,
            "db_path": f.db_path,
        })),
        "panel": format!("{:?}", shell.chrome.panel),
        "native_workspace": shell.chrome.native_workspace,
        "sidebar_visible": shell.chrome.sidebar_visible,
        "inspector_open": shell.chrome.inspector_open,
        "inspector_mounted": shell.chrome.inspector.is_some(),
        "theme_dark": Ui::get(cx).colors.dark,
        "projects": projects,
        "sidebar": shell.chrome.sidebar.read(cx).debug_state(),
        "inspector": shell.chrome.inspector.as_ref().map(|s| s.view.read(cx).debug_state()),
        "workbench": shell.chrome.workbench.read(cx).debug_state(),
        "diorama": shell.chrome.native_diorama.as_ref().map(|s| s.view.read(cx).debug_state()),
        "palette": shell.overlays.palette.as_ref().map(|p| json!({
            "open": p.open,
            "mode": p.mode.as_str(),
            "query": p.query,
            "view": p.view.read(cx).debug_state(),
        })),
        "live_terminal_views": shell.workspace.terminals.len(),
        "terminal_notice": shell.workspace.terminal_notice,
        "bridge_probe": shell.overlays.probe,
        "tray": shell.overlays.tray,
        "pane_entities": shell.workspace.panes.len(),
    })
}

/// Lists all live inspectable VDP targets currently mounted inside `shell`.
pub(crate) fn collect_targets(shell: &Shell, attached_ids: &HashSet<String>, cx: &App) -> Vec<VdpTarget> {
    let route = shell.chrome.last_route.clone().or_else(|| Some("/issues".to_string()));
    let mut targets = vec![
        VdpTarget {
            id: "shell".into(),
            kind: VdpTargetKind::Shell,
            title: "VibeValley Shell".into(),
            url: route.clone(),
            attached: attached_ids.contains("shell"),
        },
        VdpTarget {
            id: "view:workbench".into(),
            kind: VdpTargetKind::View,
            title: "Workbench".into(),
            url: route.clone(),
            attached: attached_ids.contains("view:workbench"),
        },
        VdpTarget {
            id: "view:sidebar".into(),
            kind: VdpTargetKind::View,
            title: "Sidebar".into(),
            url: None,
            attached: attached_ids.contains("view:sidebar"),
        },
    ];

    if shell.chrome.inspector.is_some() {
        targets.push(VdpTarget {
            id: "view:inspector".into(),
            kind: VdpTargetKind::View,
            title: "Inspector".into(),
            url: None,
            attached: attached_ids.contains("view:inspector"),
        });
    }

    if shell.overlays.palette.as_ref().is_some_and(|p| p.open) {
        targets.push(VdpTarget {
            id: "view:palette".into(),
            kind: VdpTargetKind::View,
            title: "Command Palette".into(),
            url: None,
            attached: attached_ids.contains("view:palette"),
        });
    }

    if shell.overlays.devtools.overlay.is_some() || shell.overlays.devtools.detached_view.as_ref().and_then(gpui::WeakEntity::upgrade).is_some() {
        targets.push(VdpTarget {
            id: "view:devtools".into(),
            kind: VdpTargetKind::View,
            title: "DevTools".into(),
            url: None,
            attached: attached_ids.contains("view:devtools"),
        });
    }

    if shell.chrome.native_diorama.is_some() {
        targets.push(VdpTarget {
            id: "diorama:farm".into(),
            kind: VdpTargetKind::Diorama,
            title: "Farm Diorama".into(),
            url: Some("/farm".into()),
            attached: attached_ids.contains("diorama:farm"),
        });
    }

    let mut pane_keys: Vec<_> = shell.workspace.panes.keys().copied().collect();
    pane_keys.sort();
    for (pid, tab_id) in pane_keys {
        if let Some(slot) = shell.workspace.panes.get(&(pid, tab_id)) {
            match &slot.entity {
                PaneEntity::Hosted(view) => {
                    let id = format!("view:pane:{pid}:{tab_id}");
                    let view_name = view.read(cx).view_name().to_string();
                    targets.push(VdpTarget {
                        attached: attached_ids.contains(&id),
                        id,
                        kind: VdpTargetKind::View,
                        title: format!("Hosted ({view_name})"),
                        url: None,
                    });
                }
                PaneEntity::Diorama(_) => {
                    let id = format!("diorama:pane:{pid}:{tab_id}");
                    targets.push(VdpTarget {
                        attached: attached_ids.contains(&id),
                        id,
                        kind: VdpTargetKind::Diorama,
                        title: format!("Diorama #{tab_id}"),
                        url: None,
                    });
                }
                PaneEntity::File(_) | PaneEntity::Markdown(_) | PaneEntity::Diff(_) => {}
            }
        }
    }

    if route.as_deref().is_some_and(|r| r.starts_with("/library") || r.starts_with("/artifacts")) {
        targets.push(VdpTarget {
            id: "webview".into(),
            kind: VdpTargetKind::Webview,
            title: "Artifact WebView".into(),
            url: route,
            attached: attached_ids.contains("webview"),
        });
    }

    let server_url = cx.try_global::<ShellDebugHandle>().and_then(ShellDebugHandle::loopback_url);
    targets.push(VdpTarget {
        id: "server".into(),
        kind: VdpTargetKind::Server,
        title: "Embedded Server".into(),
        url: server_url,
        attached: attached_ids.contains("server"),
    });

    targets
}

/// Resolves a VDP `view` selector (default `"workbench"`) to a mounted [`HostedView`].
pub(crate) fn resolve_hosted_view(shell: &Shell, selector: Option<&str>, cx: &App) -> Option<(String, Entity<HostedView>)> {
    let raw = selector.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("workbench");
    let normalized = raw.strip_prefix("view:").unwrap_or(raw);
    match normalized {
        "workbench" | "vv" | "vibevalley" | "shell" => Some(("workbench".into(), shell.chrome.workbench.clone())),
        "sidebar" => Some(("sidebar".into(), shell.chrome.sidebar.clone())),
        "inspector" => shell.chrome.inspector.as_ref().map(|s| ("inspector".into(), s.view.clone())),
        "palette" => shell.overlays.palette.as_ref().map(|p| ("palette".into(), p.view.clone())),
        "devtools" => shell
            .overlays
            .devtools
            .overlay
            .as_ref()
            .map(|(v, _)| ("devtools".into(), v.clone()))
            .or_else(|| {
                shell
                    .overlays
                    .devtools
                    .detached_view
                    .as_ref()
                    .and_then(gpui::WeakEntity::upgrade)
                    .map(|v| ("devtools".into(), v))
            }),
        other => {
            if let Some(rest) = other.strip_prefix("pane:")
                && let Some((pid, tid)) = rest.split_once(':')
                && let (Ok(pid), Ok(tid)) = (pid.parse::<i64>(), tid.parse::<TabId>())
                && let Some(PaneEntity::Hosted(view)) = shell.workspace.panes.get(&(pid, tid)).map(|s| &s.entity)
            {
                return Some((other.to_string(), view.clone()));
            }
            for ((pid, tid), slot) in &shell.workspace.panes {
                if let PaneEntity::Hosted(view) = &slot.entity
                    && view.read(cx).view_name() == other
                {
                    return Some((format!("pane:{pid}:{tid}"), view.clone()));
                }
            }
            None
        }
    }
}

/// Advances any active diorama views while the screen is locked so dumps stay fresh.
pub fn step_unpainted_dioramas(shell: &Shell, cx: &mut App) {
    if let Some(slot) = &shell.chrome.native_diorama {
        slot.view.update(cx, |v, cx| v.draw_unpainted(cx));
    }
    for pane in shell.workspace.panes.values() {
        if let PaneEntity::Diorama(view) = &pane.entity {
            view.update(cx, |v, cx| v.draw_unpainted(cx));
        }
    }
}

fn active_diorama(s: &Shell) -> Option<Entity<crate::diorama::DioramaView>> {
    if let Some(slot) = &s.chrome.native_diorama {
        return Some(slot.view.clone());
    }
    let project = s.workspace.ws.active()?;
    let tab = project.layout.active_tab()?;
    match s.workspace.panes.get(&(project.id(), tab.id)).map(|p| &p.entity) {
        Some(PaneEntity::Diorama(v)) => Some(v.clone()),
        _ => None,
    }
}

fn dispatch_single_key(key: Keystroke, window: &mut Window, cx: &mut App) -> bool {
    window.draw(cx).clear(cx);
    let handled = window.dispatch_keystroke(key.clone(), cx);
    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: key }), cx);
    handled
}

/// Parses a GPUI keystroke while interning unique specs so repeated VDP calls do not leak memory.
fn parse_keystroke(token: &str) -> Result<Keystroke, VdpError> {
    static INTERNED: std::sync::OnceLock<parking_lot::Mutex<HashSet<&'static str>>> = std::sync::OnceLock::new();
    let table = INTERNED.get_or_init(|| parking_lot::Mutex::new(HashSet::new()));
    let static_str: &'static str = {
        let mut guard = table.lock();
        if let Some(&existing) = guard.get(token) {
            existing
        } else {
            let leaked: &'static str = Box::leak(token.to_string().into_boxed_str());
            guard.insert(leaked);
            leaked
        }
    };
    Keystroke::parse(static_str).map_err(|e| VdpError::invalid_params(format!("invalid keystroke {token:?}: {e}")))
}

/// Dispatches whitespace-separated keystroke specs (e.g. `"cmd-1 cmd-shift-p"`).
pub(crate) fn dispatch_keys(params: &VdpDispatchKeyParams, window: &mut Window, cx: &mut App) -> Result<VdpInputResult, VdpError> {
    let tokens: Vec<&str> = params.keys.split_whitespace().collect();
    if tokens.is_empty() {
        return Err(VdpError::invalid_params("Input.dispatchKey requires at least one key"));
    }
    let mut any_handled = false;
    for token in tokens {
        let keystroke = parse_keystroke(token)?;
        if dispatch_single_key(keystroke, window, cx) {
            any_handled = true;
        }
    }
    Ok(VdpInputResult { handled: any_handled })
}

/// Types UTF-8 characters through the window's normal keystroke dispatch path.
pub(crate) fn dispatch_text(params: &VdpTypeTextParams, window: &mut Window, cx: &mut App) -> VdpInputResult {
    let mut any_handled = false;
    for ch in params.text.chars() {
        let key = ch.to_string();
        let handled = dispatch_single_key(
            Keystroke {
                modifiers: Modifiers::default(),
                key: key.clone(),
                key_char: Some(key),
            },
            window,
            cx,
        );
        any_handled |= handled;
    }
    VdpInputResult { handled: any_handled }
}

/// Dispatches a mouse event (`down`, `up`, `move`, `click`, `drag`) in window coordinates.
pub(crate) fn dispatch_mouse(params: &VdpDispatchMouseParams, window: &mut Window, cx: &mut App) -> Result<VdpInputResult, VdpError> {
    if !params.x.is_finite() || !params.y.is_finite() {
        return Err(VdpError::invalid_params("mouse coordinates must be finite"));
    }
    let button = match params.button.unwrap_or_default() {
        VdpMouseButton::Left => MouseButton::Left,
        VdpMouseButton::Right => MouseButton::Right,
        VdpMouseButton::Middle => MouseButton::Middle,
    };
    let modifiers = Modifiers::default();
    let start = point(px(params.x), px(params.y));

    let mk_down = |position| {
        PlatformInput::MouseDown(MouseDownEvent {
            button,
            position,
            modifiers,
            click_count: 1,
            first_mouse: false,
        })
    };
    let mk_up = |position| {
        PlatformInput::MouseUp(MouseUpEvent {
            button,
            position,
            modifiers,
            click_count: 1,
        })
    };
    let mk_move = |position, pressed| {
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            modifiers,
            pressed_button: pressed,
        })
    };

    let events = match params.kind {
        VdpMouseEventKind::Down => vec![mk_down(start)],
        VdpMouseEventKind::Up => vec![mk_up(start)],
        VdpMouseEventKind::Move => vec![mk_move(start, None)],
        VdpMouseEventKind::Click => vec![mk_down(start), mk_up(start)],
        VdpMouseEventKind::Drag => {
            if let (Some(ex), Some(ey)) = (params.end_x, params.end_y) {
                if !ex.is_finite() || !ey.is_finite() {
                    return Err(VdpError::invalid_params("drag end coordinates must be finite"));
                }
                let end = point(px(ex), px(ey));
                vec![mk_down(start), mk_move(end, Some(button)), mk_up(end)]
            } else {
                vec![mk_move(start, Some(button))]
            }
        }
    };

    for event in events {
        window.draw(cx).clear(cx);
        window.dispatch_event(event, cx);
    }
    Ok(VdpInputResult { handled: true })
}

/// Captures the GPUI Metal frame to disk for legacy `shot:<file.png>` script steps.
#[cfg(feature = "shot")]
pub(crate) fn save_shell_screenshot(window: &mut Window, path: &str, cx: &mut App) {
    window.simulate_next_frame(cx);
    window.draw(cx).clear(cx);
    match window.render_to_image() {
        Ok(image) => match image.save(path) {
            Ok(()) => eprintln!("debug script: shot {path} {}x{}", image.width(), image.height()),
            Err(e) => eprintln!("debug script: shot {path}: {e}"),
        },
        Err(e) => eprintln!("debug script: shot: {e}"),
    }
}

#[cfg(not(feature = "shot"))]
pub(crate) fn save_shell_screenshot(_window: &mut Window, path: &str, _cx: &mut App) {
    eprintln!("debug script: shot {path}: build with --features shot");
}

/// Captures a screenshot for `Page.captureScreenshot` (shell Metal texture or active `WKWebView`).
pub(crate) fn capture_screenshot(params: &VdpCaptureScreenshotParams, window: &mut Window, cx: &mut App) -> GpuiExecResult {
    match params.target.unwrap_or_default() {
        VdpScreenshotTarget::Webview => {
            let rx = crate::capture::capture_webview_cover(window, params.width, params.height, cx);
            GpuiExecResult::PendingWebviewCapture(rx)
        }
        VdpScreenshotTarget::Shell => {
            #[cfg(feature = "shot")]
            {
                window.simulate_next_frame(cx);
                window.draw(cx).clear(cx);
                match window.render_to_image() {
                    Ok(image) => GpuiExecResult::PendingShellPng {
                        image: image::DynamicImage::from(image).to_rgba8(),
                        width: params.width,
                        height: params.height,
                    },
                    Err(e) => GpuiExecResult::Ready(Err(VdpError::internal(format!("render_to_image failed: {e}")))),
                }
            }
            #[cfg(not(feature = "shot"))]
            {
                let _ = (window, cx);
                GpuiExecResult::Ready(Err(VdpError::unavailable(
                    "shell screenshot requires building vibevalley-mac with --features shot",
                )))
            }
        }
    }
}

/// Encodes a GPUI [`image::RgbaImage`] as base64 PNG off the UI thread, optionally resizing.
#[cfg(feature = "shot")]
pub(crate) fn encode_shell_png(image: image::RgbaImage, width: Option<u32>, height: Option<u32>) -> Result<vibevalley_protocol::VdpScreenshotResult, VdpError> {
    use base64::Engine as _;
    use image::ImageEncoder as _;
    use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
    use image::imageops::{self, FilterType};
    use vibevalley_protocol::VdpScreenshotResult;

    let target = match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 && (w != image.width() || h != image.height()) => {
            imageops::resize(&image, w.min(4096), h.min(4096), FilterType::CatmullRom)
        }
        (Some(w), None) if w > 0 && w != image.width() => {
            let w = w.min(4096);
            let h = ((u64::from(image.height()) * u64::from(w)) / u64::from(image.width().max(1))).clamp(1, 4096) as u32;
            imageops::resize(&image, w, h, FilterType::CatmullRom)
        }
        (None, Some(h)) if h > 0 && h != image.height() => {
            let h = h.min(4096);
            let w = ((u64::from(image.width()) * u64::from(h)) / u64::from(image.height().max(1))).clamp(1, 4096) as u32;
            imageops::resize(&image, w, h, FilterType::CatmullRom)
        }
        _ => image,
    };

    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, PngFilterType::Adaptive)
        .write_image(target.as_raw(), target.width(), target.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| VdpError::internal(format!("PNG encode failed: {e}")))?;

    Ok(VdpScreenshotResult {
        mime: "image/png".into(),
        data: base64::engine::general_purpose::STANDARD.encode(&png),
        width: target.width(),
        height: target.height(),
    })
}

/// Returns current window viewport dimensions, scale factor, theme flag, and last frame timing.
pub(crate) fn page_metrics(window: &Window, cx: &App) -> VdpPageMetrics {
    let vp = window.viewport_size();
    let last_frame_ms = cx.try_global::<ShellDebugHandle>().and_then(ShellDebugHandle::last_frame_ms);
    VdpPageMetrics {
        width: f32::from(vp.width),
        height: f32::from(vp.height),
        scale_factor: window.scale_factor(),
        theme_dark: Ui::get(cx).colors.dark,
        last_frame_ms,
    }
}

/// Executes `Shell.navigate`.
pub(crate) fn exec_navigate(shell: &mut Shell, params: &VdpShellNavigateParams, cx: &mut Context<Shell>) -> Result<Value, VdpError> {
    let route = params.route.trim();
    if route.is_empty() {
        return Err(VdpError::invalid_params("Shell.navigate requires a non-empty route"));
    }
    if route == "/workspace" {
        shell.show_workspace(cx);
    } else {
        shell.navigate_workbench(route, cx);
    }
    Ok(json!(VdpAckResult { ok: true }))
}

/// Executes `Shell.openPane`.
pub(crate) fn exec_open_pane(shell: &mut Shell, params: &VdpShellOpenPaneParams, window: &mut Window, cx: &mut Context<Shell>) -> Result<Value, VdpError> {
    let extra = params.params.clone().unwrap_or_else(|| json!({}));
    match params.kind.trim().to_ascii_lowercase().as_str() {
        "terminal" => shell.new_terminal(None, window, cx),
        "chat" => {
            let runtime = extra.get("runtime").and_then(Value::as_str).map(str::to_string);
            shell.new_chat(runtime, window, cx);
        }
        "hosted" => {
            let module = extra
                .get("module")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| VdpError::invalid_params("Shell.openPane(hosted) requires params.module"))?;
            let props = extra.get("props").cloned().unwrap_or_else(|| json!({}));
            shell.open_pane(
                PaneKind::Hosted {
                    module: module.to_string(),
                    props,
                },
                window,
                cx,
            );
        }
        "diorama" => {
            let scene = extra
                .get("scene")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("farm");
            let props = extra.get("props").cloned().unwrap_or_else(|| json!({}));
            shell.open_pane(
                PaneKind::Diorama {
                    scene: scene.to_string(),
                    props,
                },
                window,
                cx,
            );
        }
        "file" => {
            let path = extra
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| VdpError::invalid_params("Shell.openPane(file) requires params.path"))?;
            let line = extra.get("line").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
            shell.open_file(PathBuf::from(path), line, window, cx);
        }
        "diff" => {
            let path = extra.get("path").and_then(Value::as_str).map(PathBuf::from);
            let staged = extra.get("staged").and_then(Value::as_bool).unwrap_or(false);
            let spec = if staged { DiffSpec::Staged } else { DiffSpec::Unstaged };
            shell.open_pane(PaneKind::Diff { spec, path, repo: None }, window, cx);
        }
        other => {
            return Err(VdpError::invalid_params(format!(
                "unsupported pane kind {other:?} (expected terminal|chat|hosted|diorama|file|diff)"
            )));
        }
    }
    Ok(json!(VdpAckResult { ok: true }))
}

/// Executes `Shell.closePane`.
pub(crate) fn exec_close_pane(shell: &mut Shell, params: &VdpShellClosePaneParams, window: &mut Window, cx: &mut Context<Shell>) -> Value {
    if let Some(tab_id) = params.tab_id {
        shell.close_tab(tab_id, window, cx);
        return json!(VdpAckResult { ok: true });
    }
    if let Some(kind) = params.kind.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let title = params.title_contains.as_deref().unwrap_or("");
        close_tabs_by_kind(shell, kind, title, window, cx);
        return json!(VdpAckResult { ok: true });
    }
    shell.on_action(Action::PaletteSelect { id: "pane.close".into() }, window, cx);
    json!(VdpAckResult { ok: true })
}

fn close_tabs_by_kind(shell: &mut Shell, kind: &str, title: &str, window: &mut Window, cx: &mut Context<Shell>) {
    let tabs: Vec<TabId> = shell
        .workspace
        .ws
        .active()
        .map(|p| {
            p.layout
                .tabs()
                .filter(|t| serde_json::to_value(&t.kind).ok().and_then(|v| v["kind"].as_str().map(|k| k == kind)) == Some(true))
                .filter(|t| title.is_empty() || tab_title(shell, t, cx).contains(title))
                .map(|t| t.id)
                .collect()
        })
        .unwrap_or_default();
    for tab in tabs {
        shell.close_tab(tab, window, cx);
    }
}

/// Executes `Shell.resize`.
pub(crate) fn exec_resize(params: &VdpShellResizeParams, window: &mut Window) -> Result<Value, VdpError> {
    if !params.width.is_finite() || !params.height.is_finite() || params.width <= 0.0 || params.height <= 0.0 {
        return Err(VdpError::invalid_params("Shell.resize requires positive finite width and height"));
    }
    window.resize(gpui::size(px(params.width), px(params.height)));
    Ok(json!(VdpAckResult { ok: true }))
}

/// Executes `Shell.setTheme`.
pub(crate) fn exec_set_theme(shell: &mut Shell, params: &VdpShellSetThemeParams, cx: &mut Context<Shell>) -> Value {
    match params.dark {
        Some(true) => shell.set_theme(ThemeChoice::Dark, cx),
        Some(false) => shell.set_theme(ThemeChoice::Light, cx),
        None => shell.toggle_theme(cx),
    }
    json!({
        "ok": true,
        "themeDark": Ui::get(cx).colors.dark,
    })
}

fn active_or_first_terminal_id(shell: &Shell) -> Option<String> {
    if let Some(project) = shell.workspace.ws.active()
        && let Some(PaneKind::Terminal { terminal_id, .. }) = project.layout.active_tab().map(|t| &t.kind)
        && shell.workspace.terminals.contains_key(terminal_id)
    {
        return Some(terminal_id.clone());
    }
    shell.workspace.terminals.keys().next().cloned()
}

/// Executes `Shell.getTerminalGrid`.
pub(crate) fn exec_get_terminal_grid(shell: &Shell, params: &VdpShellGetTerminalGridParams, cx: &App) -> Result<Value, VdpError> {
    let tid = params
        .terminal_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| active_or_first_terminal_id(shell))
        .ok_or_else(|| VdpError::unavailable("no active terminal pane"))?;
    let slot = shell
        .workspace
        .terminals
        .get(&tid)
        .ok_or_else(|| VdpError::unavailable(format!("terminal {tid:?} is not running")))?;
    let view = slot.view.read(cx);
    Ok(json!({
        "terminalId": tid,
        "spawned": view.session().is_some(),
        "exited": view.has_exited(),
        "grid": view.snapshot().map(|s| grid_text(&s)).unwrap_or_default(),
    }))
}

/// Executes `Shell.sendTerminalInput`.
pub(crate) fn exec_send_terminal_input(shell: &mut Shell, params: &VdpShellSendTerminalInputParams, cx: &mut Context<Shell>) -> Result<Value, VdpError> {
    let tid = active_or_first_terminal_id(shell).ok_or_else(|| VdpError::unavailable("no active terminal pane"))?;
    let slot = shell
        .workspace
        .terminals
        .get(&tid)
        .ok_or_else(|| VdpError::unavailable("active terminal slot missing"))?;
    let enter = params.should_enter();
    slot.view.update(cx, |v, _| {
        if enter {
            v.send_line(&params.text);
        } else {
            v.send_text(&params.text);
        }
    });
    Ok(json!(VdpAckResult { ok: true }))
}

/// Runs a legacy window-level command (`draw`, `shot:`, `key:`, `type:`, `mouse:`).
/// Returns `Ok(true)` if handled as a window command, `Ok(false)` for shell commands.
pub(crate) fn run_window_command(cmd: &str, window: &mut Window, cx: &mut App) -> Result<bool, VdpError> {
    let (name, arg) = cmd.split_once(':').unwrap_or((cmd, ""));
    match name {
        "draw" => {
            window.draw(cx).clear(cx);
        }
        "shot" => {
            save_shell_screenshot(window, arg, cx);
        }
        "key" => {
            let res = dispatch_keys(&VdpDispatchKeyParams { keys: arg.to_string() }, window, cx)?;
            eprintln!("debug script: key {arg} handled={}", res.handled);
        }
        "type" => {
            let _ = dispatch_text(&VdpTypeTextParams { text: arg.to_string() }, window, cx);
        }
        "mouse" => {
            let params = parse_legacy_mouse_arg(arg)?;
            let _ = dispatch_mouse(&params, window, cx)?;
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// Parses `mouse:<down|up|move|drag|click>,x,y[,right|middle]` into [`VdpDispatchMouseParams`].
pub(crate) fn parse_legacy_mouse_arg(arg: &str) -> Result<VdpDispatchMouseParams, VdpError> {
    let parts: Vec<&str> = arg.split(',').map(str::trim).collect();
    let kind = match parts.first().copied().unwrap_or("") {
        "down" => VdpMouseEventKind::Down,
        "up" => VdpMouseEventKind::Up,
        "move" => VdpMouseEventKind::Move,
        "drag" => VdpMouseEventKind::Drag,
        "click" => VdpMouseEventKind::Click,
        other => return Err(VdpError::invalid_params(format!("unknown mouse action {other:?}"))),
    };
    let num = |i: usize| parts.get(i).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
    let button = match parts.get(3).copied() {
        Some("right") => Some(VdpMouseButton::Right),
        Some("middle") => Some(VdpMouseButton::Middle),
        _ => Some(VdpMouseButton::Left),
    };
    Ok(VdpDispatchMouseParams {
        kind,
        x: num(1),
        y: num(2),
        button,
        end_x: None,
        end_y: None,
    })
}

/// Runs a shell-level command string shared by `Shell.runCommand` and `VIBEVALLEY_DEBUG_SCRIPT`.
pub(crate) fn run_shell_command(shell: &mut Shell, cmd: &str, window: &mut Window, cx: &mut Context<Shell>) -> Result<(), VdpError> {
    let (name, arg) = cmd.split_once(':').unwrap_or((cmd, ""));
    match name {
        "resize" => {
            if let Some((w, h)) = arg.split_once(',')
                && let (Ok(width), Ok(height)) = (w.trim().parse::<f32>(), h.trim().parse::<f32>())
            {
                let _ = exec_resize(&VdpShellResizeParams { width, height }, window)?;
            } else {
                return Err(VdpError::invalid_params(format!("invalid resize argument {arg:?}")));
            }
        }
        "new_terminal" => shell.new_terminal(None, window, cx),
        "split_right" => shell.on_action(Action::PaletteSelect { id: "pane.split_right".into() }, window, cx),
        "split_down" => shell.on_action(Action::PaletteSelect { id: "pane.split_down".into() }, window, cx),
        "close_tab" => shell.on_action(Action::PaletteSelect { id: "pane.close".into() }, window, cx),
        "activate" => shell.activate_index(arg.parse::<usize>().unwrap_or(1).saturating_sub(1), window, cx),
        "palette" => {
            let mode = match arg {
                "files" => PaletteMode::Files,
                "search" => PaletteMode::Search,
                _ => PaletteMode::Commands,
            };
            shell.open_palette(mode, window, cx);
        }
        "close_palette" => shell.close_palette(window, cx),
        "query" => shell.on_action(Action::PaletteQuery { query: arg.into() }, window, cx),
        "toggle_theme" => shell.toggle_theme(cx),
        "save" => shell.save_now(cx),
        "send" => {
            let _ = exec_send_terminal_input(
                shell,
                &VdpShellSendTerminalInputParams {
                    text: arg.to_string(),
                    enter: Some(true),
                },
                cx,
            );
        }
        "hosted" => {
            let (module, props) = arg.split_once(' ').unwrap_or((arg, "{}"));
            let props = serde_json::from_str(props).unwrap_or_else(|_| json!({}));
            shell.open_pane(PaneKind::Hosted { module: module.into(), props }, window, cx);
        }
        "diorama" => {
            let (scene, props) = arg.split_once(' ').unwrap_or((arg, "{}"));
            let props = serde_json::from_str(props).unwrap_or_else(|_| json!({}));
            shell.open_pane(PaneKind::Diorama { scene: scene.into(), props }, window, cx);
        }
        "diorama_clock" => {
            let parts: Vec<&str> = arg.split(',').collect();
            if let Some(view) = active_diorama(shell) {
                view.update(cx, |v, cx| {
                    v.set_clock(parts[0].parse().ok());
                    cx.notify();
                });
            }
        }
        "close_kind" => {
            let (kind, title) = arg.split_once('@').unwrap_or((arg, ""));
            close_tabs_by_kind(shell, kind, title, window, cx);
        }
        "close_tab_id" => {
            if let Ok(tab) = arg.parse::<TabId>() {
                shell.close_tab(tab, window, cx);
            }
        }
        "navigate" => {
            let _ = exec_navigate(shell, &VdpShellNavigateParams { route: arg.to_string() }, cx)?;
        }
        "quit" => cx.quit(),
        other => return Err(VdpError::invalid_params(format!("unknown shell command {other:?}"))),
    }
    Ok(())
}

/// Runs a `Shell.runCommand` VDP request (trying window-level commands first, then shell commands).
pub(crate) fn exec_run_command(shell: &Entity<Shell>, params: &VdpShellRunCommandParams, window: &mut Window, cx: &mut App) -> Result<Value, VdpError> {
    let cmd = params.command.trim();
    if cmd.is_empty() {
        return Err(VdpError::invalid_params("Shell.runCommand requires a non-empty command"));
    }
    if run_window_command(cmd, window, cx)? {
        return Ok(json!(VdpAckResult { ok: true }));
    }
    shell.update(cx, |s, cx| run_shell_command(s, cmd, window, cx))?;
    Ok(json!(VdpAckResult { ok: true }))
}
