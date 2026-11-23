//! Renders the active project's layout tree: splits with draggable
//! dividers, and per group a tab bar over the active tab's pane.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Context, Entity, FocusHandle, Focusable, Hsla, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels,
    Point, StatefulInteractiveElement as _, Styled as _, Window, canvas, div, px, relative,
};
use vibevalley_workspace::{Axis, Group, Layout, Node, PaneKind, Tab, TabId};

use crate::diff::DiffView;
use crate::hosted::HostedView;
use crate::icon::gpui_icon;
use crate::pixel::view::PixelView;
use crate::shell::Shell;
use crate::theme::{Palette, Ui};
use crate::viewer::FileViewer;

pub(crate) const TITLEBAR_HEIGHT: f32 = 36.0;
pub(crate) const WINDOW_DRAG_SLOP: f32 = 3.0;

pub(crate) fn is_titlebar_hit(y: f32) -> bool {
    (0.0..TITLEBAR_HEIGHT).contains(&y)
}

pub(crate) fn exceeded_window_drag_slop(origin: (f32, f32), current: (f32, f32)) -> bool {
    (current.0 - origin.0).abs() > WINDOW_DRAG_SLOP || (current.1 - origin.1).abs() > WINDOW_DRAG_SLOP
}

#[derive(Clone)]
pub enum PaneEntity {
    File(Entity<FileViewer>),
    Diff(Entity<DiffView>),
    Hosted(Entity<HostedView>),
    Pixel(Entity<PixelView>),
}

impl PaneEntity {
    pub fn focus_handle(&self, cx: &App) -> FocusHandle {
        match self {
            PaneEntity::File(v) => v.read(cx).focus_handle(cx),
            PaneEntity::Diff(v) => v.read(cx).focus_handle(cx),
            PaneEntity::Hosted(view) => view.read(cx).focus_handle(cx),
            PaneEntity::Pixel(v) => v.read(cx).focus_handle(cx),
        }
    }

    fn element(&self) -> AnyElement {
        match self {
            PaneEntity::File(v) => v.clone().into_any_element(),
            PaneEntity::Diff(v) => v.clone().into_any_element(),
            PaneEntity::Hosted(view) => view.clone().into_any_element(),
            PaneEntity::Pixel(v) => v.clone().into_any_element(),
        }
    }
}

/// Where each split was laid out last frame, for divider drags.
#[derive(Default, Clone)]
pub struct SplitBounds(Rc<RefCell<HashMap<u64, Bounds<Pixels>>>>);

impl SplitBounds {
    /// The fraction child `index` of `split` should take of the space it
    /// shares with the next child, for a divider dragged to `at`.
    pub fn fraction(&self, layout: &Layout, split: u64, index: usize, at: Point<Pixels>) -> Option<f32> {
        let bounds = *self.0.borrow().get(&split)?;
        let s = find_split(&layout.root, split)?;
        let (origin, size, pos) = match s.axis {
            Axis::Horizontal => (bounds.origin.x, bounds.size.width, at.x),
            Axis::Vertical => (bounds.origin.y, bounds.size.height, at.y),
        };
        let size = f32::from(size);
        if size <= 0.0 || index + 1 >= s.ratios.len() {
            return None;
        }
        let before: f32 = s.ratios[..index].iter().sum();
        let pair = s.ratios[index] + s.ratios[index + 1];
        let start = f32::from(origin) + before * size;
        Some(((f32::from(pos) - start) / (pair * size)).clamp(0.0, 1.0))
    }
}

fn find_split(node: &Node, id: u64) -> Option<&vibevalley_workspace::Split> {
    match node {
        Node::Split(s) if s.id == id => Some(s),
        Node::Split(s) => s.children.iter().find_map(|c| find_split(c, id)),
        Node::Group(_) => None,
    }
}

