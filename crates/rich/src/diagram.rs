//! Native `VvDiagram` component rendering Mermaid diagrams via pure-Rust `vibevalley-pele`.
//!
//! Uses `ThemeMode::Resolved(vv_pele_palette(dark()))`, caches rendered SVGs in a bounded LRU
//! cache keyed by `(hash, source, max_width, dark)`, and displays them via
//! `image(ImageSrc::svg_markup(&svg).size(...))` so `nsh_core::svg::rasterize` preserves all
//! `<text>` labels at retina DPI (NEVER `element::svg`, which drops `<text>` nodes).

use std::sync::{Mutex, OnceLock};

use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;
use vibevalley_i18n::t;
use vibevalley_pele::{DiagramType, RenderOptions, ThemeMode};

use crate::cache::{CacheStats, LruCache, hash_str};
use crate::code_block::{CODE_LINE_HEIGHT, vv_code_block};
use crate::highlight::run_offloaded;
use crate::theme::{AdaptiveUi, CODE_FONT_MONO, DIAGRAM_FONT_SANS, vv_pele_palette};

/// Maximum number of rendered Mermaid SVGs retained in the LRU cache.
const DIAGRAM_CACHE_CAPACITY: usize = 64;

/// Rendered Mermaid SVG with intrinsic layout dimensions.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedDiagram {
    pub diagram_type: DiagramType,
    pub svg: String,
    pub width: f32,
    pub height: f32,
}

/// Failure details returned when Mermaid parsing or rendering fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagramError {
    pub message: String,
}

impl std::fmt::Display for DiagramError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DiagramError {}

#[derive(Clone, PartialEq, Eq, Hash)]
struct DiagramCacheKey {
    hash: u64,
    dark: bool,
    max_width_bits: Option<u32>,
    source: String,
}

fn diagram_cache() -> &'static Mutex<LruCache<DiagramCacheKey, Result<RenderedDiagram, DiagramError>>> {
    static CACHE: OnceLock<Mutex<LruCache<DiagramCacheKey, Result<RenderedDiagram, DiagramError>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(DIAGRAM_CACHE_CAPACITY)))
}

fn make_diagram_cache_key(source: &str, dark: bool, max_width: Option<f32>) -> DiagramCacheKey {
    let sanitized_max_width = max_width.filter(|w| w.is_finite() && *w > 0.0);
    DiagramCacheKey {
        hash: hash_str(source),
        dark,
        max_width_bits: sanitized_max_width.map(f32::to_bits),
        source: source.to_owned(),
    }
}

/// Looks up a previously rendered Mermaid diagram in the LRU cache without running layout.
pub fn cached_render_diagram_with_max_width(source: &str, dark: bool, max_width: Option<f32>) -> Option<Result<RenderedDiagram, DiagramError>> {
    let key = make_diagram_cache_key(source, dark, max_width);
    diagram_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key)
}

/// Renders a Mermaid diagram using `vibevalley-pele` with VibeValley's resolved warm palette.
///
/// Results are LRU-cached by `(source, dark)` so repeated frames and theme toggles stay instant.
pub fn render_diagram(source: &str, dark: bool) -> Result<RenderedDiagram, DiagramError> {
    render_diagram_with_max_width(source, dark, None)
}

/// Renders a Mermaid diagram with an optional maximum width constraint (LRU-cached).
pub fn render_diagram_with_max_width(source: &str, dark: bool, max_width: Option<f32>) -> Result<RenderedDiagram, DiagramError> {
    let key = make_diagram_cache_key(source, dark, max_width);

    if let Some(cached) = diagram_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return cached;
    }

    let palette = vv_pele_palette(dark);
    let options = RenderOptions {
        theme_mode: ThemeMode::resolved(palette),
        font_family: Some(DIAGRAM_FONT_SANS.to_owned()),
        font_family_mono: Some(CODE_FONT_MONO.to_owned()),
        max_width: key.max_width_bits.map(|bits| f64::from(f32::from_bits(bits))),
        ..RenderOptions::default()
    };

    let result = vibevalley_pele::render(source, &options)
        .map(|rendered| RenderedDiagram {
            diagram_type: rendered.diagram_type,
            svg: rendered.svg,
            width: (rendered.width as f32).max(1.0),
            height: (rendered.height as f32).max(1.0),
        })
        .map_err(|err| DiagramError { message: err.to_string() });

    diagram_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, result.clone());
    result
}

