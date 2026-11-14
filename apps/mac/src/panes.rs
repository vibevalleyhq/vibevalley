//! Renders the active project's layout tree: splits with draggable
//! dividers, and per group a tab bar over the active tab's pane.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels, Point,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, px, relative,
};
use vibevalley_workspace::{Axis, Group, Layout, Node, PaneKind, Tab, TabId};

use crate::diff::DiffView;
use crate::hosted::HostedView;
use crate::pixel::view::PixelView;
use crate::shell::Shell;
use crate::theme::Ui;
use crate::viewer::FileViewer;

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
        let text = match (&shell.load_error, shell.loaded) {
            (Some(e), _) => format!("Could not open the project store: {e}"),
            (None, false) => "Loading projects…".to_string(),
            (None, true) => "No project open. Add one with ⇧⌘P → Add Project.".to_string(),
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
                    let divider = div()
                        .id(("divider", (id as usize) * 64 + i))
                        .flex_none()
                        .bg(colors.border)
                        .on_mouse_down(MouseButton::Left, cx.listener(move |shell, _, _, _| shell.dragging_split = Some((id, i))));
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

impl FlexDir for gpui_kit::Div {
    fn when_horizontal(self, horizontal: bool) -> Self {
        if horizontal { self.flex_row() } else { self.flex_col() }
    }
}

/// What a terminal is called in the sidebar: what runs in it, else a title
/// the program set, else the shell and its folder. A shell's default title
/// (`user@host:path`) says nothing and is not used.
pub fn terminal_name(t: &crate::terminal::TerminalView) -> String {
    if let Some((_, label)) = t.running_status() {
        return label;
    }
    match t.title().map(str::trim).filter(|s| !s.is_empty() && !is_default_title(s)) {
        Some(title) => title.to_string(),
        None => shell_name(),
    }
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

/// `user@host`, `user@host:~/dir` and the like.
pub(crate) fn is_default_title(title: &str) -> bool {
    let first = title.split_whitespace().next().unwrap_or("");
    first.contains('@') && !first.starts_with('@') && first.split('@').next().is_some_and(|u| !u.is_empty() && !u.contains('/'))
}

fn shell_name() -> String {
    std::env::var("SHELL")
        .ok()
        .and_then(|s| s.rsplit('/').next().map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "shell".into())
}

pub fn tab_title(shell: &Shell, tab: &Tab, cx: &App) -> String {
    match &tab.kind {
        PaneKind::Terminal { terminal_id } => shell
            .terminals
            .get(terminal_id)
            .map(|t| terminal_name(t.view.read(cx)))
            .unwrap_or_else(shell_name),
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
            "catalog" => "图鉴".into(),
            other => other.to_string(),
        },
    }
}

fn render_group(shell: &mut Shell, layout: &Layout, g: &Group, _: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    let colors = Ui::get(cx).colors.clone();
    let focused = layout.focused == g.id;
    let group_id = g.id;
    let pid = shell.ws.active_id().unwrap_or_default();
    let groups = layout.groups();
    let is_first_group = groups.first().is_some_and(|first| first.id == group_id);
    let is_last_group = groups.last().is_some_and(|last| last.id == group_id);
    let sidebar_visible = shell.sidebar_visible;
    let inspector_open = shell.inspector_open;

    let mut tabs_row = div()
        .id(("tabbar", group_id as usize))
        .h_full()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_row()
        .items_center()
        .overflow_x_scroll();
    if is_first_group && !sidebar_visible {
        tabs_row = tabs_row.child(
            div()
                .id("expand-left-sidebar")
                .h(px(26.0))
                .px(px(8.0))
                .ml(px(6.0))
                .mr(px(4.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.0))
                .text_size(px(13.0))
                .text_color(colors.muted)
                .hover(|s| s.bg(colors.hover))
                .child("◧")
                .on_mouse_down(MouseButton::Left, cx.listener(|s, _, _, cx| s.toggle_sidebar(cx))),
        );
    }
    let names = shell.ws.active().map(|p| numbered_titles(shell, p.layout.tabs(), cx)).unwrap_or_default();
    for (i, tab) in g.tabs.iter().enumerate() {
        let active = i == g.active;
        let tab_id = tab.id;
        let title = names.get(&tab.id).cloned().unwrap_or_else(|| tab_title(shell, tab, cx));
        let attention = match &tab.kind {
            PaneKind::Terminal { terminal_id } => shell.ws.active().and_then(|p| p.terminal(terminal_id)).is_some_and(|t| t.attention),
            _ => false,
        };
        tabs_row = tabs_row.child(
            div()
                .id(("tab", tab_id as usize))
                .h_full()
                .px(px(10.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .max_w(px(220.0))
                .text_size(px(12.5))
                .border_r_1()
                .border_color(colors.border)
                .when_active(active, colors.bg, colors.text, colors.muted)
                .hover(|s| s.bg(colors.hover))
                .on_click(cx.listener(move |shell, _, window, cx| {
                    if let Some(p) = shell.ws.active_mut() {
                        p.layout.activate(tab_id);
                        if let Some(p) = shell.ws.active_mut() {
                            p.layout.focus_group(group_id);
                        }
                    }
                    shell.layout_changed(window, cx);
                }))
                .children(attention.then(|| div().size(px(6.0)).rounded_full().bg(colors.warning)))
                .child(div().overflow_hidden().text_ellipsis().whitespace_nowrap().child(title))
                .child(
                    div()
                        .id(("close", tab_id as usize))
                        .size(px(16.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.0))
                        .text_color(colors.muted)
                        .hover(|s| s.bg(colors.hover))
                        .child("×")
                        .on_click(cx.listener(move |shell, _, window, cx| {
                            cx.stop_propagation();
                            shell.close_tab(tab_id, window, cx);
                        })),
                ),
        );
    }
    tabs_row = tabs_row.child(
        div()
            .id(("new-tab", group_id as usize))
            .size(px(24.0))
            .ml(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.0))
            .text_color(colors.muted)
            .hover(|s| s.bg(colors.hover))
            .child("+")
            .on_click(cx.listener(move |shell, _, window, cx| {
                if let Some(p) = shell.ws.active_mut() {
                    p.layout.focus_group(group_id);
                }
                shell.new_terminal(None, window, cx);
            })),
    );

    let mut bar = div()
        .h(px(36.0))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .bg(colors.surface)
        .border_b_1()
        .border_color(colors.border)
        .child(tabs_row);

    if is_last_group {
        bar = bar.child(
            div()
                .id("toggle-inspector")
                .h(px(26.0))
                .px(px(8.0))
                .mr(px(8.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.0))
                .text_size(px(13.0))
                .bg(if inspector_open {
                    colors.elevated
                } else {
                    gpui_kit::hsla(0.0, 0.0, 0.0, 0.0)
                })
                .text_color(if inspector_open { colors.text } else { colors.muted })
                .hover(|s| s.bg(colors.hover))
                .child("◨")
                .on_mouse_down(MouseButton::Left, cx.listener(|s, _, _, cx| s.toggle_inspector(cx))),
        );
    }
    let content: AnyElement = match g.active_tab() {
        Some(Tab {
            kind: PaneKind::Terminal { terminal_id },
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
    div()
        .id(("group", group_id as usize))
        .size_full()
        .flex()
        .flex_col()
        .border_t_2()
        .border_color(if focused { colors.accent.opacity(0.6) } else { colors.surface })
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |shell, _, _, cx| {
                if let Some(p) = shell.ws.active_mut()
                    && p.layout.focused != group_id
                {
                    p.layout.focus_group(group_id);
                    cx.notify();
                }
            }),
        )
        .child(bar)
        .child(div().flex_1().min_h_0().child(content))
        .into_any_element()
}

trait TabLook {
    fn when_active(self, active: bool, bg: gpui_kit::Hsla, text: gpui_kit::Hsla, muted: gpui_kit::Hsla) -> Self;
}

impl TabLook for gpui_kit::Stateful<gpui_kit::Div> {
    fn when_active(self, active: bool, bg: gpui_kit::Hsla, text: gpui_kit::Hsla, muted: gpui_kit::Hsla) -> Self {
        if active { self.bg(bg).text_color(text) } else { self.text_color(muted) }
    }
}

#[cfg(test)]
mod name_tests {
    #[test]
    fn a_shells_own_title_is_not_a_name() {
        assert!(super::is_default_title("lucasay@Caos-MacBook-Pro:~/farm"));
        assert!(super::is_default_title("me@host"));
        assert!(!super::is_default_title("vim notes.md"));
        assert!(!super::is_default_title("@team"));
    }
}
