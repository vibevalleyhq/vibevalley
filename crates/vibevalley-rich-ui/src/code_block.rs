//! Native `VvCodeBlock` component powered by pure-Rust `vibevalley-shiki` + `vibevalley-onig`.
//!
//! Replaces spawning a read-only `<Editor>` per fenced code block:
//! - Renders styled `nsh_core::element::text` spans reacting to `dark()`.
//! - Shows a language/line-count header, copy action with clipboard write & feedback, and 16-line fold.
//! - Tokenizes small blocks (and LRU cache hits) inline and offloads large blocks to
//!   `nsh_core::prelude::blocking` + `Signal` with instant plain-text first paint.

use std::time::Duration;

use nsh_core::prelude::*;
use vibevalley_i18n::t;

use crate::highlight::{HighlightedCode, cached_highlight_code, highlight_code};
use crate::theme::{AdaptiveUi, CODE_FONT_MONO, UiPalette, shiki_rgba_to_hsla};

/// Default line threshold above which `VvCodeBlock` starts collapsed (matches `CodeBlock.tsx`).
pub const DEFAULT_FOLD_LINES: u32 = 16;
/// Line height in points for code block text (16 * 18 = 288pt collapsed height).
pub const CODE_LINE_HEIGHT: f32 = 18.0;
/// Code blocks above this byte size offload tokenization via `nsh_core::prelude::blocking`.
pub const ASYNC_HIGHLIGHT_BYTE_THRESHOLD: usize = 4_096;
/// Code blocks above this line count offload tokenization via `nsh_core::prelude::blocking`.
pub const ASYNC_HIGHLIGHT_LINE_THRESHOLD: usize = 120;

/// Props of [`VvCodeBlock`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvCodeBlockProps {
    /// Raw source code to display.
    pub code: Prop<SharedString>,
    /// Optional language identifier (e.g. `"rust"`, `"tsx"`, `"json"`).
    pub language: Prop<Option<SharedString>>,
    /// Collapse blocks taller than this many lines (default 16; 0 disables folding).
    #[prop(default = DEFAULT_FOLD_LINES)]
    pub fold_lines: Prop<u32>,
    /// Allow text selection across the code block (default true).
    #[prop(default = true)]
    pub selectable: Prop<bool>,
    /// Wrap long lines instead of scrolling horizontally (default false).
    #[prop(default)]
    pub wrap: Prop<bool>,
}

/// Payload emitted when a user copies a code block.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvCodeCopyEvent {
    /// Copied code text.
    pub code: SharedString,
    /// Language of the code block, if specified.
    pub language: Option<SharedString>,
}

/// Events emitted by [`VvCodeBlock`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvCodeBlockEvent {
    /// Fired after writing the code block's source text to the system clipboard.
    #[args(event)]
    Copy(VvCodeCopyEvent),
}

/// Counts display lines in `code` (matching `code.split("\n").length` in `CodeBlock.tsx`).
pub fn count_code_lines(code: &str) -> usize {
    code.bytes().filter(|&b| b == b'\n').count() + 1
}

/// Returns whether a code block should offload syntax highlighting onto a blocking thread.
pub fn should_offload_highlight(code: &str) -> bool {
    code.len() >= ASYNC_HIGHLIGHT_BYTE_THRESHOLD || count_code_lines(code) >= ASYNC_HIGHLIGHT_LINE_THRESHOLD
}

