#![forbid(unsafe_code)]
//! Native Rust rich UI set (`"vibevalley/rich"`) for `apps/mac` on stock `nsh 0.6.0`.
//!
//! Mount alongside `nsh_base::registry()` via:
//! ```text
//! nsh_platform_gpui::set_ui_sets(vec![nsh_base::registry(), crate::registry()]);
//! ```
//!
//! Provides:
//! - Automatic `.setup(register_shiki_editor_highlighters)` installing pure-Rust `vibevalley-shiki`
//!   (`vibevalley-onig`) highlighters into `nsh_base::editor` (`<Editor>` and `<DiffView>`),
//!   working with `nsh-base/highlight` (`syntect`/`two-face`/`onig_sys`) disabled.
//! - Native `#[component]`s: [`VvMarkdown`], [`VvCodeBlock`], [`VvDiagram`], [`VvCanvas`],
//!   [`VvChart`] (backed by `vibevalley-chart`), [`VvGenUi`] (backed by `vibevalley-genui`),
//!   [`VvIcon`] (static reicon vector registry), and [`VvWhiteboard`].
//! - Optional [`ChartRenderer`] and [`GenUiRenderer`] override traits for custom host or test hooks.

pub mod cache;
pub mod canvas;
pub mod chart;
pub mod code_block;
pub mod diagram;
pub mod engine;
pub mod genui;
pub mod grammars;
pub mod highlight;
pub mod hooks;
pub mod i18n;
pub mod icon;
pub mod markdown;
mod math;
pub mod pinyin;
pub mod theme;
pub mod whiteboard;

use nsh_core::element::Registry;

pub use cache::CacheStats;
pub use canvas::{
    CanvasRenderError, RenderedCanvas, VvCanvas, VvCanvasElement, VvCanvasProps, canvas_cache_stats, clear_canvas_cache, render_canvas, vv_canvas,
};
pub use chart::{VvChart, VvChartElement, VvChartProps, chart_cache_stats, clear_chart_cache, render_chart, vv_chart};
pub use code_block::{
    ASYNC_HIGHLIGHT_BYTE_THRESHOLD, ASYNC_HIGHLIGHT_LINE_THRESHOLD, CODE_LINE_HEIGHT, DEFAULT_FOLD_LINES, VvCodeBlock, VvCodeBlockElement, VvCodeBlockEvent,
    VvCodeBlockProps, VvCodeCopyEvent, count_code_lines, should_offload_highlight, vv_code_block,
};
pub use diagram::{
    DiagramError, RenderedDiagram, VvDiagram, VvDiagramElement, VvDiagramProps, clear_diagram_cache, diagram_cache_stats, render_diagram,
    render_diagram_with_max_width, vv_diagram,
};
pub use genui::{VvGenUi, VvGenUiActionEvent, VvGenUiElement, VvGenUiEvent, VvGenUiProps, vv_gen_ui};
pub use grammars::{BUNDLED_GRAMMARS, BundledGrammar, MERMAID_LANGUAGE};
pub use highlight::{
    CodeSpan, HighlightedCode, HighlightedLine, ScopedSpan, ShikiEditorHighlighter, cached_highlight_code, clear_code_highlight_cache,
    code_highlight_cache_stats, editor_token_from_scopes, highlight_code, loaded_languages, register_grammar_json, register_raw_grammar, register_raw_theme,
    register_shiki_editor_highlighters, register_theme_json, tokenize_scopes,
};
pub use hooks::{
    ChartRenderer, ChartRendererContext, GenUiAction, GenUiActionSink, GenUiRenderer, GenUiRendererContext, RenderedSvg, active_chart_renderer,
    active_genui_renderer, clear_chart_renderer, clear_genui_renderer, register_chart_renderer, register_genui_renderer,
};
pub use i18n::{VvI18n, translate_json};
pub use icon::{DEFAULT_ICON_SIZE, ICON_NAMES, IconShape, VvIcon, VvIconElement, VvIconProps, icon_shapes, paint_icon, resolve_icon_color, vv_icon};
pub use markdown::{
    BlockRefPayload, CustomNodeKind, PATTERN_BLOCK_REF, PATTERN_EMBED, PATTERN_ISSUE, PATTERN_MENTION, PATTERN_REMARK, PATTERN_TAG, PATTERN_WIKILINK,
    VvBlockRefPressEvent, VvEmbedPressEvent, VvIssuePressEvent, VvLinkPressEvent, VvMarkdown, VvMarkdownElement, VvMarkdownEvent, VvMarkdownProps,
    VvMarkdownSize, VvMentionPressEvent, VvTaskPressEvent, VvWikilinkPressEvent, clean_remark_note, is_incremental_streaming_safe, parse_vv_markdown,
    parse_wikilink_target, vv_markdown, vv_markdown_extensions, vv_markdown_options,
};
pub use pinyin::VvPinyin;
pub use theme::{
    AdaptiveUi, CODE_FONT_MONO, DIAGRAM_FONT_SANS, SHIKI_DARK_THEME, SHIKI_LIGHT_THEME, UiPalette, vv_canvas_palette, vv_chart_palette, vv_pele_palette,
    vv_shiki_dark_theme, vv_shiki_light_theme,
};
pub use whiteboard::{
    VvWhiteboard, VvWhiteboardBatchEvent, VvWhiteboardChatEvent, VvWhiteboardCursorEvent, VvWhiteboardElement, VvWhiteboardEvent, VvWhiteboardExportEvent,
    VvWhiteboardProps, VvWhiteboardSelectionEvent, VvWhiteboardViewportEvent, vv_whiteboard,
};

/// JS module specifier passed to `nativeModule("vibevalley/rich")` and `Registry::ui_set`.
pub const SPECIFIER: &str = "vibevalley/rich";

/// Builds the `vibevalley/rich` UI set registry for `nsh_platform_gpui::set_ui_sets`.
///
/// Registers pure-Rust Shiki editor highlighters in `.setup(...)` and exports all native
/// VibeValley rich-content components.
pub fn registry() -> Registry {
    let mut set = Registry::ui_set(SPECIFIER);
    set.setup(register_shiki_editor_highlighters);
    set.register::<VvMarkdown>()
        .register::<VvCodeBlock>()
        .register::<VvDiagram>()
        .register::<VvCanvas>()
        .register::<VvChart>()
        .register::<VvGenUi>()
        .register::<VvIcon>()
        .register::<VvWhiteboard>()
        .module::<VvI18n>()
        .module::<VvPinyin>();
    set
}
