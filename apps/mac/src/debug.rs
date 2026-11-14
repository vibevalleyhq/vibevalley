//! Automation hooks for checking the app without looking at it.
//!
//! - `VIBEVALLEY_DEBUG_DUMP=<file>`: once a second, writes what the shell holds as
//!   JSON: projects, layouts, each terminal's visible grid as text, each
//!   hosted view's applied frames and errors, open viewers and diffs.
//! - `VIBEVALLEY_DEBUG_SCRIPT=<file>`: after projects load, runs one step per
//!   line: a hosted-view action as JSON (`{"type":"open_file",...}`), or
//!   `{"shell":"<command>"}` with commands `new_terminal`, `split_right`,
//!   `split_down`, `close_tab`, `activate:<n>`, `palette:<files|commands|search>`,
//!   `close_palette`, `query:<text>`, `toggle_theme`, `send:<text>` (typed
//!   into the focused group's terminal, then Enter), `wait:<ms>`, `save`, `quit`.

use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::{App, AppContext as _, Entity, Window, WindowHandle};
use serde_json::{Value, json};
use vibevalley_workspace::{PaneKind, TabId};

use crate::hosted::frames::PaletteMode;
use crate::hosted::{Action, bridge};
use crate::panes::{PaneEntity, tab_title};
use crate::shell::Shell;

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

pub fn dump(shell: &Shell, cx: &App) -> Value {
    let projects: Vec<Value> = shell
        .ws
        .projects()
        .iter()
        .map(|p| {
            let tabs: Vec<Value> = p
                .layout
                .tabs()
                .map(|t| {
                    let mut v = json!({ "id": t.id, "kind": serde_json::to_value(&t.kind).unwrap_or(Value::Null), "title": tab_title(shell, t, cx) });
                    match &t.kind {
                        PaneKind::Terminal { terminal_id } => {
                            if let Some(view) = shell.terminals.get(terminal_id) {
                                let view = view.read(cx);
                                v["spawned"] = json!(view.session().is_some());
                                v["exited"] = json!(view.has_exited());
                                v["grid"] = json!(view.snapshot().map(|s| grid_text(&s)).unwrap_or_default());
                            } else {
                                v["spawned"] = json!(false);
                            }
                            v["registered"] = json!(p.terminal(terminal_id).is_some());
                        }
                        _ => match shell.panes.get(&(p.id(), t.id)) {
                            Some(PaneEntity::File(f)) => v["viewer"] = json!({ "status": f.read(cx).status(), "reloads": f.read(cx).reloads() }),
                            Some(PaneEntity::Diff(d)) => v["diff"] = json!(d.read(cx).summary()),
                            Some(PaneEntity::Hosted(view)) => v["hosted"] = view.read(cx).debug_state(),
                            Some(PaneEntity::Pixel(view)) => v["pixel"] = view.read(cx).debug_state(),
                            None => {}
                        },
                    }
                    v
                })
                .collect();
            let view = shell.projects.get(&p.id());
            json!({
                "id": p.id(),
                "name": p.info.name,
                "root": p.root(),
                "active": shell.ws.active_id() == Some(p.id()),
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
    json!({
        "loaded": shell.loaded,
        "load_error": shell.load_error,
        "panel": format!("{:?}", shell.panel),
        "native_workspace": shell.native_workspace,
        "sidebar_visible": shell.sidebar_visible,
        "theme_dark": crate::theme::Ui::get(cx).colors.dark,
        "projects": projects,
        "sidebar": shell.sidebar.read(cx).debug_state(),
        "workbench": shell.workbench.read(cx).debug_state(),
        "pixel": shell.native_pixel.as_ref().map(|v| v.read(cx).debug_state()),
        "palette": shell.palette.as_ref().map(|p| json!({
            "open": p.open, "mode": p.mode.name(), "query": p.query, "view": p.view.read(cx).debug_state(),
        })),
        "live_terminal_views": shell.terminals.len(),
        "bridge_probe": shell.probe,
        "tray": shell.tray,
        "pane_entities": shell.panes.len(),
    })
}

pub fn start(shell: Entity<Shell>, window: WindowHandle<gpui_kit::base::Root>, cx: &mut App) {
    if let Some(path) = std::env::var_os("VIBEVALLEY_DEBUG_DUMP").map(PathBuf::from) {
        let shell = shell.clone();
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(1000)).await;
                let (value, pictures) = cx.update(|cx| {
                    let pictures = shell.update(cx, |s, cx| dump_pixels(s, &path, cx));
                    (dump(shell.read(cx), cx), pictures)
                });
                cx.background_executor()
                    .spawn(async move {
                        for (file, list, atlas) in pictures {
                            let _ = crate::pixel::draw::raster(&list, atlas.as_deref(), 2.0).save(&file);
                        }
                    })
                    .await;
                let text = serde_json::to_string_pretty(&value).unwrap_or_default();
                let tmp = path.with_extension("tmp");
                if std::fs::write(&tmp, text).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
        })
        .detach();
    }
    if let Some(path) = std::env::var_os("VIBEVALLEY_DEBUG_SCRIPT").map(PathBuf::from) {
        let steps: Vec<String> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect();
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(200)).await;
                if cx.update(|cx| shell.read(cx).loaded) {
                    break;
                }
            }
            for step in steps {
                cx.background_executor().timer(Duration::from_millis(400)).await;
                eprintln!("debug script: {step}");
                let value: Value = serde_json::from_str(&step).unwrap_or(Value::Null);
                if let Some(cmd) = value.get("shell").and_then(Value::as_str) {
                    if let Some(ms) = cmd.strip_prefix("wait:") {
                        cx.background_executor().timer(Duration::from_millis(ms.parse().unwrap_or(500))).await;
                        continue;
                    }
                    if cmd == "wait_update" {
                        let deadline = std::time::Instant::now() + Duration::from_secs(120);
                        while !crate::update::ready() && std::time::Instant::now() < deadline {
                            cx.background_executor().timer(Duration::from_millis(100)).await;
                        }
                        eprintln!("debug script: update ready={}", crate::update::ready());
                        continue;
                    }
                    let cmd = cmd.to_string();
                    // Through the untyped handle: the typed one leases the root view, which `draw` renders.
                    let _ = cx.update_window(window.into(), |_, window, cx| {
                        if !run_window(&cmd, window, cx) {
                            shell.update(cx, |s, cx| run(s, &cmd, window, cx))
                        }
                    });
                } else {
                    match bridge::parse_action(&value) {
                        Ok(action) => {
                            let _ = window.update(cx, |_, window, cx| shell.update(cx, |s, cx| s.on_action(action, window, cx)));
                        }
                        Err(e) => eprintln!("debug script: {e}"),
                    }
                }
            }
        })
        .detach();
    }
}