/// Builds styled `nsh_core::element::text` span elements from a [`HighlightedCode`] result.
pub(crate) fn render_highlighted_spans(highlighted: &HighlightedCode) -> Vec<AnyElement> {
    let mut out = Vec::new();
    let line_count = highlighted.lines.len();
    for (line_idx, line) in highlighted.lines.iter().enumerate() {
        let mut cursor = 0usize;
        for span in &line.spans {
            if span.range.start < cursor || span.range.end > line.text.len() || span.range.start >= span.range.end {
                continue;
            }
            if span.range.start > cursor {
                out.push(text(line.text[cursor..span.range.start].to_owned()).into_element());
            }
            let mut el = text(line.text[span.range.clone()].to_owned());
            if let Some(fg) = span.fg {
                el = el.text_color(shiki_rgba_to_hsla(fg));
            }
            if let Some(bg) = span.bg {
                el = el.bg(shiki_rgba_to_hsla(bg));
            }
            if span.font_style.is_italic() {
                el = el.italic();
            }
            if span.font_style.is_bold() {
                el = el.font_weight(FontWeight::BOLD);
            }
            if span.font_style.is_underline() {
                el = el.underline();
            }
            if span.font_style.is_strikethrough() {
                el = el.line_through();
            }
            out.push(el.into_element());
            cursor = span.range.end;
        }
        if cursor < line.text.len() {
            out.push(text(line.text[cursor..].to_owned()).into_element());
        }
        if line_idx + 1 < line_count {
            out.push(text("\n").into_element());
        }
    }
    out
}