/// Returns LRU hit/miss/eviction metrics for [`render_diagram`].
pub fn diagram_cache_stats() -> CacheStats {
    diagram_cache().lock().unwrap_or_else(|p| p.into_inner()).stats()
}

/// Clears all cached Mermaid diagram SVGs.
pub fn clear_diagram_cache() {
    diagram_cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// Props of [`VvDiagram`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvDiagramProps {
    /// Mermaid diagram source text (flowchart, sequence, pie, etc.).
    pub source: Prop<SharedString>,
    /// Optional maximum width hint in points for responsive layout.
    pub max_width: Prop<Option<f32>>,
}

/// Native Mermaid diagram view rendered via `vibevalley-pele` and `ImageSrc::svg_markup`.
///
/// Reacts to `dark()`, hits the LRU cache synchronously, offloads uncached layout/SVG rendering
/// off the UI thread, and falls back to [`crate::VvCodeBlock`] plus a localized error message
/// when the Mermaid source cannot be rendered.
#[component]
pub fn VvDiagram(props: VvDiagramProps) -> impl IntoElement {
    let label = SharedString::from(t("web.base.rich.diagram", &[]));
    let image_label = label.clone();
    let placeholder_label = label.clone();
    let async_result: Signal<Option<(u64, Result<RenderedDiagram, DiagramError>)>> = signal(None);
    let generation = signal(0u64);

    // Offload uncached Mermaid layout/SVG rendering off the UI thread with generation cancellation.
    effect(move || {
        let source = props.source.get();
        let max_width = props.max_width.get();
        let is_dark = dark();

        let next_gen = generation.get_untracked().wrapping_add(1);
        generation.set(next_gen);

        if cached_render_diagram_with_max_width(source.as_str(), is_dark, max_width).is_some() {
            async_result.set(None);
            return;
        }

        async_result.set(None);
        let source_owned = source.to_string();
        spawn(async move {
            let rendered = run_offloaded(move || render_diagram_with_max_width(&source_owned, is_dark, max_width)).await;
            if generation.get_untracked() == next_gen {
                async_result.set(Some((next_gen, rendered)));
            }
        });
    });

    view()
        .test_id("diagram")
        .label(label)
        .flex_col()
        .my(px(8.0))
        .max_w(relative(1.0))
        .child(dynamic(move || {
            let source = props.source.get();
            let max_width = props.max_width.get();
            let is_dark = dark();
            let current_gen = generation.get_untracked();

            let result = async_result
                .with(|slot| match slot {
                    Some((gen_id, res)) if *gen_id == current_gen => Some(res.clone()),
                    Some(_) | None => None,
                })
                .or_else(|| cached_render_diagram_with_max_width(source.as_str(), is_dark, max_width));

            match result {
                Some(Ok(rendered)) => {
                    let src = ImageSrc::svg_markup(&rendered.svg).size(Size::new(px(rendered.width), px(rendered.height)));
                    image(src)
                        .test_id("diagram-image")
                        .role(AccessibilityRole::Image)
                        .accessible(true)
                        .label(image_label.clone())
                        .w(px(rendered.width))
                        .max_w(relative(1.0))
                        .aspect_ratio(rendered.width / rendered.height)
                        .into_element()
                }
                Some(Err(err)) => {
                    let error_text = t("web.base.rich.diagramFailed", &[("why", err.message.as_str().into())]);
                    view()
                        .flex_col()
                        .gap(px(4.0))
                        .child(vv_code_block().code(source).language(Some(SharedString::from("mermaid"))))
                        .child(text(error_text).test_id("diagram-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                        .into_element()
                }
                None => view()
                    .test_id("diagram-loading")
                    .flex_col()
                    .gap(px(4.0))
                    .rounded_md()
                    .border_1()
                    .border_color(AdaptiveUi::LINE)
                    .bg(AdaptiveUi::CODE_SURFACE)
                    .px(px(12.0))
                    .py(px(10.0))
                    .child(text(placeholder_label.clone()).text_size(px(11.0)).text_color(AdaptiveUi::MUTED))
                    .child(
                        text(source)
                            .font_family(CODE_FONT_MONO)
                            .text_size(px(12.0))
                            .line_height(px(CODE_LINE_HEIGHT))
                            .text_color(AdaptiveUi::MUTED),
                    )
                    .into_element(),
            }
        }))
}
