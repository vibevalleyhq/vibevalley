//! The read-only file viewer: highlighted text painted by GPUI, images,
//! and placeholders for binary or oversized files. Markdown files offer a
//! rendered preview (a hosted view) and every file can open in `$EDITOR`.

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    AnyElement, AppContext as _, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, FontWeight, HighlightStyle, Hsla, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, Render, ScrollStrategy, StatefulInteractiveElement as _, Styled as _, StyledImage as _, StyledText,
    UniformListScrollHandle, Window, div, hsla, img, px, uniform_list,
};
use vibevalley_files::{FileContent, HighlightKind, HighlightSpan, Language};

use crate::theme::{Palette, Ui};

const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub enum ViewerEvent {
    OpenInEditor,
    Preview,
    Reveal,
}

pub struct Line {
    pub text: String,
    pub spans: Vec<HighlightSpan>,
}

enum State {
    Loading,
    Text { lines: Arc<Vec<Line>>, language: Option<Language> },
    Image,
    Binary(u64),
    TooLarge(u64),
    Error(String),
}

pub struct FileViewer {
    path: PathBuf,
    state: State,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    pending_line: Option<u32>,
    reloads: u64,
    load_gen: u64,
    show_skeleton: bool,
}

fn matches_scope(scope: &str, prefix: &str) -> bool {
    scope == prefix || scope.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('.'))
}

fn highlight_kind_from_scopes(scopes: &[String]) -> Option<HighlightKind> {
    for scope in scopes.iter().rev() {
        if matches_scope(scope, "meta.embedded") {
            return None;
        }
        if matches_scope(scope, "comment") {
            return Some(HighlightKind::Comment);
        }
        if matches_scope(scope, "markup.heading") {
            return Some(HighlightKind::Heading);
        }
        if matches_scope(scope, "markup.bold") || matches_scope(scope, "markup.italic") {
            return Some(HighlightKind::Emphasis);
        }
        if matches_scope(scope, "string.other.link") || matches_scope(scope, "markup.underline.link") {
            return Some(HighlightKind::Link);
        }
        if matches_scope(scope, "constant.character.escape") {
            return Some(HighlightKind::Constant);
        }
        if matches_scope(scope, "string") || matches_scope(scope, "markup.inline.raw") || matches_scope(scope, "markup.fenced_code") {
            return Some(HighlightKind::String);
        }
        if matches_scope(scope, "constant.numeric") {
            return Some(HighlightKind::Number);
        }
        if matches_scope(scope, "constant") {
            return Some(HighlightKind::Constant);
        }
        if matches_scope(scope, "keyword.operator") {
            return Some(HighlightKind::Operator);
        }
        if matches_scope(scope, "keyword") || matches_scope(scope, "storage") || matches_scope(scope, "variable.language") {
            return Some(HighlightKind::Keyword);
        }
        if matches_scope(scope, "entity.name.function") || matches_scope(scope, "support.function") {
            return Some(HighlightKind::Function);
        }
        if matches_scope(scope, "entity.name.tag") || matches_scope(scope, "meta.tag") {
            return Some(HighlightKind::Tag);
        }
        if matches_scope(scope, "entity.other.attribute-name") || matches_scope(scope, "meta.attribute") {
            return Some(HighlightKind::Attribute);
        }
        if matches_scope(scope, "support.type.property-name")
            || matches_scope(scope, "variable.other.property")
            || matches_scope(scope, "meta.object-literal.key")
        {
            return Some(HighlightKind::Property);
        }
        if matches_scope(scope, "entity.name.type")
            || matches_scope(scope, "support.type")
            || matches_scope(scope, "entity.name.class")
            || matches_scope(scope, "entity.name.struct")
        {
            return Some(HighlightKind::Type);
        }
        if matches_scope(scope, "variable") {
            return Some(HighlightKind::Variable);
        }
        if matches_scope(scope, "punctuation") {
            return Some(HighlightKind::Punctuation);
        }
    }
    None
}