pub fn render_main(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    let colors = Ui::get(cx).colors.clone();
    let Some(project) = shell.ws.active() else {
        if shell.load_error.is_none() && !shell.loaded {
            return div().size_full().bg(colors.bg).into_any_element();
        }
        let text = match &shell.load_error {
            Some(e) => format!("Could not open the project store: {e}"),
            None => vibevalley_i18n::t("desktop.terminal.noProject", &[]),
        };
        return div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .text_color(colors.muted)
            .text_size(px(13.0))
            .child(text)
            .into_any_element();
    };
    let layout = project.layout.clone();
    render_node(shell, &layout, &layout.root, window, cx)
}

fn render_node(shell: &mut Shell, layout: &Layout, node: &Node, window: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    match node {
        Node::Group(g) => render_group(shell, layout, g, window, cx),
        Node::Split(s) => {
            let colors = Ui::get(cx).colors.clone();
            let bounds = shell.split_bounds.clone();
            let id = s.id;
            let horizontal = s.axis == Axis::Horizontal;
            let mut container = div().size_full().relative().flex().when_horizontal(horizontal).child(
                canvas(
                    move |b, _, _| {
                        bounds.0.borrow_mut().insert(id, b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            );
            for (i, child) in s.children.iter().enumerate() {
                let ratio = s.ratios.get(i).copied().unwrap_or(1.0 / s.children.len() as f32);
                let inner = render_node(shell, layout, child, window, cx);
                let cell = if horizontal {
                    div().h_full().w(relative(ratio)).min_w_0().overflow_hidden().child(inner)
                } else {
                    div().w_full().h(relative(ratio)).min_h_0().overflow_hidden().child(inner)
                };
                container = container.child(cell);
                if i + 1 < s.children.len() {
                    let divider_hover = colors.accent;
                    let divider = div()
                        .id(("divider", (id as usize) * 64 + i))
                        .flex_none()
                        .bg(colors.border)
                        .hover(move |s| s.bg(divider_hover))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |shell, _, _, cx| {
                                cx.stop_propagation();
                                shell.window_drag_origin = None;
                                shell.dragging_split = Some((id, i));
                            }),
                        );
                    container = container.child(if horizontal {
                        divider.w(px(1.0)).h_full().cursor_col_resize()
                    } else {
                        divider.h(px(1.0)).w_full().cursor_row_resize()
                    });
                }
            }
            container.into_any_element()
        }
    }
}

trait FlexDir {
    fn when_horizontal(self, horizontal: bool) -> Self;
}

impl FlexDir for gpui::Div {
    fn when_horizontal(self, horizontal: bool) -> Self {
        if horizontal { self.flex_row() } else { self.flex_col() }
    }
}

/// Resolves a terminal tab's display title: link titles win, then cleaned OSC
/// session titles (stripping spinners, command echoes, and redundant agent
/// prefixes), then canonical agent names for coding agents, else the shell name.
pub fn terminal_name(t: &crate::terminal::TerminalView) -> String {
    let status = t.terminal_status();
    resolve_terminal_name(t.link_title(), t.osc_title(), t.running_command(), &status, &shell_name())
}

pub(crate) fn resolve_terminal_name(
    link_title: Option<&str>,
    osc_title: Option<&str>,
    running_command: Option<&str>,
    status: &crate::terminal::TerminalStatus,
    fallback_shell: &str,
) -> String {
    if let Some(title) = link_title.map(str::trim).filter(|s| !s.is_empty() && !is_default_title(s)) {
        return title.to_owned();
    }
    if let Some(raw) = osc_title
        && let Some(cleaned) = clean_osc_session_title(raw, status.agent.as_deref(), running_command)
    {
        return cleaned;
    }
    if status.is_coding_agent()
        && let Some(agent) = status.agent.as_deref()
    {
        return crate::terminal::agent_display_name(agent, status.label.as_deref().unwrap_or(agent));
    }
    fallback_shell.to_owned()
}

fn is_spinner_or_status_glyph(c: char) -> bool {
    matches!(
        c,
        '\u{2800}'
            ..='\u{28FF}'
                | '\u{FE0F}'
                | '✳'
                | '✱'
                | '✽'
                | '✻'
                | '✶'
                | '✦'
                | '✧'
                | '●'
                | '○'
                | '◉'
                | '◌'
                | '◐'
                | '◑'
                | '◒'
                | '◓'
                | '▪'
                | '▫'
                | '▸'
                | '▹'
                | '›'
                | '⏳'
                | '⌛'
                | '⚡'
                | '✨'
                | '🤖'
                | '🟢'
                | '🟡'
                | '🔴'
                | '🔵'
                | '🟣'
                | '⚪'
                | '🟠'
    )
}

fn strip_leading_glyphs(mut s: &str) -> &str {
    loop {
        let trimmed = s.trim_start();
        let next = trimmed.trim_start_matches(is_spinner_or_status_glyph);
        if next.len() == s.len() {
            return next.trim();
        }
        s = next;
    }
}

fn starts_with_ci<'a>(haystack: &'a str, needle: &str) -> Option<&'a str> {
    if haystack.len() < needle.len() || !haystack.is_char_boundary(needle.len()) {
        return None;
    }
    let (head, tail) = haystack.split_at(needle.len());
    head.eq_ignore_ascii_case(needle).then_some(tail)
}

