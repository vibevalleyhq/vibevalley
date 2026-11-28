use std::collections::HashSet;

use gpui::{App, Entity, Window};
use serde_json::{Value, json};
use vibevalley_protocol::{VdpCaptureScreenshotParams, VdpPageMetrics, VdpScreenshotTarget, VdpTarget, VdpTargetKind};
use vibevalley_workspace::{PaneKind, TabId};

use crate::hosted::{HostedView, ShellDebugHandle};
use crate::panes::PaneEntity;
use crate::shell::{Shell, tab_title};
use crate::theme::Ui;

use super::GpuiExecResult;

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

/// Captures the full shell state snapshot for `Shell.getState`.
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

    if route.as_deref().is_some_and(|r| r.starts_with("/library") || r.starts_with("/notes")) {
        targets.push(VdpTarget {
            id: "webview".into(),
            kind: VdpTargetKind::Webview,
            title: "Note WebView".into(),
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

pub(super) fn active_diorama(s: &Shell) -> Option<Entity<crate::diorama::DioramaView>> {
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
                    Err(e) => GpuiExecResult::Ready(Err(vibevalley_protocol::VdpError::internal(format!("render_to_image failed: {e}")))),
                }
            }
            #[cfg(not(feature = "shot"))]
            {
                let _ = (window, cx);
                GpuiExecResult::Ready(Err(vibevalley_protocol::VdpError::unavailable(
                    "shell screenshot requires building vibevalley-mac with --features shot",
                )))
            }
        }
    }
}

/// Encodes a GPUI [`image::RgbaImage`] as base64 PNG off the UI thread, optionally resizing.
#[cfg(feature = "shot")]
pub(crate) fn encode_shell_png(
    image: image::RgbaImage,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<vibevalley_protocol::VdpScreenshotResult, vibevalley_protocol::VdpError> {
    use base64::Engine as _;
    use image::ImageEncoder as _;
    use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
    use image::imageops::{self, FilterType};
    use vibevalley_protocol::{VdpError, VdpScreenshotResult};

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