fn highlight_lines(text: &str, language: &Language) -> Vec<Vec<HighlightSpan>> {
    vibevalley_rich::tokenize_scopes(text, &language.0)
        .into_iter()
        .map(|line_spans| {
            let mut merged: Vec<HighlightSpan> = Vec::new();
            for span in line_spans {
                let Some(kind) = highlight_kind_from_scopes(&span.scopes) else {
                    continue;
                };
                if let Some(last) = merged.last_mut()
                    && last.kind == kind
                    && last.range.end == span.range.start
                {
                    last.range.end = span.range.end;
                } else {
                    merged.push(HighlightSpan { range: span.range, kind });
                }
            }
            merged
        })
        .collect()
}

/// Splits `text` into lines with their highlight spans (blocking; run off
/// the UI thread).
pub fn prepare(text: &str, language: Option<&Language>) -> Vec<Line> {
    let spans = language.map(|l| highlight_lines(text, l)).unwrap_or_default();
    let mut spans = spans.into_iter();
    text.lines()
        .map(|line| Line {
            text: line.to_string(),
            spans: spans.next().unwrap_or_default(),
        })
        .collect()
}

/// Highlight ranges clipped to the line and to char boundaries.
pub fn clip_spans(text: &str, spans: &[HighlightSpan]) -> Vec<(Range<usize>, vibevalley_files::HighlightKind)> {
    spans
        .iter()
        .filter_map(|s| {
            let end = s.range.end.min(text.len());
            let start = s.range.start.min(end);
            (start < end && text.is_char_boundary(start) && text.is_char_boundary(end)).then_some((start..end, s.kind))
        })
        .collect()
}