/// Commands that act on the window as input or output does, through the same
/// dispatch and paint paths as real events, so they work without a visible
/// screen. Returns false for shell commands.
fn run_window(cmd: &str, window: &mut Window, cx: &mut App) -> bool {
    use gpui_kit::{Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, point, px};
    let (name, arg) = cmd.split_once(':').unwrap_or((cmd, ""));
    match name {
        // `draw`: lays out and paints a frame now (the platform does not ask for frames while locked).
        "draw" => window.draw(cx).clear(cx),
        // `shot:<file.png>`: the window's frame rendered by Metal into a texture.
        "shot" => {
            window.draw(cx).clear(cx);
            shot(window, arg);
        }
        // `key:cmd-1 cmd-shift-p`: keystrokes through the key-binding dispatch.
        "key" => {
            for text in arg.split_whitespace() {
                // `parse` wants a static str; scripts are short.
                match gpui_kit::Keystroke::parse(text.to_string().leak()) {
                    Ok(k) => {
                        window.draw(cx).clear(cx);
                        let handled = window.dispatch_keystroke(k, cx);
                        eprintln!("debug script: key {text} handled={handled}");
                    }
                    Err(_) => eprintln!("debug script: key {text}: not a keystroke"),
                }
            }
        }
        // `type:<text>`: characters as plain key presses.
        "type" => {
            for ch in arg.chars() {
                let key = ch.to_string();
                window.draw(cx).clear(cx);
                window.dispatch_keystroke(
                    gpui_kit::Keystroke {
                        modifiers: Modifiers::default(),
                        key: key.clone(),
                        key_char: Some(key),
                    },
                    cx,
                );
            }
        }
        // `mouse:<down|up|move|drag|click>,x,y[,right]` in window points.
        "mouse" => {
            let parts: Vec<&str> = arg.split(',').map(str::trim).collect();
            let num = |i: usize| parts.get(i).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
            let position = point(px(num(1)), px(num(2)));
            let button = if parts.get(3) == Some(&"right") {
                MouseButton::Right
            } else {
                MouseButton::Left
            };
            let modifiers = Modifiers::default();
            let down = PlatformInput::MouseDown(MouseDownEvent {
                button,
                position,
                modifiers,
                click_count: 1,
                first_mouse: false,
            });
            let up = PlatformInput::MouseUp(MouseUpEvent {
                button,
                position,
                modifiers,
                click_count: 1,
            });
            let moved = |pressed| {
                PlatformInput::MouseMove(MouseMoveEvent {
                    position,
                    modifiers,
                    pressed_button: pressed,
                })
            };
            let events = match parts.first().copied().unwrap_or("") {
                "down" => vec![down],
                "up" => vec![up],
                "move" => vec![moved(None)],
                "drag" => vec![moved(Some(button))],
                "click" => vec![down, up],
                other => {
                    eprintln!("debug script: mouse {other}?");
                    Vec::new()
                }
            };
            for event in events {
                window.draw(cx).clear(cx);
                window.dispatch_event(event, cx);
            }
        }
        _ => return false,
    }
    true
}