fn is_command_echo(cleaned: &str, running_command: Option<&str>) -> bool {
    let Some(cmd) = running_command.map(str::trim).filter(|c| !c.is_empty()) else {
        return false;
    };
    if cleaned.eq_ignore_ascii_case(cmd) {
        return true;
    }
    let Some(first_tok) = crate::terminal::first_command_token(cmd) else {
        return false;
    };
    if cleaned.eq_ignore_ascii_case(first_tok) {
        return true;
    }
    let starts_with_tok = starts_with_ci(cleaned, first_tok).is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace));
    if !starts_with_tok {
        return false;
    }
    if starts_with_ci(cmd, cleaned).is_some() {
        return true;
    }
    // Also catch commands prefixed by `env`/`sudo`/env assignments (e.g. `RUST_LOG=info cargo test`).
    cmd.find(first_tok).is_some_and(|idx| starts_with_ci(&cmd[idx..], cleaned).is_some())
}

fn strip_agent_prefix(text: &str) -> &str {
    const PREFIXES: &[&str] = &[
        "Antigravity CLI",
        "Antigravity",
        "agy",
        "Claude Code",
        "Claude",
        "Codex",
        "OpenCode",
        "Cursor",
        "Kimi",
        "Grok",
    ];
    const SEPARATORS: &[&str] = &[" — ", " – ", " - ", " · ", ": ", " | "];
    for prefix in PREFIXES {
        if let Some(after_prefix) = starts_with_ci(text, prefix) {
            for sep in SEPARATORS {
                if let Some(rest) = after_prefix.strip_prefix(sep) {
                    return strip_leading_glyphs(rest);
                }
            }
        }
    }
    text
}

fn is_bare_agent_name(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "antigravity" | "antigravity cli" | "agy" | "claude" | "claude code" | "codex" | "opencode" | "cursor" | "kimi" | "pi" | "grok"
    )
}

fn clean_osc_session_title(raw: &str, agent: Option<&str>, running_command: Option<&str>) -> Option<String> {
    let cleaned = strip_leading_glyphs(raw);
    if cleaned.is_empty() || is_default_title(cleaned) || is_command_echo(cleaned, running_command) {
        return None;
    }
    let is_coding_agent = agent.is_some_and(|a| a != "cmd");
    let result = if is_coding_agent {
        let stripped = strip_agent_prefix(cleaned);
        if stripped.is_empty() || is_default_title(stripped) || is_bare_agent_name(stripped) {
            return None;
        }
        stripped
    } else {
        cleaned
    };
    Some(result.to_owned())
}