impl FileViewer {
    pub fn new(path: PathBuf, cx: &mut Context<Self>) -> Self {
        let mut viewer = FileViewer {
            path,
            state: State::Loading,
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            pending_line: None,
            reloads: 0,
            load_gen: 0,
            show_skeleton: false,
        };
        viewer.reload(cx);
        viewer
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> String {
        match &self.state {
            State::Loading => "loading".into(),
            State::Text { lines, language } => {
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
        let task = cx.background_spawn(async move {
            match vibevalley_files::load_file(&path, MAX_BYTES) {
                Ok(FileContent::Text { text, language }) => {
                    let lines = prepare(&text, language.as_ref());
                    State::Text {
                        lines: Arc::new(lines),
                        language,
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
        match self.state {
            State::Text { .. } => self.scroll.scroll_to_item(line.saturating_sub(1) as usize, ScrollStrategy::Center),
            _ => self.pending_line = Some(line),
        }
        cx.notify();
    }

    fn is_markdown(&self) -> bool {
        matches!(&self.state, State::Text { language: Some(l), .. } if l.0 == "markdown") || self.path.extension().is_some_and(|e| e == "md" || e == "markdown")
    }
}

impl EventEmitter<ViewerEvent> for FileViewer {}

impl Focusable for FileViewer {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

fn transparent() -> Hsla {
    hsla(0.0, 0.0, 0.0, 0.0)
}

fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

fn split_display_path(path: &Path) -> (String, Option<String>) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| match &home {
        Some(h) if p == h => "~".to_string(),
        Some(h) => match p.strip_prefix(h) {
            Ok(rel) => format!("~/{}", rel.display()),
            Err(_) => p.to_string_lossy().into_owned(),
        },
        None => p.to_string_lossy().into_owned(),
    });
    (name, parent)
}

#[derive(Clone, Copy)]
enum ButtonTone {
    Quiet,
    Plain,
    Accent,
}

fn action_button(id: &'static str, label: &'static str, tone: ButtonTone, colors: &Palette) -> gpui::Stateful<gpui::Div> {
    let hover = colors.hover;
    let text = colors.text;
    let base = div()
        .id(id)
        .h(px(24.0))
        .px(px(8.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.0))
        .border_1()
        .cursor_pointer()
        .text_size(px(11.5))
        .font_weight(FontWeight::MEDIUM)
        .child(label);
    match tone {
        ButtonTone::Quiet => base
            .bg(transparent())
            .border_color(transparent())
            .text_color(colors.muted)
            .hover(move |s| s.bg(hover).text_color(text)),
        ButtonTone::Plain => base
            .bg(colors.elevated)
            .border_color(colors.border)
            .text_color(colors.text)
            .hover(move |s| s.bg(hover)),
        ButtonTone::Accent => base
            .bg(colors.selected)
            .border_color(Hsla { a: 0.35, ..colors.accent })
            .text_color(colors.accent)
            .hover(move |s| s.bg(hover)),
    }
}

fn file_skeleton(line_height: f32, colors: &Palette) -> AnyElement {
    const ROWS: &[(f32, f32)] = &[
        (0.0, 220.0),
        (0.0, 310.0),
        (16.0, 260.0),
        (16.0, 190.0),
        (32.0, 340.0),
        (32.0, 240.0),
        (16.0, 150.0),
        (0.0, 90.0),
        (0.0, 280.0),
        (16.0, 320.0),
        (16.0, 210.0),
        (0.0, 130.0),
    ];
    let mut rows = div().size_full().flex().flex_col().py(px(8.0));
    for (i, &(indent, width)) in ROWS.iter().enumerate() {
        let bar_bg = if i % 3 == 0 { colors.hover } else { colors.surface };
        rows = rows.child(
            div()
                .h(px(line_height))
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .child(
                    div()
                        .w(px(52.0))
                        .h_full()
                        .flex_none()
                        .pr(px(12.0))
                        .flex()
                        .items_center()
                        .justify_end()
                        .bg(colors.surface)
                        .border_r_1()
                        .border_color(colors.border)
                        .child(div().w(px(18.0)).h(px(8.0)).rounded(px(4.0)).bg(colors.hover)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .pl(px(14.0 + indent))
                        .flex()
                        .items_center()
                        .child(div().w(px(width)).max_w_full().h(px(10.0)).rounded(px(4.0)).bg(bar_bg)),
                ),
        );
    }
    rows.into_any_element()
}

fn state_card(title: &'static str, detail: String, hint: Option<&'static str>, danger: bool, colors: &Palette) -> AnyElement {
    let (bg, border, title_color) = if danger {
        (colors.removed_bg, Hsla { a: 0.35, ..colors.danger }, colors.danger)
    } else {
        (colors.surface, colors.border, colors.text)
    };
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(
            div()
                .max_w(px(440.0))
                .px(px(20.0))
                .py(px(16.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(border)
                .bg(bg)
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.0))
                .child(div().text_size(px(13.0)).font_weight(FontWeight::SEMIBOLD).text_color(title_color).child(title))
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(if danger { colors.text } else { colors.muted })
                        .child(detail),
                )
                .children(hint.map(|h| div().pt(px(2.0)).text_size(px(11.5)).text_color(colors.faint).child(h))),
        )
        .into_any_element()
}

impl Render for FileViewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let mono = ui.mono();
        let font_size = ui.settings.terminal_font_size;
        let line_height = (font_size * 1.65).round().max(21.0);
        let (file_name, parent_dir) = split_display_path(&self.path);
        let (lang_badge, meta_text) = match &self.state {
            State::Text { lines, language } => {
                let count = if lines.len() == 1 {
                    "1 line".to_string()
                } else {
                    format!("{} lines", lines.len())
                };
                (language.as_ref().map(|l| l.0.clone()), Some(count))
            }
            State::Image => (Some("image".to_string()), None),
            State::Binary(size) | State::TooLarge(size) => (None, Some(format_bytes(*size))),
            State::Loading | State::Error(_) => (None, None),
        };
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
            .children(lang_badge.map(|lang| {
                div()
                    .flex_none()
                    .h(px(20.0))
                    .px(px(6.0))
                    .flex()
                    .items_center()
                    .rounded(px(4.0))
                    .bg(colors.hover)
                    .text_size(px(11.0))
                    .text_color(colors.muted)
                    .child(lang)
            }))
            .children(meta_text.map(|meta| {
                div()
                    .flex_none()
                    .font_family(mono.clone())
                    .text_size(px(11.5))
                    .text_color(colors.faint)
                    .child(meta)
            }))
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .children(self.is_markdown().then(|| {
                        action_button("preview", "Preview", ButtonTone::Accent, &colors).on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::Preview)))
                    }))
                    .child(
                        action_button("copy-path", "Copy path", ButtonTone::Quiet, &colors).on_click(cx.listener(|v, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(v.path.to_string_lossy().into_owned()));
                        })),
                    )
                    .child(action_button("reload", "Reload", ButtonTone::Quiet, &colors).on_click(cx.listener(|v, _, _, cx| v.reload(cx))))
                    .child(action_button("reveal", "Reveal", ButtonTone::Quiet, &colors).on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::Reveal))))
                    .child(
                        action_button("editor", "Open in $EDITOR", ButtonTone::Plain, &colors)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::OpenInEditor))),
                    ),
            );
        let body = match &self.state {
            State::Loading if self.show_skeleton => file_skeleton(line_height, &colors),
            State::Loading => div().size_full().into_any_element(),
            State::Error(e) => state_card("Could not open file", e.clone(), None, true, &colors),
            State::Binary(size) => state_card(
                "Binary file",
                format!("{} ({size} bytes) — preview is not available.", format_bytes(*size)),
                Some("Use Open in $EDITOR or Reveal to inspect it externally."),
                false,
                &colors,
            ),
            State::TooLarge(size) => state_card(
                "File too large to preview",
                format!("{} exceeds the {} viewer limit.", format_bytes(*size), format_bytes(MAX_BYTES)),
                Some("Open it in $EDITOR to view the full file."),
                false,
                &colors,
            ),
            State::Image => div()
                .size_full()
                .p(px(20.0))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .size_full()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(colors.border)
                        .bg(colors.surface)
                        .p(px(16.0))
                        .child(img(self.path.clone()).size_full().object_fit(ObjectFit::Contain)),
                )
                .into_any_element(),
            State::Text { lines, .. } if lines.is_empty() => state_card("Empty file", "This file has no content yet.".into(), None, false, &colors),
            State::Text { lines, .. } => {
                let lines = lines.clone();
                let digits = lines.len().max(1).to_string().len().max(3);
                let gutter = (digits as f32 * font_size * 0.64 + 24.0).ceil().max(48.0);
                let colors = colors.clone();
                uniform_list("lines", lines.len(), move |range, _, cx| {
                    let ui = Ui::get(cx);
                    let row_hover = colors.hover;
                    range
                        .map(|i| {
                            let line = &lines[i];
                            let highlights = clip_spans(&line.text, &line.spans).into_iter().map(|(r, kind)| {
                                let mut style = HighlightStyle {
                                    color: Some(ui.colors.syntax(kind)),
                                    ..Default::default()
                                };
                                if kind == vibevalley_files::HighlightKind::Heading {
                                    style.font_weight = Some(FontWeight::BOLD);
                                }
                                (r, style)
                            });
                            div()
                                .h(px(line_height))
                                .w_full()
                                .flex()
                                .flex_row()
                                .items_center()
                                .hover(move |s| s.bg(row_hover))
                                .child(
                                    div()
                                        .w(px(gutter))
                                        .h_full()
                                        .flex_none()
                                        .pr(px(12.0))
                                        .flex()
                                        .items_center()
                                        .justify_end()
                                        .bg(colors.surface)
                                        .border_r_1()
                                        .border_color(colors.border)
                                        .text_color(colors.faint)
                                        .child((i + 1).to_string()),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .h_full()
                                        .flex()
                                        .items_center()
                                        .pl(px(14.0))
                                        .pr(px(16.0))
                                        .whitespace_nowrap()
                                        .text_color(colors.text)
                                        .child(StyledText::new(line.text.replace('\t', "    ")).with_highlights(if line.text.contains('\t') {
                                            Vec::new()
                                        } else {
                                            highlights.collect()
                                        })),
                                )
                        })
                        .collect()
                })
                .track_scroll(&self.scroll)
                .size_full()
                .font_family(mono)
                .text_size(px(font_size))
                .into_any_element()
            }
        };
        div()
            .id("viewer")
            .track_focus(&self.focus)
            .key_context("FileViewer")
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.bg)
            .child(toolbar)
            .child(div().flex_1().min_h_0().child(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_files::HighlightKind;

    #[test]
    fn spans_are_clipped_to_line_and_char_boundaries() {
        let spans = vec![
            HighlightSpan {
                range: 0..2,
                kind: HighlightKind::Keyword,
            },
            HighlightSpan {
                range: 3..4,
                kind: HighlightKind::String,
            },
            HighlightSpan {
                range: 5..99,
                kind: HighlightKind::Comment,
            },
        ];
        // "é" is two bytes (3..5), so 3..4 is not a boundary.
        let clipped = clip_spans("fn é xy", &spans);
        assert_eq!(clipped, vec![(0..2, HighlightKind::Keyword), (5..8, HighlightKind::Comment)]);
    }

    #[test]
    fn prepare_pairs_lines_with_spans() {
        let lines = prepare("a\nb\n", None);
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.spans.is_empty()));
        let lang = Language("rust".into());
        let lines = prepare("fn main() {}\n// hi", Some(&lang));
        assert_eq!(lines.len(), 2);
        assert!(!lines[0].spans.is_empty(), "rust is highlighted");
    }

    #[test]
    fn formats_byte_sizes_human_readably() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(8 * 1024 * 1024), "8.0 MB");
    }

    #[test]
    fn splits_file_name_from_parent_directory() {
        let (name, dir) = split_display_path(Path::new("/tmp/project/src/viewer.rs"));
        assert_eq!(name, "viewer.rs");
        assert_eq!(dir.as_deref(), Some("/tmp/project/src"));
    }

    #[test]
    fn prepare_highlights_every_supported_language() {
        for &name in vibevalley_files::SUPPORTED {
            let sample = match name {
                "rust" => "pub fn greet() -> i32 { 42 }",
                "typescript" | "javascript" => "export const count: number = 1;",
                "tsx" => "export const App = () => <View>hi</View>;",
                "json" => "{\"key\": \"value\", \"ok\": true}",
                "toml" => "[package]\nname = \"vibevalley\"",
                "yaml" => "name: vibevalley\nenabled: true",
                "markdown" => "# Title\n**bold** [site](https://example.com)",
                "python" => "def greet(name):\n    return f\"hi {name}\"",
                "go" => "package main\nfunc main() { return }",
                "bash" => "# comment\nif [ -f Cargo.toml ]; then echo \"ok\"; fi",
                "html" => "<div class=\"card\">hello</div>",
                "css" => ".card { color: #ff00aa; padding: 8px; }",
                "c" | "cpp" => "#include <stdio.h>\nint main() { return 0; }",
                "zig" => "const std = @import(\"std\");\npub fn main() void {}",
                "swift" => "struct Farm { let acres: Int = 4 }",
                other => panic!("unhandled supported language in test: {other}"),
            };
            let lang = Language(name.to_string());
            let lines = prepare(sample, Some(&lang));
            assert!(
                lines.iter().any(|l| !l.spans.is_empty()),
                "supported language `{name}` produced no highlight spans for sample"
            );
        }
    }

    #[test]
    fn prepare_propagates_multiline_state_and_markdown_kinds() {
        let rust = Language("rust".into());
        let lines = prepare("/* line 1\nline 2 */\nfn main() {}", Some(&rust));
        assert_eq!(lines.len(), 3);
        assert!(lines[1].spans.iter().any(|s| s.kind == HighlightKind::Comment));
        assert!(lines[2].spans.iter().any(|s| s.kind == HighlightKind::Keyword && s.range == (0..2)));

        let md = Language("markdown".into());
        let md_lines = prepare("# Title\n**bold** [site](https://example.com)", Some(&md));
        assert!(md_lines[0].spans.iter().any(|s| s.kind == HighlightKind::Heading));
        assert!(md_lines[1].spans.iter().any(|s| s.kind == HighlightKind::Emphasis));
        assert!(md_lines[1].spans.iter().any(|s| s.kind == HighlightKind::Link));
    }
}
