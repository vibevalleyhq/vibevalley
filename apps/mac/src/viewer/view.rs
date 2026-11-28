use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gpui::{AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ScrollStrategy, UniformListScrollHandle, Window};
use nsh_platform_gpui::{App as NshApp, AppOptions, AppView, Appearance};
use vibevalley_files::FileContent;

use crate::host::EditorTarget;
use crate::theme::Ui;

use super::highlight::prepare;
use super::toolbar::{EditorToolbarState, build_html_preview_bundle, build_html_preview_document, is_html_path};
use super::{HtmlViewMode, MAX_BYTES, State};

pub enum ViewerEvent {
    OpenInEditor(EditorTarget),
    Preview,
    Reveal,
}

pub struct FileViewer {
    pub(super) path: PathBuf,
    pub(super) state: State,
    pub(super) focus: FocusHandle,
    pub(super) scroll: UniformListScrollHandle,
    pending_line: Option<u32>,
    reloads: u64,
    load_gen: u64,
    pub(super) show_skeleton: bool,
    pub(super) toolbar: EditorToolbarState,
    pub(super) html_mode: HtmlViewMode,
    pub(super) html_preview: Option<Entity<AppView>>,
    html_preview_dark: Option<bool>,
    pub(super) html_preview_error: Option<String>,
}

impl FileViewer {
    pub fn new(path: PathBuf, cx: &mut Context<Self>) -> Self {
        let html_mode = HtmlViewMode::default_for_path(&path);
        let mut viewer = FileViewer {
            path,
            state: State::Loading,
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            pending_line: None,
            reloads: 0,
            load_gen: 0,
            show_skeleton: false,
            toolbar: EditorToolbarState::new(),
            html_mode,
            html_preview: None,
            html_preview_dark: None,
            html_preview_error: None,
        };
        EditorToolbarState::refresh_editors(cx, |v: &mut Self| &mut v.toolbar);
        viewer.reload(cx);
        viewer
    }

    pub(super) fn copy_path(&mut self, cx: &mut Context<Self>) {
        self.toolbar.copy_path(&self.path, cx, |v| &mut v.toolbar);
    }

    pub(super) fn toggle_editor_menu(&mut self, was_open: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.toolbar.toggle_editor_menu(was_open, &self.focus, window, cx, |v| &mut v.toolbar);
        self.sync_html_covered(cx);
    }

    pub(super) fn set_editor_menu_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.toolbar.editor_menu_open != open {
            self.toolbar.editor_menu_open = open;
            self.sync_html_covered(cx);
            cx.notify();
        }
    }

    fn sync_html_covered(&self, cx: &gpui::App) {
        if let Some(app) = &self.html_preview {
            let _ = app.read(cx).host().send("covered", serde_json::Value::Bool(self.toolbar.editor_menu_open));
        }
    }

    pub(super) fn set_html_mode(&mut self, mode: HtmlViewMode, cx: &mut Context<Self>) {
        if self.html_mode != mode {
            self.html_mode = mode;
            cx.notify();
        }
    }

    pub(super) fn ensure_html_preview(&mut self, html: Arc<str>, window: &mut Window, cx: &mut Context<Self>) {
        let dark = Ui::get(cx).colors.dark;
        if let Some(app) = &self.html_preview {
            if self.html_preview_dark != Some(dark) {
                self.html_preview_dark = Some(dark);
                app.update(cx, |app, cx| app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx));
            }
            return;
        }
        if self.html_preview_error.is_some() {
            return;
        }
        let bundle = match build_html_preview_bundle() {
            Ok(b) => b,
            Err(err) => {
                self.html_preview_error = Some(err);
                return;
            }
        };
        crate::hosted::ensure_ui_sets();
        let covered = self.toolbar.editor_menu_open;
        let options = AppOptions {
            appearance: Appearance::System,
            data_dir: Some(crate::host::Storage::configured().views),
            inline_root: true,
            ..Default::default()
        };
        let app = cx.new(|cx| {
            let app = AppView::new(options, window, cx);
            app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx);
            let host = app.host();
            let mut params = serde_json::Map::new();
            params.insert("html".into(), serde_json::Value::String(html.to_string()));
            params.insert("covered".into(), serde_json::Value::Bool(covered));
            host.set_params(params);
            app.on_error(|message| {
                tracing::warn!(target: "vibevalley::viewer", %message, "html preview error");
            });
            app.load(NshApp::Js(bundle));
            app
        });
        self.html_preview = Some(app);
        self.html_preview_dark = Some(dark);
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> String {
        match &self.state {
            State::Loading => "loading".into(),
            State::Text { lines, language, .. } => {
                format!("text {} lines {}", lines.len(), language.as_ref().map_or("plain", |l| l.0.as_str()))
            }
            State::Image => "image".into(),
            State::Binary(n) => format!("binary {n} bytes"),
            State::TooLarge(n) => format!("too large {n} bytes"),
            State::Error(e) => format!("error {e}"),
        }
    }

    pub fn reloads(&self) -> u64 {
        self.reloads
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.load_gen = self.load_gen.wrapping_add(1);
        let generation = self.load_gen;
        if matches!(self.state, State::Loading) {
            self.show_skeleton = false;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let _ = this.update(cx, |v, cx| {
                    if v.load_gen == generation && matches!(v.state, State::Loading) {
                        v.show_skeleton = true;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        let path = self.path.clone();
        let is_html = is_html_path(&path);
        let task = cx.background_spawn(async move {
            match vibevalley_files::load_file(&path, MAX_BYTES) {
                Ok(FileContent::Text { text, language }) => {
                    let lines = prepare(&text, language.as_ref());
                    let html_doc = is_html.then(|| Arc::<str>::from(build_html_preview_document(&text)));
                    State::Text {
                        lines: Arc::new(lines),
                        language,
                        html_doc,
                    }
                }
                Ok(FileContent::Image { .. }) => State::Image,
                Ok(FileContent::Binary { size }) => State::Binary(size),
                Ok(FileContent::TooLarge { size }) => State::TooLarge(size),
                Err(e) => State::Error(e.to_string()),
            }
        });
        cx.spawn(async move |this, cx| {
            let state = task.await;
            let _ = this.update(cx, |v, cx| {
                if v.load_gen != generation {
                    return;
                }
                v.state = state;
                v.show_skeleton = false;
                v.reloads += 1;
                if let (State::Text { html_doc: Some(html), .. }, Some(app)) = (&v.state, &v.html_preview) {
                    let _ = app.read(cx).host().send("html", serde_json::Value::String(html.to_string()));
                }
                if let Some(line) = v.pending_line.take() {
                    v.scroll_to_line(line, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// 1-based line, as search hits give it.
    pub fn scroll_to_line(&mut self, line: u32, cx: &mut Context<Self>) {
        if self.is_html() {
            self.html_mode = HtmlViewMode::Source;
        }
        match self.state {
            State::Text { .. } => self.scroll.scroll_to_item(line.saturating_sub(1) as usize, ScrollStrategy::Center),
            _ => self.pending_line = Some(line),
        }
        cx.notify();
    }

    pub(super) fn is_markdown(&self) -> bool {
        matches!(&self.state, State::Text { language: Some(l), .. } if l.0 == "markdown") || self.path.extension().is_some_and(|e| e == "md" || e == "markdown")
    }

    pub(super) fn is_html(&self) -> bool {
        is_html_path(&self.path)
    }
}

impl EventEmitter<ViewerEvent> for FileViewer {}

impl Focusable for FileViewer {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}