#[cfg(feature = "shot")]
fn shot(window: &mut Window, path: &str) {
    match window.render_to_image() {
        Ok(image) => match image.save(path) {
            Ok(()) => eprintln!("debug script: shot {path} {}x{}", image.width(), image.height()),
            Err(e) => eprintln!("debug script: shot {path}: {e}"),
        },
        Err(e) => eprintln!("debug script: shot: {e}"),
    }
}

#[cfg(not(feature = "shot"))]
fn shot(_: &mut Window, path: &str) {
    eprintln!("debug script: shot {path}: build with --features shot");
}

fn active_pixel(s: &Shell, cx: &App) -> Option<Entity<crate::pixel::view::PixelView>> {
    let _ = cx;
    if let Some(view) = &s.native_pixel {
        return Some(view.clone());
    }
    let project = s.ws.active()?;
    let tab = project.layout.active_tab()?;
    match s.panes.get(&(project.id(), tab.id)) {
        Some(PaneEntity::Pixel(v)) => Some(v.clone()),
        _ => None,
    }
}

/// Each open pixel pane's last frame as a PNG beside the dump
/// (`<dump>.<scene>-<tab>.png`), painted on the CPU from the same draw list.
fn dump_pixels(
    shell: &Shell,
    path: &std::path::Path,
    cx: &mut App,
) -> Vec<(PathBuf, crate::pixel::draw::DrawList, Option<std::sync::Arc<crate::pixel::atlas::Atlas>>)> {
    let mut out = Vec::new();
    if let Some(view) = &shell.native_pixel {
        view.update(cx, |v, _| v.draw_unpainted());
        let v = view.read(cx);
        if let Some((list, atlas)) = v.snapshot() {
            out.push((path.with_extension(format!("{}-native.png", v.kind)), list, atlas));
        }
    }
    for ((_, tab), pane) in &shell.panes {
        if let PaneEntity::Pixel(view) = pane {
            view.update(cx, |v, _| v.draw_unpainted());
            let v = view.read(cx);
            if let Some((list, atlas)) = v.snapshot() {
                out.push((path.with_extension(format!("{}-{tab}.png", v.kind)), list, atlas));
            }
        }
    }
    out
}

