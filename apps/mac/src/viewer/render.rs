use gpui::{
    AnyElement, Context, FontWeight, HighlightStyle, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ObjectFit, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, StyledImage as _, StyledText, Window, div, hsla, img, px, uniform_list,
};

use crate::host::EditorTarget;
use crate::icon::{editor_popover, gpui_icon, icon_button, icon_caret_button};
use crate::theme::{Palette, Ui};

use super::highlight::clip_spans;
use super::toolbar::{format_bytes, html_mode_labels, split_display_path};
use super::view::{FileViewer, ViewerEvent};
use super::{HtmlViewMode, MAX_BYTES, State};

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

fn state_card_action(id: &'static str, icon_name: &'static str, label: &'static str, primary: bool, colors: &Palette) -> gpui::Stateful<gpui::Div> {
    let hover = colors.hover;
    let base = div()
        .id(id)
        .h(px(28.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .border_1()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .text_size(px(12.0))
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer();
    if primary {
        base.border_color(colors.accent)
            .bg(colors.accent)
            .text_color(colors.bg)
            .hover(|s| s.opacity(0.9))
            .child(gpui_icon(icon_name, 13.0, colors.bg))
            .child(label)
    } else {
        base.border_color(colors.border)
            .bg(colors.bg)
            .text_color(colors.text)
            .hover(move |s| s.bg(hover))
            .child(gpui_icon(icon_name, 13.0, colors.muted))
            .child(label)
    }
}

fn state_card(title: &'static str, detail: String, hint: Option<&'static str>, danger: bool, actions: Vec<AnyElement>, colors: &Palette) -> AnyElement {
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
                .children(hint.map(|h| div().pt(px(2.0)).text_size(px(11.5)).text_color(colors.faint).child(h)))
                .children((!actions.is_empty()).then(|| div().pt(px(8.0)).flex().flex_row().items_center().gap(px(8.0)).children(actions))),
        )
        .into_any_element()
}

fn html_mode_toggle(mode: HtmlViewMode, colors: &Palette, cx: &mut Context<FileViewer>) -> AnyElement {
    let (preview_label, source_label) = html_mode_labels();
    let hover = colors.hover;
    let text = colors.text;
    let pill = |id: &'static str, label: String, active: bool, next: HtmlViewMode, cx: &mut Context<FileViewer>| {
        let base = div()
            .id(id)
            .h(px(18.0))
            .px(px(8.0))
            .rounded(px(4.0))
            .border_1()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(11.0))
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .child(label)
            .on_click(cx.listener(move |v, _, _, cx| v.set_html_mode(next, cx)));
        if active {
            base.bg(colors.elevated).border_color(colors.border).text_color(colors.text)
        } else {
            base.border_color(hsla(0.0, 0.0, 0.0, 0.0))
                .text_color(colors.muted)
                .hover(move |s| s.bg(hover).text_color(text))
        }
    };
    div()
        .id("viewer-html-mode")
        .flex_none()
        .h(px(24.0))
        .p(px(2.0))
        .mr(px(4.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(colors.border)
        .bg(colors.surface)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .child(pill(
            "viewer-html-mode-preview",
            preview_label,
            mode == HtmlViewMode::Preview,
            HtmlViewMode::Preview,
            cx,
        ))
        .child(pill(
            "viewer-html-mode-source",
            source_label,
            mode == HtmlViewMode::Source,
            HtmlViewMode::Source,
            cx,
        ))
        .into_any_element()
}

impl Render for FileViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let mono = ui.mono();
        let font_size = ui.settings.terminal_font_size;
        let line_height = (font_size * 1.65).round().max(21.0);
        let (file_name, parent_dir) = split_display_path(&self.path);
        let (lang_badge, meta_text) = match &self.state {
            State::Text { lines, language, .. } => {
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
        let is_html = self.is_html();
        let html_preview_doc = if is_html && self.html_mode == HtmlViewMode::Preview {
            match &self.state {
                State::Text {
                    lines, html_doc: Some(html), ..
                } if !lines.is_empty() => Some(html.clone()),
                _ => None,
            }
        } else {
            None
        };
        if let Some(html) = html_preview_doc {
            self.ensure_html_preview(html, window, cx);
        }
        let show_html_toggle = is_html && !matches!(self.state, State::Binary(_) | State::TooLarge(_) | State::Error(_));
        let menu_open = self.toolbar.editor_menu_open;
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
                    .gap(px(3.0))
                    .children(show_html_toggle.then(|| html_mode_toggle(self.html_mode, &colors, cx)))
                    .children(self.is_markdown().then(|| {
                        icon_button("preview", "show", "Preview Markdown", false, &colors).on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::Preview)))
                    }))
                    .child(
                        icon_button(
                            "copy-path",
                            if self.toolbar.copied { "check" } else { "copy" },
                            if self.toolbar.copied { "Copied" } else { "Copy path" },
                            false,
                            &colors,
                        )
                        .on_click(cx.listener(|v, _, _, cx| v.copy_path(cx))),
                    )
                    .child(icon_button("reload", "refresh", "Reload", false, &colors).on_click(cx.listener(|v, _, _, cx| v.reload(cx))))
                    .child(
                        icon_button("reveal", "folder", "Reveal in Finder", false, &colors).on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::Reveal))),
                    )
                    .child(icon_caret_button("editor", "open", "Open in editor…", menu_open, &colors).on_mouse_down(
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
                "viewer-editor-menu",
                &self.toolbar.editor_options,
                &colors,
                move |target, _, cx| {
                    select_entity.update(cx, |v, cx| {
                        v.set_editor_menu_open(false, cx);
                        cx.emit(ViewerEvent::OpenInEditor(target));
                    });
                },
                move |_, cx| {
                    dismiss_entity.update(cx, |v, cx| {
                        v.set_editor_menu_open(false, cx);
                    });
                },
            )
        });
        let fallback_actions = |cx: &mut Context<Self>| -> Vec<AnyElement> {
            vec![
                state_card_action("viewer-open-default", "open", "Open with Default App", true, &colors)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::OpenInEditor(EditorTarget::DefaultApp))))
                    .into_any_element(),
                state_card_action("viewer-reveal-finder", "folder", "Reveal in Finder", false, &colors)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(ViewerEvent::Reveal)))
                    .into_any_element(),
            ]
        };
        let body = match &self.state {
            State::Loading if self.show_skeleton => file_skeleton(line_height, &colors),
            State::Loading => div().size_full().into_any_element(),
            State::Error(e) => state_card("Could not open file", e.clone(), None, true, Vec::new(), &colors),
            State::Binary(size) => state_card(
                "Binary file",
                format!("{} ({size} bytes) — preview is not available.", format_bytes(*size)),
                Some("Use Open with Default App or Reveal in Finder to inspect it externally."),
                false,
                fallback_actions(cx),
                &colors,
            ),
            State::TooLarge(size) => state_card(
                "File too large to preview",
                format!("{} exceeds the {} viewer limit.", format_bytes(*size), format_bytes(MAX_BYTES)),
                Some("Use Open with Default App or Open in editor to view the full file."),
                false,
                fallback_actions(cx),
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
            State::Text { lines, .. } if lines.is_empty() => state_card("Empty file", "This file has no content yet.".into(), None, false, Vec::new(), &colors),
            State::Text { .. } if is_html && self.html_mode == HtmlViewMode::Preview => {
                if let Some(err) = &self.html_preview_error {
                    state_card(
                        "Could not render HTML preview",
                        err.clone(),
                        Some("Switch to Source mode to inspect the raw file."),
                        true,
                        Vec::new(),
                        &colors,
                    )
                } else if let Some(app) = &self.html_preview {
                    app.clone().into_any_element()
                } else {
                    div().size_full().into_any_element()
                }
            }
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
            .relative()
            .track_focus(&self.focus)
            .key_context("FileViewer")
            .on_key_down(cx.listener(|v, event: &KeyDownEvent, _, cx| {
                if v.toolbar.editor_menu_open && event.keystroke.key == "escape" {
                    v.set_editor_menu_open(false, cx);
                    cx.stop_propagation();
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