/// Every tab's title in a project, with a number after names that repeat, so
/// the tab bar and the sidebar tell the same shells apart the same way.
pub fn numbered_titles<'a>(shell: &Shell, tabs: impl Iterator<Item = &'a Tab>, cx: &App) -> std::collections::HashMap<TabId, String> {
    let titled: Vec<(TabId, String)> = tabs.map(|t| (t.id, tab_title(shell, t, cx))).collect();
    let mut total: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (_, title) in &titled {
        *total.entry(title.as_str()).or_default() += 1;
    }
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = std::collections::HashMap::new();
    for (id, title) in &titled {
        let name = if total[title.as_str()] > 1 {
            let n = seen.entry(title.clone()).or_default();
            *n += 1;
            format!("{title} {n}")
        } else {
            title.clone()
        };
        out.insert(*id, name);
    }
    out
}

/// Default shell-generated titles that add noise in tabs and the sidebar:
/// `user@host`, `user@host:~/dir`, `zsh — user@host`, bare paths (`~/...`, `/...`),
/// or raw shell paths (`/bin/zsh`, `-zsh`).
pub(crate) fn is_default_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with("~/") || trimmed.starts_with('/') || trimmed == "~" {
        return true;
    }
    let bare = trimmed.trim_start_matches('-').rsplit('/').next().unwrap_or(trimmed);
    if matches!(bare, "zsh" | "bash" | "sh" | "fish" | "nu" | "pwsh" | "login") {
        return true;
    }
    trimmed.split_whitespace().any(|tok| {
        let tok = tok.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | ':' | ','));
        tok.contains('@') && !tok.starts_with('@') && tok.split_once('@').is_some_and(|(u, h)| !u.is_empty() && !h.is_empty() && !u.contains('/'))
    })
}

fn shell_name() -> String {
    std::env::var("SHELL")
        .ok()
        .and_then(|s| s.rsplit('/').next().map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "shell".into())
}

fn chat_runtime_label(runtime: &str) -> &str {
    match runtime {
        "antigravity" => "Antigravity",
        "claude" => "Claude",
        "codex" => "Codex",
        other if !other.is_empty() => other,
        _ => "Chat",
    }
}

pub fn tab_title(shell: &Shell, tab: &Tab, cx: &App) -> String {
    match &tab.kind {
        PaneKind::Terminal { link: Some(link), .. } => link.title.clone(),
        PaneKind::Terminal { terminal_id, .. } => shell
            .terminals
            .get(terminal_id)
            .map(|t| terminal_name(t.view.read(cx)))
            .unwrap_or_else(shell_name),
        PaneKind::Chat { runtime, title, .. } => title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| chat_runtime_label(runtime).to_string()),
        PaneKind::File { path } => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        PaneKind::Diff { spec, path, .. } => {
            let what = match spec {
                vibevalley_workspace::DiffSpec::Unstaged => "Changes".to_string(),
                vibevalley_workspace::DiffSpec::Staged => "Staged".to_string(),
                vibevalley_workspace::DiffSpec::Uncommitted => "Uncommitted".to_string(),
                vibevalley_workspace::DiffSpec::Commit { id } => id.chars().take(8).collect(),
                vibevalley_workspace::DiffSpec::Range { from, to } => format!("{from}..{to}"),
            };
            match path.as_ref().and_then(|p| p.file_name()) {
                Some(name) => format!("{} ({what})", name.to_string_lossy()),
                None => what,
            }
        }
        PaneKind::Hosted { module, props } => match props.get("path").and_then(|p| p.as_str()) {
            Some(path) => format!("{} ({module})", path.rsplit('/').next().unwrap_or(path)),
            None => module.clone(),
        },
        PaneKind::Pixel { scene, .. } => match scene.as_str() {
            "farm" => "农场".into(),
            "map" => "地图".into(),
            "tree" => "记忆树".into(),
            "opening" => "开场".into(),
            other => other.to_string(),
        },
    }
}