/// Syntax-highlighted fenced code block rendered natively via `vibevalley-shiki` (`vibevalley-onig`).
///
/// Tracks the surface's light/dark appearance reactively, folds long blocks past `foldLines`
/// (default 16), copies to the clipboard with feedback, and offloads large blocks onto a worker
/// thread while showing plain text immediately.
#[component]
pub fn VvCodeBlock(props: VvCodeBlockProps, cx: Scope<VvCodeBlockEvent>) -> impl IntoElement {
    let folded = signal(true);
    let copied = signal(false);
    let copy_seq = signal(0u64);
    let async_result: Signal<Option<(u64, HighlightedCode)>> = signal(None);
    let generation = signal(0u64);

    // Kick off background tokenization when a large uncached block mounts or changes.
    effect(move || {
        let code = props.code.get();
        let lang = props.language.get();
        let is_dark = dark();

        let next_gen = generation.get_untracked().wrapping_add(1);
        generation.set(next_gen);

        if !should_offload_highlight(code.as_str()) || cached_highlight_code(code.as_str(), lang.as_deref(), is_dark).is_some() {
            async_result.set(None);
            return;
        }

        async_result.set(None);
        let code_owned = code.to_string();
        let lang_owned = lang.map(|s| s.to_string());
        spawn(async move {
            let highlighted = if tokio::runtime::Handle::try_current().is_ok() {
                match blocking(move || highlight_code(&code_owned, lang_owned.as_deref(), is_dark)).await {
                    Ok(res) => res,
                    Err(_) => return,
                }
            } else {
                highlight_code(&code_owned, lang_owned.as_deref(), is_dark)
            };
            if generation.get_untracked() == next_gen {
                async_result.set(Some((next_gen, highlighted)));
            }
        });
    });

    let header_label = move || {
        let lang = props.language.get();
        if let Some(name) = lang.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            SharedString::from(name.to_owned())
        } else {
            let lines = props.code.with(|c| count_code_lines(c.as_str()));
            SharedString::from(t("web.base.rich.lines", &[("n", lines.into())]))
        }
    };

    let is_long = move || {
        let limit = props.fold_lines.get() as usize;
        limit > 0 && props.code.with(|c| count_code_lines(c.as_str()) > limit)
    };

    let copy_button = view()
        .test_id("code-copy")
        .role(AccessibilityRole::Button)
        .label(move || {
            SharedString::from(if copied.get() {
                t("web.base.rich.copied", &[])
            } else {
                t("web.base.rich.copy", &[])
            })
        })
        .rounded_sm()
        .px(px(6.0))
        .py(px(2.0))
        .cursor_pointer()
        .hover(|s| s.bg(AdaptiveUi::HOVER))
        .on_press(move |_: &PressEvent| {
            let code = props.code.get_untracked();
            let language = props.language.get_untracked();
            set_clipboard(code.to_string());
            let seq = copy_seq.get_untracked().wrapping_add(1);
            copy_seq.set(seq);
            copied.set(true);
            cx.emit(VvCodeBlockEvent::Copy(VvCodeCopyEvent { code, language }));
            drop(set_timeout(Duration::from_millis(1500), move || {
                if copy_seq.get_untracked() == seq {
                    copied.set(false);
                }
            }));
        })
        .child(
            text(move || {
                SharedString::from(if copied.get() {
                    t("web.base.rich.copied", &[])
                } else {
                    t("web.base.rich.copy", &[])
                })
            })
            .text_size(px(11.0))
            .text_color(move || {
                let p = UiPalette::for_mode(dark());
                if copied.get() { p.ok_ink } else { p.muted }
            }),
        );

    let header = view()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .pt(px(6.0))
        .pr(px(6.0))
        .pl(px(12.0))
        .pb(px(2.0))
        .child(
            text(header_label)
                .flex_1()
                .font_family(CODE_FONT_MONO)
                .text_size(px(11.0))
                .text_color(AdaptiveUi::MUTED),
        )
        .child(copy_button);

    let body = dynamic(move || {
        let code = props.code.get();
        let lang = props.language.get();
        let is_dark = dark();
        let selectable = props.selectable.get();
        let wrap = props.wrap.get();
        let fold_limit = props.fold_lines.get();
        let collapsed = is_long() && folded.get();

        let highlighted = if should_offload_highlight(code.as_str()) {
            let current_gen = generation.get_untracked();
            async_result
                .with(|slot| match slot {
                    Some((gen_id, res)) if *gen_id == current_gen => Some(res.clone()),
                    Some(_) | None => None,
                })
                .or_else(|| cached_highlight_code(code.as_str(), lang.as_deref(), is_dark))
        } else {
            Some(highlight_code(code.as_str(), lang.as_deref(), is_dark))
        };

        let palette = UiPalette::for_mode(is_dark);
        let code_text = match highlighted {
            Some(res) if res.highlighted => {
                let base_fg = res.fg.map(shiki_rgba_to_hsla).unwrap_or(palette.code_ink);
                text("")
                    .font_family(CODE_FONT_MONO)
                    .text_size(px(12.0))
                    .line_height(px(CODE_LINE_HEIGHT))
                    .text_color(base_fg)
                    .when(selectable, |t| t.select_text())
                    .children(render_highlighted_spans(&res))
            }
            Some(_) | None => text(code)
                .font_family(CODE_FONT_MONO)
                .text_size(px(12.0))
                .line_height(px(CODE_LINE_HEIGHT))
                .text_color(palette.code_ink)
                .when(selectable, |t| t.select_text()),
        };

        let content: AnyElement = if wrap {
            code_text.into_element()
        } else {
            scroll().horizontal().child(code_text).into_element()
        };

        let mut container = view().px(px(12.0)).pb(px(10.0)).pt(px(4.0)).overflow_hidden();
        if collapsed {
            container = container.max_h(px(fold_limit as f32 * CODE_LINE_HEIGHT));
        }
        container.child(content)
    });

    let fold_footer = when(is_long, move || {
        view().flex_row().px(px(8.0)).pb(px(6.0)).child(
            view()
                .test_id("code-more")
                .role(AccessibilityRole::Button)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(!folded.get()),
                    ..AccessibilityState::default()
                })
                .rounded_sm()
                .px(px(6.0))
                .py(px(2.0))
                .cursor_pointer()
                .hover(|s| s.bg(AdaptiveUi::HOVER))
                .on_press(move |_: &PressEvent| folded.update(|f| *f = !*f))
                .child(
                    text(move || {
                        SharedString::from(if folded.get() {
                            t("web.base.rich.more", &[])
                        } else {
                            t("web.base.rich.less", &[])
                        })
                    })
                    .text_size(px(12.0))
                    .text_color(AdaptiveUi::MUTED),
                ),
        )
    });

    view()
        .test_id("code-block")
        .flex_col()
        .my(px(8.0))
        .rounded_md()
        .border_1()
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::CODE_SURFACE)
        .child(header)
        .child(body)
        .child(fold_footer)
}
