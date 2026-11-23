//! Native `VvChart` component backed directly by `vibevalley-chart`.
//!
//! Renders resvg-safe SVGs with `ThemeMode::Resolved(vv_chart_palette(dark()))` via
//! `image(ImageSrc::svg_markup(&svg).size(...))` (never `element::svg`, which drops `<text>`),
//! cached in a bounded LRU cache keyed by `(hash, spec, dark)`.

use std::sync::{Mutex, OnceLock};

use crate::engine::chart::{RenderOptions, ThemeMode as ChartThemeMode};
use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;

use crate::cache::{CacheStats, LruCache, hash_str};
use crate::code_block::vv_code_block;
use crate::theme::{AdaptiveUi, vv_chart_palette};

const CHART_CACHE_CAPACITY: usize = 64;

/// Standalone SVG image payload returned by `render_chart`.
///
/// Always rasterized through `nsh_core::element::image(ImageSrc::svg_markup(&svg).size(...))`
/// (never `element::svg`, which drops `<text>` nodes).
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedSvg {
    pub svg: String,
    pub width: f32,
    pub height: f32,
    pub label: Option<String>,
}

impl RenderedSvg {
    /// Constructs a new `RenderedSvg` with positive layout dimensions.
    pub fn new(svg: impl Into<String>, width: f32, height: f32) -> Self {
        Self {
            svg: svg.into(),
            width: width.max(1.0),
            height: height.max(1.0),
            label: None,
        }
    }

    /// Attaches an accessibility label to the rendered image.
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ChartCacheKey {
    hash: u64,
    spec: String,
    dark: bool,
}

fn chart_cache() -> &'static Mutex<LruCache<ChartCacheKey, RenderedSvg>> {
    static CACHE: OnceLock<Mutex<LruCache<ChartCacheKey, RenderedSvg>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(CHART_CACHE_CAPACITY)))
}

/// Clears the process-wide `VvChart` SVG cache (intended for tests and theme reloads).
pub fn clear_chart_cache() {
    chart_cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// Returns hit/miss/eviction statistics for the `VvChart` LRU cache.
pub fn chart_cache_stats() -> CacheStats {
    chart_cache().lock().unwrap_or_else(|p| p.into_inner()).stats()
}

/// Parses, validates, and renders a JSON/JSONC chart specification via `vibevalley-chart`
/// using resolved VibeValley warm colors (no CSS variables) and LRU caching.
pub fn render_chart(spec: &str, dark: bool) -> Result<RenderedSvg, String> {
    let key = ChartCacheKey {
        hash: hash_str(spec),
        spec: spec.to_owned(),
        dark,
    };
    if let Some(cached) = chart_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return Ok(cached);
    }

    let parsed = crate::engine::chart::parse_spec(spec).map_err(|err| err.to_string())?;
    let label = parsed.title.clone();
    let options = RenderOptions::default().with_theme(ChartThemeMode::resolved(vv_chart_palette(dark)));
    let rendered = crate::engine::chart::render(&parsed, &options).map_err(|err| err.to_string())?;
    let mut out = RenderedSvg::new(rendered.svg, rendered.width as f32, rendered.height as f32);
    if let Some(title) = label.filter(|t| !t.trim().is_empty()) {
        out = out.with_label(title);
    }
    chart_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, out.clone());
    Ok(out)
}

/// Props of [`VvChart`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvChartProps {
    /// Chart specification text (JSON / JSONC chart spec consumed by `vibevalley-chart`).
    pub spec: Prop<SharedString>,
    /// Optional caption or fallback title for accessibility.
    pub title: Prop<Option<SharedString>>,
}

/// Native chart view backed by `vibevalley-chart`.
///
/// Renders via `ImageSrc::svg_markup` with intrinsic sizing so labels rasterize crisply,
/// falling back cleanly to a labeled JSON code block + error message on invalid specs.
#[component]
pub fn VvChart(props: VvChartProps) -> impl IntoElement {
    view().test_id("chart").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let spec = props.spec.get();
        let title = props.title.get();
        let is_dark = dark();
        let fallback_label = title.clone().unwrap_or_else(|| SharedString::from("Chart"));

        match render_chart(spec.as_str(), is_dark) {
            Ok(rendered) => {
                let width = rendered.width.max(1.0);
                let height = rendered.height.max(1.0);
                let label = rendered.label.map(SharedString::from).unwrap_or(fallback_label);
                let src = ImageSrc::svg_markup(&rendered.svg).size(Size::new(px(width), px(height)));
                image(src)
                    .test_id("chart-image")
                    .role(AccessibilityRole::Image)
                    .accessible(true)
                    .label(label)
                    .w(px(width))
                    .max_w(relative(1.0))
                    .aspect_ratio(width / height)
                    .into_element()
            }
            Err(err) => view()
                .flex_col()
                .gap(px(4.0))
                .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
                .child(text(err).test_id("chart-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                .into_element(),
        }
    }))
}
