use std::path::PathBuf;

use gpui::{App, Context, Entity, Window, px};
use serde_json::{Value, json};
use vibevalley_protocol::{
    VdpAckResult, VdpDispatchKeyParams, VdpDispatchMouseParams, VdpError, VdpMouseButton, VdpMouseEventKind, VdpShellClosePaneParams,
    VdpShellDispatchActionParams, VdpShellGetTerminalGridParams, VdpShellNavigateParams, VdpShellOpenPaneParams, VdpShellResizeParams,
    VdpShellRunCommandParams, VdpShellSendTerminalInputParams, VdpShellSetDioramaClockParams, VdpShellSetThemeParams, VdpTypeTextParams, VdpUiHighlightParams,
    VdpUiInspectAtResult, VdpUiInspectorModeParams,
};
use vibevalley_workspace::{DiffSpec, PaneKind, TabId};

use crate::hosted::Action;
use crate::hosted::frames::PaletteMode;
use crate::shell::{Shell, tab_title};
use crate::theme::{ThemeChoice, Ui};

use super::input::{dispatch_keys, dispatch_mouse, dispatch_text};
use super::inspect::{active_diorama, grid_text, step_unpainted_dioramas};

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

/// Runs a window-level command (`draw`, `key:`, `type:`, `mouse:`) for `Shell.runCommand`.
/// Returns `Ok(true)` if handled as a window command, `Ok(false)` for shell commands.
fn run_window_command(cmd: &str, window: &mut Window, cx: &mut App) -> Result<bool, VdpError> {
    let (name, arg) = cmd.split_once(':').unwrap_or((cmd, ""));
    match name {
        "draw" => {
            window.draw(cx).clear(cx);
        }
        "key" => {
            let _ = dispatch_keys(&VdpDispatchKeyParams { keys: arg.to_string() }, window, cx)?;
        }
        "type" => {
            let _ = dispatch_text(&VdpTypeTextParams { text: arg.to_string() }, window, cx);
        }
        "mouse" => {
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
            let _ = dispatch_mouse(
                &VdpDispatchMouseParams {
                    kind,
                    x: num(1),
                    y: num(2),
                    button,
                    end_x: None,
                    end_y: None,
                },
                window,
                cx,
            )?;
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// Runs a shell-level command string for `Shell.runCommand`.
fn run_shell_command(shell: &mut Shell, cmd: &str, window: &mut Window, cx: &mut Context<Shell>) -> Result<(), VdpError> {
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
            let seconds = parts.first().and_then(|p| p.parse::<f32>().ok());
            let _ = exec_set_diorama_clock(shell, &VdpShellSetDioramaClockParams { seconds }, cx);
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

/// Executes `Shell.dispatchAction` with a typed [`vibevalley_protocol::HostAction`].
pub(crate) fn exec_dispatch_action(shell: &mut Shell, params: &VdpShellDispatchActionParams, window: &mut Window, cx: &mut Context<Shell>) -> Value {
    shell.on_action(params.action.clone(), window, cx);
    json!(VdpAckResult { ok: true })
}

/// Executes `Shell.save`.
pub(crate) fn exec_save(shell: &mut Shell, cx: &mut Context<Shell>) -> Value {
    shell.save_now(cx);
    json!(VdpAckResult { ok: true })
}

/// Executes `Shell.getUpdateState`.
pub(crate) fn exec_get_update_state() -> Value {
    json!({
        "ready": crate::update::ready(),
        "state": crate::update::state(),
    })
}

/// Executes `Shell.setDioramaClock`.
pub(crate) fn exec_set_diorama_clock(shell: &mut Shell, params: &VdpShellSetDioramaClockParams, cx: &mut Context<Shell>) -> Value {
    if let Some(view) = active_diorama(shell) {
        view.update(cx, |v, cx| {
            v.set_clock(params.seconds);
            cx.notify();
        });
    }
    json!(VdpAckResult { ok: true })
}

/// Executes `Page.draw`.
pub(crate) fn exec_page_draw(shell: &Entity<Shell>, window: &mut Window, cx: &mut App) -> Value {
    window.draw(cx).clear(cx);
    shell.update(cx, |s, cx| step_unpainted_dioramas(s, cx));
    json!(VdpAckResult { ok: true })
}

/// Executes `UI.highlight`.
pub(crate) fn exec_ui_highlight(shell: &mut Shell, params: &VdpUiHighlightParams, cx: &mut Context<Shell>) -> Value {
    let hit = if params.test_id.is_none() && params.bounds.is_none() {
        None
    } else {
        Some(VdpUiInspectAtResult {
            hit: true,
            surface: params.surface.clone(),
            test_id: params.test_id.clone(),
            role: None,
            text: params.label.clone(),
            route: None,
            source: params.source.clone(),
            bounds: params.bounds,
        })
    };
    shell.set_devtools_highlight(hit, cx);
    json!(VdpAckResult { ok: true })
}

/// Executes `UI.setInspectorMode`.
pub(crate) fn exec_ui_set_inspector_mode(shell: &mut Shell, params: &VdpUiInspectorModeParams, cx: &mut Context<Shell>) -> Value {
    shell.set_devtools_inspecting(params.enabled, cx);
    json!(VdpAckResult { ok: true })
}