fn render_group(shell: &mut Shell, layout: &Layout, g: &Group, _: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    let colors = Ui::get(cx).colors.clone();
    let hover_bg = colors.hover;
    let focused = layout.focused == g.id;
    let group_id = g.id;
    let pid = shell.ws.active_id().unwrap_or_default();
    let groups = layout.groups();
    let multi_group = groups.len() > 1;
    let is_first_group = groups.first().is_some_and(|first| first.id == group_id);
    let is_last_group = groups.last().is_some_and(|last| last.id == group_id);
    let sidebar_visible = shell.sidebar_visible;
    let inspector_open = shell.inspector_open;

    let mut tabs_row = div()
        .id(("tabbar", group_id as usize))
        .h_full()
        .flex_1()
        .min_w_0()
        .px(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .overflow_x_scroll();
    if is_first_group && !sidebar_visible {
        tabs_row = tabs_row.child(
            div()
                .id("expand-left-sidebar")
                .size(px(26.0))
                .mr(px(2.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .border_1()
                .border_color(transparent())
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .child(gpui_icon("sidebar", 14.0, colors.muted))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|s, _, _, cx| {
                        cx.stop_propagation();
                        s.toggle_sidebar(cx);
                    }),
                ),
        );
    }
    let names = shell.ws.active().map(|p| numbered_titles(shell, p.layout.tabs(), cx)).unwrap_or_default();
    for (i, tab) in g.tabs.iter().enumerate() {
        let active = i == g.active;
        let tab_id = tab.id;
        let title = names.get(&tab.id).cloned().unwrap_or_else(|| tab_title(shell, tab, cx));
        let (attention, chat_working) = match &tab.kind {
            PaneKind::Terminal { terminal_id, .. } => (shell.ws.active().and_then(|p| p.terminal(terminal_id)).is_some_and(|t| t.attention), false),
            PaneKind::Chat { .. } => shell
                .chat_statuses
                .get(&(pid, tab.id))
                .map(|s| (s.attention, s.status == "working"))
                .unwrap_or((false, false)),
            _ => (false, false),
        };
        let indicator = if attention {
            Some(div().size(px(6.0)).flex_none().rounded_full().bg(colors.warning))
        } else if chat_working {
            Some(div().size(px(6.0)).flex_none().rounded_full().bg(colors.accent))
        } else {
            None
        };
        let focused_bar = if active && focused && multi_group {
            Some(
                div()
                    .absolute()
                    .bottom_0()
                    .left(px(8.0))
                    .right(px(8.0))
                    .h(px(2.0))
                    .rounded_full()
                    .bg(colors.accent),
            )
        } else {
            None
        };
        tabs_row = tabs_row.child(
            div()
                .id(("tab", tab_id as usize))
                .relative()
                .h(px(26.0))
                .pl(px(10.0))
                .pr(px(4.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .max_w(px(210.0))
                .rounded(px(6.0))
                .border_1()
                .text_size(px(12.0))
                .cursor_pointer()
                .tab_style(active, &colors)
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Middle,
                    cx.listener(move |shell, _, window, cx| {
                        cx.stop_propagation();
                        shell.close_tab(tab_id, window, cx);
                    }),
                )
                .on_click(cx.listener(move |shell, _, window, cx| {
                    if let Some(p) = shell.ws.active_mut() {
                        p.layout.activate(tab_id);
                        if let Some(p) = shell.ws.active_mut() {
                            p.layout.focus_group(group_id);
                        }
                    }
                    shell.layout_changed(window, cx);
                }))
                .children(focused_bar)
                .children(indicator)
                .child(div().overflow_hidden().text_ellipsis().whitespace_nowrap().child(title))
                .child(
                    div()
                        .id(("close", tab_id as usize))
                        .size(px(18.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.0))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover_bg))
                        .child(gpui_icon("close", 11.0, if active { colors.muted } else { colors.faint }))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |shell, _, window, cx| {
                            cx.stop_propagation();
                            shell.close_tab(tab_id, window, cx);
                        })),
                ),
        );
    }
    let menu_open = shell.chat_menu_group == Some(group_id);
    let new_btn = div()
        .id(("new-tab", group_id as usize))
        .size(px(26.0))
        .ml(px(4.0))
        .mr(px(if is_last_group { 2.0 } else { 6.0 }))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.0))
        .border_1()
        .cursor_pointer()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |shell, _, _, cx| {
                cx.stop_propagation();
                // Use render-time `menu_open`: `on_mouse_down_out` already cleared
                // `chat_menu_group` during capture when clicking `+` to toggle off.
                shell.chat_menu_group = if menu_open { None } else { Some(group_id) };
                cx.notify();
            }),
        );
    let new_btn = if menu_open {
        new_btn
            .bg(colors.elevated)
            .border_color(colors.border)
            .child(gpui_icon("add", 13.0, colors.text))
    } else {
        new_btn
            .bg(transparent())
            .border_color(transparent())
            .hover(move |s| s.bg(hover_bg))
            .child(gpui_icon("add", 13.0, colors.muted))
    };

    let mut bar = div()
        .h(px(36.0))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .bg(colors.surface)
        .border_b_1()
        .border_color(colors.border)
        .child(tabs_row)
        .child(new_btn);

    if is_last_group {
        let inspector_btn = div()
            .id("toggle-inspector")
            .size(px(26.0))
            .ml(px(4.0))
            .mr(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.0))
            .border_1()
            .cursor_pointer()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, _, _, cx| {
                    cx.stop_propagation();
                    s.toggle_inspector(cx);
                }),
            );
        let inspector_btn = if inspector_open {
            inspector_btn
                .bg(colors.elevated)
                .border_color(colors.border)
                .child(gpui_icon("sidebarRight", 14.0, colors.text))
        } else {
            inspector_btn
                .bg(transparent())
                .border_color(transparent())
                .hover(move |s| s.bg(hover_bg))
                .child(gpui_icon("sidebarRight", 14.0, colors.muted))
        };
        bar = bar.child(inspector_btn);
    }
    let content: AnyElement = match g.active_tab() {
        Some(Tab {
            kind: PaneKind::Terminal { terminal_id, .. },
            ..
        }) => match shell.terminals.get(terminal_id) {
            Some(t) => t.view.clone().into_any_element(),
            None => div().into_any_element(),
        },
        Some(tab) => match shell.panes.get(&(pid, tab.id)) {
            Some(p) => p.entity.element(),
            None => div().into_any_element(),
        },
        None => div().into_any_element(),
    };
    let chat_menu = menu_open.then(|| {
        let choices = [("antigravity", "Antigravity"), ("claude", "Claude Code"), ("codex", "Codex")];
        let mut panel = div()
            .id(("chat-runtime-menu", group_id as usize))
            .absolute()
            .top(px(38.0))
            .right(px(if is_last_group { 38.0 } else { 8.0 }))
            .w(px(216.0))
            .p(px(4.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.elevated)
            .shadow_md()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .occlude()
            .on_mouse_down_out(cx.listener(|shell, _, _, cx| {
                if shell.chat_menu_group.take().is_some() {
                    cx.notify();
                }
            }))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id(("new-terminal-item", group_id as usize))
                    .h(px(28.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .text_size(px(12.5))
                    .text_color(colors.text)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(gpui_icon("terminal", 13.0, colors.muted))
                            .child(vibevalley_i18n::t("desktop.workspace.newTerminal", &[])),
                    )
                    .child(div().text_size(px(11.0)).text_color(colors.faint).child("⌘T"))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |shell, _, window, cx| {
                        shell.chat_menu_group = None;
                        if let Some(p) = shell.ws.active_mut() {
                            p.layout.focus_group(group_id);
                        }
                        shell.new_terminal(None, window, cx);
                    })),
            )
            .child(div().my(px(2.0)).mx(px(4.0)).h(px(1.0)).bg(colors.border))
            .child(
                div()
                    .px(px(8.0))
                    .py(px(3.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .text_size(px(11.0))
                    .text_color(colors.faint)
                    .child(vibevalley_i18n::t("desktop.workspace.newChat", &[]))
                    .child(vibevalley_i18n::t("desktop.workspace.chooseRuntime", &[])),
            );
        for (idx, (rt_id, rt_label)) in choices.iter().enumerate() {
            let rt_owned = (*rt_id).to_string();
            panel = panel.child(
                div()
                    .id(("chat-runtime", (group_id as usize) * 8 + idx))
                    .h(px(28.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .text_size(px(12.5))
                    .text_color(colors.text)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(gpui_icon("chat", 13.0, colors.accent))
                            .child(vibevalley_i18n::t("desktop.workspace.newChatWith", &[("runtime", (*rt_label).into())])),
                    )
                    .children((idx == 0).then(|| div().text_size(px(11.0)).text_color(colors.faint).child("⇧⌘T")))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |shell, _, window, cx| {
                        shell.chat_menu_group = None;
                        if let Some(p) = shell.ws.active_mut() {
                            p.layout.focus_group(group_id);
                        }
                        shell.new_chat(Some(rt_owned.clone()), window, cx);
                    })),
            );
        }
        panel
    });

    div()
        .id(("group", group_id as usize))
        .relative()
        .size_full()
        .flex()
        .flex_col()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |shell, _, _, cx| {
                let mut changed = shell.chat_menu_group.take().is_some();
                if let Some(p) = shell.ws.active_mut()
                    && p.layout.focused != group_id
                {
                    p.layout.focus_group(group_id);
                    changed = true;
                }
                if changed {
                    cx.notify();
                }
            }),
        )
        .child(bar)
        .child(div().flex_1().min_h_0().child(content))
        .children(chat_menu)
        .into_any_element()
}

