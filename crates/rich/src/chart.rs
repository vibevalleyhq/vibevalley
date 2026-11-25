//! Native `VvChart` component backed directly by `vibevalley-chart`.
//!
//! Renders resvg-safe SVGs with `ThemeMode::Resolved(vv_chart_palette(dark()))` via
//! `image(ImageSrc::svg_markup(&svg).size(...))` (never `element::svg`, which drops `<text>`),
//! cached in a bounded LRU cache keyed by `(hash, spec, dark)`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::engine::chart::{RenderOptions, ThemeMode as ChartThemeMode, ThemePalette as ChartThemePalette};
use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;

use crate::cache::{CacheStats, LruCache, hash_str};
use crate::code_block::vv_code_block;
use crate::highlight::run_offloaded;
use crate::theme::{AdaptiveUi, DIAGRAM_FONT_SANS};

/// Builds a resolved `crate::engine::chart::ThemePalette` matching `apps/mac/ui/design/theme.json`.
///
/// Uses concrete hex colors (zero CSS `var()`) and VibeValley's macOS UI font stack so
/// `resvg` renders chart axes, legends, and labels accurately.
pub fn vv_chart_palette(dark: bool) -> ChartThemePalette {
    let mut palette = if dark { ChartThemePalette::dark() } else { ChartThemePalette::light() };
    palette.font_family = DIAGRAM_FONT_SANS.to_owned();
    palette
}

const CHART_CACHE_CAPACITY: usize = 64;
/// Chart specs at or above this byte size offload parsing/SVG rendering off the UI thread.
pub const ASYNC_CHART_BYTE_THRESHOLD: usize = 4_096;

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
    spec: String,
    dark: bool,
}

fn chart_cache() -> &'static Mutex<LruCache<ChartCacheKey, Arc<RenderedSvg>>> {
    static CACHE: OnceLock<Mutex<LruCache<ChartCacheKey, Arc<RenderedSvg>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(CHART_CACHE_CAPACITY)))
}

fn chart_cache_hash(spec: &str, dark: bool) -> u64 {
    hash_str(spec) ^ u64::from(dark)
}

pub fn should_offload_chart(spec: &str) -> bool {
    spec.len() >= ASYNC_CHART_BYTE_THRESHOLD
}

/// Clears the process-wide `VvChart` SVG cache (intended for tests and theme reloads).
pub fn clear_chart_cache() {
    chart_cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// Returns hit/miss/eviction statistics for the `VvChart` LRU cache.
pub fn chart_cache_stats() -> CacheStats {
    chart_cache().lock().unwrap_or_else(|p| p.into_inner()).stats()
}

pub(crate) fn cached_render_chart_arc(spec: &str, dark: bool) -> Option<Arc<RenderedSvg>> {
    let hash = chart_cache_hash(spec, dark);
    chart_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_by(hash, |k| k.dark == dark && k.spec == spec)
}

/// Looks up a previously rendered chart SVG in the LRU cache without parsing or rendering.
pub fn cached_render_chart(spec: &str, dark: bool) -> Option<RenderedSvg> {
    cached_render_chart_arc(spec, dark).map(|arc| (*arc).clone())
}

pub(crate) fn render_chart_arc(spec: &str, dark: bool) -> Result<Arc<RenderedSvg>, String> {
    let hash = chart_cache_hash(spec, dark);
    if let Some(cached) = chart_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_by(hash, |k| k.dark == dark && k.spec == spec)
    {
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
    let out = Arc::new(out);
    let key = ChartCacheKey { spec: spec.to_owned(), dark };
    chart_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert_by(hash, key, Arc::clone(&out), |k| k.dark == dark && k.spec == spec);
    Ok(out)
}

/// Parses, validates, and renders a JSON/JSONC chart specification via `vibevalley-chart`
/// using resolved VibeValley warm colors (no CSS variables) and LRU caching.
pub fn render_chart(spec: &str, dark: bool) -> Result<RenderedSvg, String> {
    render_chart_arc(spec, dark).map(|arc| (*arc).clone())
}

/// Props of [`VvChart`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvChartProps {
    /// Chart specification text (JSON / JSONC chart spec consumed by `vibevalley-chart`).
    pub spec: Prop<SharedString>,
    /// Optional caption or fallback title for accessibility.
    pub title: Prop<Option<SharedString>>,
    /// When true, incomplete JSON while token-streaming shows a lightweight loading placeholder
    /// instead of highlighting incomplete JSON on every token.
    #[prop(default)]
    pub streaming: Prop<bool>,
}

fn render_chart_loading() -> AnyElement {
    view()
        .test_id("chart-loading")
        .flex_col()
        .rounded_md()
        .border_1()
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::SIDE)
        .p(px(12.0))
        .child(text("…").text_size(px(12.0)).text_color(AdaptiveUi::MUTED))
        .into_element()
}

type ChartAsyncSlot = Option<(u64, Result<Arc<RenderedSvg>, String>)>;

/// Native chart view backed by `vibevalley-chart`.
///
/// Renders via `ImageSrc::svg_markup` with intrinsic sizing so labels rasterize crisply,
/// offloads large uncached specs off the UI thread, and falls back cleanly to a labeled
/// JSON code block + error message on invalid specs.
#[component]
pub fn VvChart(props: VvChartProps) -> impl IntoElement {
    let async_result: Signal<ChartAsyncSlot> = signal(None);
    let generation = signal(0u64);
    let latest_gen = Arc::new(AtomicU64::new(0));

    let effect_latest_gen = Arc::clone(&latest_gen);
    effect(move || {
        let spec = props.spec.get();
        let is_dark = dark();

        let next_gen = generation.get_untracked().wrapping_add(1);
        generation.set(next_gen);
        effect_latest_gen.store(next_gen, Ordering::Release);

        if !should_offload_chart(spec.as_str()) || cached_render_chart_arc(spec.as_str(), is_dark).is_some() {
            async_result.set(None);
            return;
        }

        async_result.set(None);
        let spec_owned = spec.to_string();
        let job_latest_gen = Arc::clone(&effect_latest_gen);
        spawn(async move {
            let rendered = run_offloaded(move || (job_latest_gen.load(Ordering::Acquire) == next_gen).then(|| render_chart_arc(&spec_owned, is_dark))).await;
            if let Some(rendered) = rendered
                && generation.get_untracked() == next_gen
            {
                async_result.set(Some((next_gen, rendered)));
            }
        });
    });

    view().test_id("chart").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let spec = props.spec.get();
        let title = props.title.get();
        let streaming = props.streaming.get();
        let is_dark = dark();
        let fallback_label = title.clone().unwrap_or_else(|| SharedString::from("Chart"));

        let result = if should_offload_chart(spec.as_str()) {
            let current_gen = generation.get_untracked();
            async_result
                .with(|slot| match slot {
                    Some((gen_id, res)) if *gen_id == current_gen => Some(res.clone()),
                    Some(_) | None => None,
                })
                .or_else(|| cached_render_chart_arc(spec.as_str(), is_dark).map(Ok))
        } else {
            Some(render_chart_arc(spec.as_str(), is_dark))
        };

        match result {
            Some(Ok(rendered)) => {
                let width = rendered.width.max(1.0);
                let height = rendered.height.max(1.0);
                let label = rendered.label.clone().map(SharedString::from).unwrap_or(fallback_label);
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
            Some(Err(_)) if streaming => render_chart_loading(),
            Some(Err(err)) => view()
                .flex_col()
                .gap(px(4.0))
                .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
                .child(text(err).test_id("chart-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                .into_element(),
            None => render_chart_loading(),
        }
    }))
}
