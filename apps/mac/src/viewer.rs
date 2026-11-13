//! The read-only file viewer: highlighted text painted by GPUI, images,
//! and placeholders for binary or oversized files. Markdown files offer a
//! rendered preview (a hosted view) and every file can open in `$EDITOR`.

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::{
    AppContext as _, Context, EventEmitter, FocusHandle, Focusable, FontWeight, HighlightStyle, InteractiveElement as _, IntoElement, ObjectFit,
    ParentElement as _, Render, ScrollStrategy, StatefulInteractiveElement as _, Styled as _, StyledImage as _, StyledText, UniformListScrollHandle, Window,
    div, img, px, uniform_list,
};
use vibevalley_files::{FileContent, HighlightSpan, Language};

use crate::theme::Ui;

const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub enum ViewerEvent {
    OpenInEditor,
    Preview,
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
}

/// Splits `text` into lines with their highlight spans (blocking; run off
/// the UI thread).
pub fn prepare(text: &str, language: Option<&Language>) -> Vec<Line> {
    let spans = language.map(|l| vibevalley_files::highlight(text, l)).unwrap_or_default();
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
                v.state = state;
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
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}

fn button(id: &'static str, label: &'static str, colors: &crate::theme::Palette) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(22.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .rounded(px(6.0))
        .border_1()
        .border_color(colors.border)
        .text_size(px(12.0))
        .text_color(colors.text)
        .hover(|s| s.bg(colors.hover))
        .child(label)
}

impl Render for FileViewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let mono = ui.mono();
        let font_size = ui.settings.terminal_font_size;
        let line_height = (font_size * 1.5).round();
        let toolbar = div()
            .h(px(30.0))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(10.0))
            .border_b_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(12.0))
                    .text_color(colors.muted)
                    .child(self.path.to_string_lossy().into_owned()),
            )
            .children(
                self.is_markdown()
                    .then(|| button("preview", "Preview", &colors).on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::Preview)))),
            )
            .child(button("reload", "Reload", &colors).on_click(cx.listener(|v, _, _, cx| v.reload(cx))))
            .child(button("editor", "Open in $EDITOR", &colors).on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::OpenInEditor))));
        let message = |text: String| {
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(colors.muted)
                .text_size(px(13.0))
                .child(text)
        };
        let body = match &self.state {
            State::Loading => message("Loading…".into()).into_any_element(),
            State::Error(e) => message(format!("Could not open this file: {e}")).into_any_element(),
            State::Binary(size) => message(format!("Binary file, {size} bytes. Not shown.")).into_any_element(),
            State::TooLarge(size) => message(format!("This file is {size} bytes, too large to show.")).into_any_element(),
            State::Image => div()
                .size_full()
                .p(px(16.0))
                .child(img(self.path.clone()).size_full().object_fit(ObjectFit::Contain))
                .into_any_element(),
            State::Text { lines, .. } if lines.is_empty() => message("This file is empty.".into()).into_any_element(),
            State::Text { lines, .. } => {
                let lines = lines.clone();
                let gutter = (lines.len().to_string().len() as f32 * font_size * 0.62 + 16.0).ceil();
                let colors = colors.clone();
                uniform_list("lines", lines.len(), move |range, _, cx| {
                    let ui = Ui::get(cx);
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
                                .flex()
                                .flex_row()
                                .child(
                                    div()
                                        .w(px(gutter))
                                        .flex_none()
                                        .pr(px(10.0))
                                        .flex()
                                        .justify_end()
                                        .text_color(colors.faint)
                                        .child((i + 1).to_string()),
                                )
                                .child(div().whitespace_nowrap().text_color(colors.text).child(
                                    StyledText::new(line.text.replace('\t', "    ")).with_highlights(if line.text.contains('\t') {
                                        Vec::new()
                                    } else {
                                        highlights.collect()
                                    }),
                                ))
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
}