fn transparent() -> Hsla {
    gpui::hsla(0.0, 0.0, 0.0, 0.0)
}

trait TabLook {
    fn tab_style(self, active: bool, colors: &Palette) -> Self;
}

impl TabLook for gpui::Stateful<gpui::Div> {
    fn tab_style(self, active: bool, colors: &Palette) -> Self {
        if active {
            self.bg(colors.bg).border_color(colors.border).text_color(colors.text)
        } else {
            let hover = colors.hover;
            let text = colors.text;
            self.bg(transparent())
                .border_color(transparent())
                .text_color(colors.muted)
                .hover(move |s| s.bg(hover).text_color(text))
        }
    }
}

#[cfg(test)]
mod name_tests {
    use crate::terminal::{RunningState, TerminalStatus};

    use super::{is_default_title, resolve_terminal_name};

    fn agent_status(agent: &str, state: RunningState) -> TerminalStatus {
        TerminalStatus {
            state,
            agent: Some(agent.into()),
            label: Some(agent.into()),
        }
    }

    fn cmd_status(cmd: &str) -> TerminalStatus {
        TerminalStatus {
            state: RunningState::Working,
            agent: Some("cmd".into()),
            label: Some(cmd.into()),
        }
    }

    #[test]
    fn a_shells_own_title_is_not_a_name() {
        assert!(is_default_title("lucasay@Caos-MacBook-Pro:~/farm"));
        assert!(is_default_title("lucasay@mac"));
        assert!(is_default_title("zsh — lucasay@mac: ~/orca/projects/vibevalley"));
        assert!(is_default_title("~/orca/projects/vibevalley"));
        assert!(is_default_title("/Users/lucasay/orca/projects/vibevalley"));
        assert!(is_default_title("-zsh"));
        assert!(is_default_title("me@host"));
        assert!(!is_default_title("vim notes.md"));
        assert!(!is_default_title("@team"));
    }

