//! Native GPUI Markdown preview pane backed directly by `vibevalley_rich`'s
//! pure-Rust `VvMarkdown` root (`nsh_platform_gpui::App::Rust`, zero QuickJS VM).
//!
//! Renders a unified 34px native GPUI header bar (file icon, filename, truncated
//! parent path, source/copy/reload/reveal/open-in-editor icon actions), a 150ms
//! anti-flicker skeleton, error states, file-watch reload, and synchronized
//! light/dark theme and UI font scale.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use gpui::{
    AnyElement, AppContext as _, ClipboardItem, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    KeyDownEvent, MouseButton, ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use nsh_platform_gpui::{App as NshApp, AppOptions, AppView, Appearance};
use serde_json::json;
use tokio::sync::mpsc::UnboundedSender;
use vibevalley_rich::{NativeMarkdownDoc, NativeMarkdownEvent, native_markdown_root};

use crate::host::{EditorOption, EditorTarget};
use crate::icon::{editor_popover, gpui_icon, icon_button, icon_caret_button};
use crate::theme::{Palette, Ui};

const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub enum MarkdownPaneEvent {
    OpenSource,
    OpenFile(PathBuf),
    OpenUrl(String),
    OpenRoute(String),
    OpenInEditor(EditorTarget),
    Reveal,
}

enum LoadState {
    Loading,
    Loaded,
    Error(String),
}

pub struct MarkdownView {
    path: PathBuf,
    state: LoadState,
    app: Entity<AppView>,
    doc_tx: UnboundedSender<NativeMarkdownDoc>,
    focus: FocusHandle,
    reloads: u64,
    load_gen: u64,
    show_skeleton: bool,
    copied: bool,
    copy_gen: u64,
    editor_menu_open: bool,
    editor_options: Vec<EditorOption>,
}

impl MarkdownView {
    pub fn new(path: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::hosted::ensure_ui_sets();
        let ui = Ui::get(cx);
        let dark = ui.colors.dark;
        let ui_font_size = ui.settings.ui_font_size;
        let base_dir = path.parent().map(|p| p.to_string_lossy().into_owned());
        let caps_json = markdown_capabilities_json(&path);
        let native = native_markdown_root(NativeMarkdownDoc { text: String::new(), base_dir }, Some(&caps_json));
        let doc_tx = native.doc_tx;
        let mut event_rx = native.event_rx;
        let root = native.root;
        let options = AppOptions {
            appearance: Appearance::System,
            data_dir: Some(crate::host::Storage::configured().views),
            ..Default::default()
        };
        let app = cx.new(|cx| {
            let app = AppView::new(options, window, cx);
            app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx);
            let scale = ui_font_size / 13.0;
            if (scale - 1.0).abs() > 0.01 {
                app.set_font_scale(Some(scale), cx);
            }
            app.load(NshApp::Rust(root));
            app
        });