fn run(s: &mut Shell, cmd: &str, window: &mut Window, cx: &mut gpui_kit::Context<Shell>) {
    let (name, arg) = cmd.split_once(':').unwrap_or((cmd, ""));
    match name {
        "resize" => {
            if let Some((w, h)) = arg.split_once(',')
                && let (Ok(w), Ok(h)) = (w.parse::<f32>(), h.parse::<f32>())
                && w.is_finite()
                && h.is_finite()
                && w > 0.0
                && h > 0.0
            {
                window.resize(gpui_kit::size(gpui_kit::px(w), gpui_kit::px(h)));
            }
        }
        "new_terminal" => s.new_terminal(None, window, cx),
        "split_right" => s.on_action(Action::PaletteSelect { id: "pane.split_right".into() }, window, cx),
        "split_down" => s.on_action(Action::PaletteSelect { id: "pane.split_down".into() }, window, cx),
        "close_tab" => s.on_action(Action::PaletteSelect { id: "pane.close".into() }, window, cx),
        "activate" => s.activate_index(arg.parse::<usize>().unwrap_or(1).saturating_sub(1), window, cx),
        "palette" => {
            let mode = match arg {
                "files" => PaletteMode::Files,
                "search" => PaletteMode::Search,
                _ => PaletteMode::Commands,
            };
            s.open_palette(mode, window, cx);
        }
        "close_palette" => s.close_palette(window, cx),
        "query" => s.on_action(Action::PaletteQuery { query: arg.into() }, window, cx),
        "toggle_theme" => s.toggle_theme(cx),
        "save" => s.save_now(cx),
        "send" => {
            let Some(project) = s.ws.active() else { return };
            let Some(PaneKind::Terminal { terminal_id }) = project.layout.active_tab().map(|t| t.kind.clone()) else {
                return;
            };
            if let Some(t) = s.terminals.get(&terminal_id) {
                t.read(cx).send_line(arg);
            }
        }
        // `hosted:<module>[ <props JSON>]`
        "hosted" => {
            let (module, props) = arg.split_once(' ').unwrap_or((arg, "{}"));
            let props = serde_json::from_str(props).unwrap_or(json!({}));
            s.open_pane(PaneKind::Hosted { module: module.into(), props }, window, cx)
        }
        "pixel" => {
            let (scene, props) = arg.split_once(' ').unwrap_or((arg, "{}"));
            let props = serde_json::from_str(props).unwrap_or(json!({}));
            s.open_pane(PaneKind::Pixel { scene: scene.into(), props }, window, cx)
        }
        // `pixel_tap:<x>,<y>[,right]` and `pixel_point:<x>,<y>` on the active pixel pane, art pixels.
        "pixel_tap" | "pixel_point" => {
            let parts: Vec<&str> = arg.split(',').collect();
            let num = |i: usize| parts.get(i).and_then(|v| v.trim().parse::<f32>().ok()).unwrap_or(0.0);
            if let Some(view) = active_pixel(s, cx) {
                let p = crate::pixel::level::pt(num(0), num(1));
                let right = parts.get(2) == Some(&"right");
                view.update(cx, |v, cx| if name == "pixel_tap" { v.tap(p, right, cx) } else { v.point(Some(p)) });
            }
        }
        // `pixel_clock:<time of day 0..1>[,<speed>]`
        "pixel_clock" => {
            let parts: Vec<&str> = arg.split(',').collect();
            if let Some(view) = active_pixel(s, cx) {
                view.update(cx, |v, _| v.set_clock(parts[0].parse().ok(), parts.get(1).and_then(|p| p.parse().ok())));
            }
        }
        // `close_kind:pixel` / `close_kind:hosted` / `close_kind:terminal`: closes every such tab of the active project
        // (scripts clean up what they opened, since the layout is saved).
        // `close_kind:terminal@/private/tmp` also needs the title to contain what follows `@`.
        "close_kind" => {
            let (kind, title) = arg.split_once('@').unwrap_or((arg, ""));
            let tabs: Vec<TabId> =
                s.ws.active()
                    .map(|p| {
                        p.layout
                            .tabs()
                            .filter(|t| serde_json::to_value(&t.kind).ok().and_then(|v| v["kind"].as_str().map(|k| k == kind)) == Some(true))
                            .filter(|t| title.is_empty() || tab_title(s, t, cx).contains(title))
                            .map(|t| t.id)
                            .collect()
                    })
                    .unwrap_or_default();
            for tab in tabs {
                s.close_tab(tab, window, cx);
            }
        }
        "close_tab_id" => {
            if let Ok(tab) = arg.parse::<TabId>() {
                s.close_tab(tab, window, cx);
            }
        }
        "quit" => cx.quit(),
        other => eprintln!("debug script: unknown command {other}"),
    }
}