    #[test]
    fn link_title_always_wins_over_osc_and_running_agent() {
        let status = agent_status("antigravity", RunningState::Working);
        assert_eq!(
            resolve_terminal_name(Some("  Release Worker  "), Some("✳ Other Title"), Some("agy"), &status, "zsh"),
            "Release Worker"
        );
    }

    #[test]
    fn coding_agent_osc_title_strips_spinners_and_redundant_engine_prefixes() {
        let agy = agent_status("antigravity", RunningState::Working);
        assert_eq!(
            resolve_terminal_name(None, Some("✳ Fix terminal titles"), Some("agy"), &agy, "zsh"),
            "Fix terminal titles"
        );
        assert_eq!(
            resolve_terminal_name(None, Some("⠋ Unified Content Hub"), Some("agy"), &agy, "zsh"),
            "Unified Content Hub"
        );
        assert_eq!(
            resolve_terminal_name(None, Some("Antigravity — Refactor sidebar"), Some("agy"), &agy, "zsh"),
            "Refactor sidebar"
        );
        assert_eq!(
            resolve_terminal_name(None, Some("Antigravity CLI · Swarm V1"), Some("agy"), &agy, "zsh"),
            "Swarm V1"
        );
        let claude = agent_status("claude", RunningState::Ready);
        assert_eq!(
            resolve_terminal_name(None, Some("Claude Code: Fix bug"), Some("claude"), &claude, "zsh"),
            "Fix bug"
        );
    }