        cx.spawn(async move |this, cx| {
            while let Some(event) = event_rx.recv().await {
                let alive = this.update(cx, |view, cx| view.on_native_event(event, cx));
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut view = Self {
            path,
            state: LoadState::Loading,
            app,
            doc_tx,
            focus: cx.focus_handle(),
            reloads: 0,
            load_gen: 0,
            show_skeleton: false,
            copied: false,
            copy_gen: 0,
            editor_menu_open: false,
            editor_options: crate::host::cached_editor_options(),
        };
        view.refresh_editors(cx);
        view.reload(cx);
        view
    }

    fn refresh_editors(&mut self, cx: &mut Context<Self>) {
        let task = cx.background_spawn(async { crate::host::detect_editors_blocking() });
        cx.spawn(async move |this, cx| {
            let options = task.await;
            let _ = this.update(cx, |v, cx| {
                if v.editor_options != options {
                    v.editor_options = options;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn copy_path(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.path.to_string_lossy().into_owned()));
        self.copied = true;
        self.copy_gen = self.copy_gen.wrapping_add(1);
        let generation = self.copy_gen;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let _ = this.update(cx, |v, cx| {
                if v.copy_gen == generation && v.copied {
                    v.copied = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn toggle_editor_menu(&mut self, was_open: bool, window: &mut Window, cx: &mut Context<Self>) {
        // Use render-time `was_open`: `on_mouse_down_out` already cleared
        // `editor_menu_open` during capture when clicking the trigger to close.
        self.editor_menu_open = !was_open;
        if self.editor_menu_open {
            window.focus(&self.focus, cx);
            self.refresh_editors(cx);
        }
        cx.notify();
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> String {
        match &self.state {
            LoadState::Loading => "loading".into(),
            LoadState::Loaded => "loaded".into(),
            LoadState::Error(e) => format!("error {e}"),
        }
    }

    pub fn reloads(&self) -> u64 {
        self.reloads
    }

    pub fn set_dark(&mut self, dark: bool, cx: &mut Context<Self>) {
        self.app
            .update(cx, |app, cx| app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx));
        cx.notify();
    }

    pub fn set_ui_font_size(&mut self, size: f32, cx: &mut Context<Self>) {
        let scale = size / 13.0;
        let opt = ((scale - 1.0).abs() > 0.01).then_some(scale);
        self.app.update(cx, |app, cx| app.set_font_scale(opt, cx));
        cx.notify();
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.load_gen = self.load_gen.wrapping_add(1);
        let generation = self.load_gen;
        if matches!(self.state, LoadState::Loading) {
            self.show_skeleton = false;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let _ = this.update(cx, |v, cx| {
                    if v.load_gen == generation && matches!(v.state, LoadState::Loading) {
                        v.show_skeleton = true;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        let path = self.path.clone();
        let task = cx.background_spawn(async move { read_markdown_file(&path) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |v, cx| {
                if v.load_gen != generation {
                    return;
                }
                v.show_skeleton = false;
                v.reloads += 1;
                match result {
                    Ok(markdown) => {
                        let base_dir = v.path.parent().map(|p| p.to_string_lossy().into_owned());
                        let _ = v.doc_tx.send(NativeMarkdownDoc { text: markdown, base_dir });
                        v.state = LoadState::Loaded;
                    }
                    Err(err) => {
                        v.state = LoadState::Error(err);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn on_native_event(&mut self, event: NativeMarkdownEvent, cx: &mut Context<Self>) {
        match event {
            NativeMarkdownEvent::LinkPress(url) => {
                let trimmed = url.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return;
                }
                if is_external_url(trimmed) {
                    cx.emit(MarkdownPaneEvent::OpenUrl(trimmed.to_string()));
                    return;
                }
                if let Some(local) = resolve_local_link(trimmed, self.path.parent()) {
                    cx.emit(MarkdownPaneEvent::OpenFile(local));
                    return;
                }
                cx.emit(MarkdownPaneEvent::OpenUrl(trimmed.to_string()));
            }
            NativeMarkdownEvent::IssuePress(number) => {
                cx.emit(MarkdownPaneEvent::OpenRoute(format!("/issues/{number}")));
            }
            NativeMarkdownEvent::GenUiAction { action, payload } => {
                let action = action.trim();
                let payload = payload.trim();
                if action == "navigate" && payload.starts_with('/') {
                    cx.emit(MarkdownPaneEvent::OpenRoute(payload.to_string()));
                } else if action == "copy" && !payload.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(payload.to_string()));
                }
            }
            NativeMarkdownEvent::CodeCopy(code) => {
                cx.write_to_clipboard(ClipboardItem::new_string(code));
            }
        }
    }
}

impl EventEmitter<MarkdownPaneEvent> for MarkdownView {}

impl Focusable for MarkdownView {
    fn focus_handle(&self, cx: &gpui::App) -> FocusHandle {
        match self.state {
            LoadState::Loaded => self.app.read(cx).focus_handle(cx),
            LoadState::Loading | LoadState::Error(_) => self.focus.clone(),
        }
    }
}

fn read_markdown_file(path: &Path) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("No Markdown file path provided.".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file.", path.display()));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("File exceeds the {} MB Markdown preview limit.", MAX_BYTES / (1024 * 1024)));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

fn markdown_capabilities_json(path: &Path) -> String {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(parent) = path.parent()
        && let Ok(canon) = std::fs::canonicalize(parent)
    {
        roots.push(canon);
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from)
        && let Ok(canon) = std::fs::canonicalize(home)
    {
        roots.push(canon);
    }
    let work_root = crate::serving::work_root();
    if let Ok(canon) = std::fs::canonicalize(work_root) {
        roots.push(canon);
    }
    let assets = crate::pixel::assets_dir();
    if let Ok(canon) = std::fs::canonicalize(assets) {
        roots.push(canon);
    }
    let server_home = crate::hosted::server_home();
    if let Ok(canon) = std::fs::canonicalize(server_home) {
        roots.push(canon);
    }
    roots.sort();
    roots.dedup();
    json!({
        "clipboard": true,
        "fs": {
            "read": roots,
            "write": [],
        }
    })
    .to_string()
}

fn has_ascii_prefix_ci(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len() && value.is_char_boundary(prefix.len()) && value[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn is_external_url(url: &str) -> bool {
    has_ascii_prefix_ci(url, "https://") || has_ascii_prefix_ci(url, "http://") || has_ascii_prefix_ci(url, "mailto:")
}

fn has_uri_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z')) && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

pub(crate) fn resolve_local_link(raw_url: &str, base_dir: Option<&Path>) -> Option<PathBuf> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    if has_ascii_prefix_ci(trimmed, "file://") {
        let rest = &trimmed["file://".len()..];
        let local = if has_ascii_prefix_ci(rest, "localhost/") {
            &rest["localhost".len()..]
        } else {
            rest
        };
        let stripped = local.split(['?', '#']).next().unwrap_or("");
        if stripped.is_empty() {
            return None;
        }
        let decoded = crate::host::percent_decode(stripped);
        return Some(normalize_path(Path::new(&decoded)));
    }
    if has_uri_scheme(trimmed) {
        return None;
    }
    let stripped = trimmed.split(['?', '#']).next().unwrap_or("");
    if stripped.is_empty() {
        return None;
    }
    let decoded = crate::host::percent_decode(stripped);
    let candidate = Path::new(&decoded);
    if candidate.is_absolute() {
        Some(normalize_path(candidate))
    } else if let Some(dir) = base_dir {
        Some(normalize_path(&dir.join(candidate)))
    } else {
        Some(normalize_path(candidate))
    }
}

fn doc_skeleton(colors: &Palette) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .px(px(40.0))
        .py(px(32.0))
        .child(
            div()
                .w_full()
                .max_w(px(820.0))
                .flex()
                .flex_col()
                .gap(px(18.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.0))
                        .child(div().w(px(320.0)).h(px(26.0)).rounded(px(6.0)).bg(colors.hover))
                        .child(div().w_full().h(px(1.0)).bg(colors.border)),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.0))
                        .child(div().w_full().h(px(13.0)).rounded(px(4.0)).bg(colors.surface))
                        .child(div().w(px(640.0)).max_w_full().h(px(13.0)).rounded(px(4.0)).bg(colors.surface))
                        .child(div().w(px(480.0)).max_w_full().h(px(13.0)).rounded(px(4.0)).bg(colors.hover)),
                )
                .child(div().w_full().h(px(160.0)).rounded(px(8.0)).bg(colors.surface))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.0))
                        .child(div().w(px(240.0)).h(px(18.0)).rounded(px(5.0)).bg(colors.hover))
                        .child(div().w_full().h(px(13.0)).rounded(px(4.0)).bg(colors.surface))
                        .child(div().w(px(540.0)).max_w_full().h(px(13.0)).rounded(px(4.0)).bg(colors.surface)),
                ),
        )
        .into_any_element()
}

fn error_card(detail: String, colors: &Palette) -> AnyElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(
            div()
                .max_w(px(460.0))
                .px(px(20.0))
                .py(px(16.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(Hsla { a: 0.35, ..colors.danger })
                .bg(colors.removed_bg)
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .text_size(px(13.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors.danger)
                        .child("Could not open Markdown file"),
                )
                .child(div().text_size(px(12.0)).text_color(colors.text).child(detail)),
        )
        .into_any_element()
}

impl Render for MarkdownView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = Ui::get(cx).colors.clone();
        let (file_name, parent_dir) = crate::viewer::split_display_path(&self.path);
        let menu_open = self.editor_menu_open;
        let toolbar = div()
            .h(px(34.0))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .border_b_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(gpui_icon("file", 13.0, colors.muted))
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors.text)
                            .child(file_name),
                    )
                    .children(parent_dir.map(|dir| {
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_size(px(11.5))
                            .text_color(colors.faint)
                            .child(dir)
                    })),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(3.0))
                    .child(
                        icon_button("md-source", "show", "View source", true, &colors)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(MarkdownPaneEvent::OpenSource))),
                    )
                    .child(
                        icon_button(
                            "md-copy-path",
                            if self.copied { "check" } else { "copy" },
                            if self.copied { "Copied" } else { "Copy path" },
                            false,
                            &colors,
                        )
                        .on_click(cx.listener(|v, _, _, cx| v.copy_path(cx))),
                    )
                    .child(icon_button("md-reload", "refresh", "Reload", false, &colors).on_click(cx.listener(|v, _, _, cx| v.reload(cx))))
                    .child(
                        icon_button("md-reveal", "folder", "Reveal in Finder", false, &colors)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(MarkdownPaneEvent::Reveal))),
                    )
                    .child(icon_caret_button("md-editor", "open", "Open in editor…", menu_open, &colors).on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |v, _, window, cx| {
                            cx.stop_propagation();
                            v.toggle_editor_menu(menu_open, window, cx);
                        }),
                    )),
            );

        let editor_menu = menu_open.then(|| {
            let select_entity = cx.entity();
            let dismiss_entity = cx.entity();
            editor_popover(
                "md-editor-menu",
                &self.editor_options,
                &colors,
                move |target, _, cx| {
                    select_entity.update(cx, |v, cx| {
                        v.editor_menu_open = false;
                        cx.emit(MarkdownPaneEvent::OpenInEditor(target));
                        cx.notify();
                    });
                },
                move |_, cx| {
                    dismiss_entity.update(cx, |v, cx| {
                        if v.editor_menu_open {
                            v.editor_menu_open = false;
                            cx.notify();
                        }
                    });
                },
            )
        });

        let body: AnyElement = match &self.state {
            LoadState::Loading if self.show_skeleton => doc_skeleton(&colors),
            LoadState::Loading => div().size_full().into_any_element(),
            LoadState::Error(err) => error_card(err.clone(), &colors),
            LoadState::Loaded => self.app.clone().into_any_element(),
        };

        div()
            .id("markdown-pane")
            .relative()
            .track_focus(&self.focus)
            .key_context("MarkdownView")
            .on_key_down(cx.listener(|v, event: &KeyDownEvent, _, cx| {
                if v.editor_menu_open && event.keystroke.key == "escape" {
                    v.editor_menu_open = false;
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.bg)
            .child(toolbar)
            .child(div().flex_1().min_h_0().child(body))
            .children(editor_menu)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_local_link_handles_relative_absolute_file_urls_and_skips_external_or_anchors() {
        let base = Path::new("/work/repo/docs");
        assert_eq!(
            resolve_local_link("./arch.md#overview", Some(base)),
            Some(PathBuf::from("/work/repo/docs/arch.md"))
        );
        assert_eq!(resolve_local_link("../README.md", Some(base)), Some(PathBuf::from("/work/repo/README.md")));
        assert_eq!(resolve_local_link("/tmp/notes%201.md", Some(base)), Some(PathBuf::from("/tmp/notes 1.md")));
        assert_eq!(
            resolve_local_link("file://localhost/tmp/guide%202.md?raw=1#top", Some(base)),
            Some(PathBuf::from("/tmp/guide 2.md"))
        );
        assert_eq!(resolve_local_link("#section", Some(base)), None);
        assert_eq!(resolve_local_link("https://example.com/doc", Some(base)), None);
        assert_eq!(resolve_local_link("mailto:dev@example.com", Some(base)), None);
    }

    #[test]
    fn read_markdown_file_loads_regular_files_and_rejects_missing_or_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let md = dir.path().join("README.md");
        std::fs::write(&md, "# Native GPUI Markdown\n\nZero QuickJS VMs.").expect("write md");
        assert_eq!(read_markdown_file(&md).expect("read md"), "# Native GPUI Markdown\n\nZero QuickJS VMs.");
        assert!(read_markdown_file(dir.path()).is_err());
        assert!(read_markdown_file(&dir.path().join("missing.md")).is_err());
    }

    #[test]
    fn split_display_path_separates_file_name_and_parent() {
        let (name, parent) = crate::viewer::split_display_path(Path::new("/tmp/repo/docs/guide.md"));
        assert_eq!(name, "guide.md");
        assert_eq!(parent.as_deref(), Some("/tmp/repo/docs"));
    }

    #[test]
    fn markdown_capabilities_json_includes_document_parent_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let md = dir.path().join("doc.md");
        std::fs::write(&md, "# hi").expect("write");
        let parsed: serde_json::Value = serde_json::from_str(&markdown_capabilities_json(&md)).expect("json");
        let reads = parsed["fs"]["read"].as_array().expect("fs.read array");
        let canon = std::fs::canonicalize(dir.path()).expect("canon");
        assert!(reads.iter().any(|v| v.as_str() == Some(canon.to_string_lossy().as_ref())));
    }
}