    #[test]
    fn bare_agent_launch_echo_falls_back_to_canonical_display_name() {
        let agy = agent_status("antigravity", RunningState::Working);
        assert_eq!(
            resolve_terminal_name(None, Some("agy --resume"), Some("agy --resume abc"), &agy, "zsh"),
            "Antigravity"
        );
        assert_eq!(resolve_terminal_name(None, Some("✳ Antigravity"), Some("agy"), &agy, "zsh"), "Antigravity");
        let claude = agent_status("claude", RunningState::Ready);
        assert_eq!(resolve_terminal_name(None, Some("Claude Code"), Some("claude"), &claude, "zsh"), "Claude Code");
        assert_eq!(resolve_terminal_name(None, None, Some("claude"), &claude, "zsh"), "Claude Code");
        let codex = agent_status("codex", RunningState::Working);
        assert_eq!(resolve_terminal_name(None, Some("codex"), Some("codex"), &codex, "zsh"), "Codex");
        assert!(!super::is_bare_agent_name("dsh"));
    }

    #[test]
    fn regular_shell_command_never_shows_command_name_or_preexec_echo() {
        let cargo = cmd_status("cargo");
        assert_eq!(resolve_terminal_name(None, Some("cargo test"), Some("cargo test"), &cargo, "zsh"), "zsh");
        assert_eq!(resolve_terminal_name(None, Some("cargo"), Some("cargo test --all"), &cargo, "zsh"), "zsh");
        assert_eq!(resolve_terminal_name(None, None, Some("cargo test"), &cargo, "zsh"), "zsh");
        let git = cmd_status("git");
        assert_eq!(resolve_terminal_name(None, Some("git status"), Some("git status -sb"), &git, "zsh"), "zsh");
    }

    #[test]
    fn explicit_custom_osc_title_on_idle_shell_is_preserved() {
        let idle = TerminalStatus::idle();
        assert_eq!(resolve_terminal_name(None, Some("API Server"), None, &idle, "zsh"), "API Server");
        assert_eq!(resolve_terminal_name(None, Some("vim notes.md"), None, &idle, "zsh"), "vim notes.md");
        assert_eq!(resolve_terminal_name(None, Some("~/repo"), None, &idle, "zsh"), "zsh");
    }

    #[test]
    fn titlebar_hit_uses_strict_half_open_36px_strip() {
        assert!(!super::is_titlebar_hit(-0.1));
        assert!(super::is_titlebar_hit(0.0));
        assert!(super::is_titlebar_hit(18.0));
        assert!(super::is_titlebar_hit(35.99));
        assert!(!super::is_titlebar_hit(36.0));
        assert!(!super::is_titlebar_hit(40.0));
        assert!(!super::is_titlebar_hit(f32::NAN));
    }

    #[test]
    fn window_drag_slop_requires_movement_beyond_3px_threshold() {
        let origin = (100.0, 18.0);
        assert!(!super::exceeded_window_drag_slop(origin, (100.0, 18.0)));
        assert!(!super::exceeded_window_drag_slop(origin, (103.0, 21.0)));
        assert!(!super::exceeded_window_drag_slop(origin, (97.0, 15.0)));
        assert!(super::exceeded_window_drag_slop(origin, (103.1, 18.0)));
        assert!(super::exceeded_window_drag_slop(origin, (100.0, 14.9)));
    }
}
