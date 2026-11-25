//! Native `VvCanvas` component rendering JSON Canvas 1.0 documents via pure-Rust `vibevalley-canvas`.
//!
//! Decodes and validates JSON Canvas 1.0, renders a warm light/dark resvg-safe SVG, caches the
//! output in a bounded LRU cache, and mounts it via `image(ImageSrc::svg_markup(&svg).size(...))`
//! so all card text and labels rasterize crisply (NEVER `element::svg`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::engine::canvas::{
    Canvas, PresetSwatch as CanvasPresetSwatch, Rgba8 as CanvasRgba8, SvgRenderOptions, SvgTheme, ThemePalette as CanvasThemePalette, render_svg,
};
use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;

use crate::cache::{CacheStats, LruCache, hash_str};
use crate::code_block::vv_code_block;
use crate::highlight::run_offloaded;
use crate::theme::{AdaptiveUi, DIAGRAM_FONT_SANS};

/// Builds a warm VibeValley `crate::engine::canvas::ThemePalette` for JSON Canvas SVG rendering.
pub fn vv_canvas_palette(dark: bool) -> CanvasThemePalette {
    if dark {
        CanvasThemePalette {
            background: CanvasRgba8::from_hex_u32(0x151413),
            dot_color: CanvasRgba8::from_hex_u32(0x2b2926),
            card_fill: CanvasRgba8::from_hex_u32(0x1b1a18),
            card_border: CanvasRgba8::from_hex_u32(0x3a3632),
            group_fill: CanvasRgba8::from_hex_u32(0x201e1c),
            group_fill_opacity: 0.72,
            group_border: CanvasRgba8::from_hex_u32(0x46413b),
            group_label_bg: CanvasRgba8::from_hex_u32(0x282522),
            text: CanvasRgba8::from_hex_u32(0xecebe8),
            muted: CanvasRgba8::from_hex_u32(0xa9a49e),
            link: CanvasRgba8::from_hex_u32(0x6aa6dc),
            edge: CanvasRgba8::from_hex_u32(0x8b867f),
            edge_label_bg: CanvasRgba8::from_hex_u32(0x1b1a18),
            presets: [
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xe47d6d),
                    fill: CanvasRgba8::from_hex_u32(0xe47d6d),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xf2a99c),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xe0a062),
                    fill: CanvasRgba8::from_hex_u32(0xe0a062),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xf3be8b),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xe5a93c),
                    fill: CanvasRgba8::from_hex_u32(0xe5a93c),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xf0ca78),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x8dbb5c),
                    fill: CanvasRgba8::from_hex_u32(0x8dbb5c),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xb0d488),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x6aa6dc),
                    fill: CanvasRgba8::from_hex_u32(0x6aa6dc),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0x9bc4ea),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xb48ef5),
                    fill: CanvasRgba8::from_hex_u32(0xb48ef5),
                    fill_opacity: 0.15,
                    label: CanvasRgba8::from_hex_u32(0xd5bcf9),
                },
            ],
        }
    } else {
        CanvasThemePalette {
            background: CanvasRgba8::from_hex_u32(0xfcfcfb),
            dot_color: CanvasRgba8::from_hex_u32(0xdfdcd5),
            card_fill: CanvasRgba8::from_hex_u32(0xfffaf0),
            card_border: CanvasRgba8::from_hex_u32(0xd8d2c7),
            group_fill: CanvasRgba8::from_hex_u32(0xf6f5f3),
            group_fill_opacity: 0.7,
            group_border: CanvasRgba8::from_hex_u32(0xc8c0b4),
            group_label_bg: CanvasRgba8::from_hex_u32(0xefeeeb),
            text: CanvasRgba8::from_hex_u32(0x1c1917),
            muted: CanvasRgba8::from_hex_u32(0x5e5852),
            link: CanvasRgba8::from_hex_u32(0x2c6aa3),
            edge: CanvasRgba8::from_hex_u32(0x716a64),
            edge_label_bg: CanvasRgba8::from_hex_u32(0xfcfcfb),
            presets: [
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xa83a2c),
                    fill: CanvasRgba8::from_hex_u32(0xa83a2c),
                    fill_opacity: 0.09,
                    label: CanvasRgba8::from_hex_u32(0x882c21),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xb8682a),
                    fill: CanvasRgba8::from_hex_u32(0xb8682a),
                    fill_opacity: 0.10,
                    label: CanvasRgba8::from_hex_u32(0x94531f),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xc48b20),
                    fill: CanvasRgba8::from_hex_u32(0xe5a93c),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0x8a5e0d),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x4d7a2a),
                    fill: CanvasRgba8::from_hex_u32(0x74a046),
                    fill_opacity: 0.11,
                    label: CanvasRgba8::from_hex_u32(0x3b6125),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x2c6aa3),
                    fill: CanvasRgba8::from_hex_u32(0x4f8fbd),
                    fill_opacity: 0.11,
                    label: CanvasRgba8::from_hex_u32(0x21527f),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x7c52a8),
                    fill: CanvasRgba8::from_hex_u32(0x7c52a8),
                    fill_opacity: 0.09,
                    label: CanvasRgba8::from_hex_u32(0x5d3b82),
                },
            ],
        }
    }
}

/// Maximum number of rendered JSON Canvas SVGs retained in the LRU cache.
const CANVAS_CACHE_CAPACITY: usize = 32;
/// JSON Canvas payloads at or above this byte size offload layout/SVG rendering off the UI thread.
pub const ASYNC_CANVAS_BYTE_THRESHOLD: usize = 4_096;

/// Rendered JSON Canvas SVG with intrinsic layout dimensions.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedCanvas {
    pub svg: String,
    pub width: f32,
    pub height: f32,
    pub node_count: usize,
    pub edge_count: usize,
}

/// Failure details returned when JSON Canvas decoding or validation fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasRenderError {
    pub message: String,
}

impl std::fmt::Display for CanvasRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CanvasRenderError {}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CanvasCacheKey {
    dark: bool,
    show_grid: bool,
    padding_bits: u32,
    data: String,
}

type CanvasCacheEntry = Result<Arc<RenderedCanvas>, CanvasRenderError>;
type CanvasAsyncSlot = Option<(u64, CanvasCacheEntry)>;

fn canvas_cache() -> &'static Mutex<LruCache<CanvasCacheKey, CanvasCacheEntry>> {
    static CACHE: OnceLock<Mutex<LruCache<CanvasCacheKey, CanvasCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(CANVAS_CACHE_CAPACITY)))
}

fn canvas_cache_hash(data: &str, dark: bool, show_grid: bool, padding_bits: u32) -> u64 {
    hash_str(data) ^ (u64::from(padding_bits) << 2) ^ (u64::from(show_grid) << 1) ^ u64::from(dark)
}

fn sanitize_padding(padding: f32) -> (f32, u32) {
    let clamped = if padding.is_finite() && padding >= 0.0 { padding } else { 32.0 };
    (clamped, clamped.to_bits())
}

pub fn should_offload_canvas(data: &str) -> bool {
    data.len() >= ASYNC_CANVAS_BYTE_THRESHOLD
}

pub(crate) fn cached_render_canvas_arc(data: &str, dark: bool, show_grid: bool, padding: f32) -> Option<Result<Arc<RenderedCanvas>, CanvasRenderError>> {
    let (_, padding_bits) = sanitize_padding(padding);
    let hash = canvas_cache_hash(data, dark, show_grid, padding_bits);
    canvas_cache().lock().unwrap_or_else(|p| p.into_inner()).get_by(hash, |k| {
        k.dark == dark && k.show_grid == show_grid && k.padding_bits == padding_bits && k.data == data
    })
}

fn render_canvas_uncached(data: &str, dark: bool, show_grid: bool, clamped_padding: f32) -> Result<Arc<RenderedCanvas>, CanvasRenderError> {
    Canvas::from_json_str(data)
        .map(|canvas| {
            let options = SvgRenderOptions {
                theme: SvgTheme::Custom(Box::new(vv_canvas_palette(dark))),
                padding: f64::from(clamped_padding),
                show_grid,
                font_family: DIAGRAM_FONT_SANS.to_owned(),
                ..SvgRenderOptions::default()
            };
            let svg = render_svg(&canvas, &options);
            let (width, height) = extract_svg_dimensions(&svg).unwrap_or_else(|| fallback_dimensions(&canvas, clamped_padding));
            Arc::new(RenderedCanvas {
                svg,
                width,
                height,
                node_count: canvas.nodes.len(),
                edge_count: canvas.edges.len(),
            })
        })
        .map_err(|err| CanvasRenderError { message: err.to_string() })
}

pub(crate) fn render_canvas_arc(data: &str, dark: bool, show_grid: bool, padding: f32, cache_errors: bool) -> Result<Arc<RenderedCanvas>, CanvasRenderError> {
    let (clamped_padding, padding_bits) = sanitize_padding(padding);
    let hash = canvas_cache_hash(data, dark, show_grid, padding_bits);

    if let Some(cached) = canvas_cache().lock().unwrap_or_else(|p| p.into_inner()).get_by(hash, |k| {
        k.dark == dark && k.show_grid == show_grid && k.padding_bits == padding_bits && k.data == data
    }) {
        return cached;
    }

    let result = render_canvas_uncached(data, dark, show_grid, clamped_padding);
    if result.is_ok() || cache_errors {
        let key = CanvasCacheKey {
            dark,
            show_grid,
            padding_bits,
            data: data.to_owned(),
        };
        canvas_cache()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert_by(hash, key, result.clone(), |k| {
                k.dark == dark && k.show_grid == show_grid && k.padding_bits == padding_bits && k.data == data
            });
    }
    result
}

/// Parses, validates, and renders a JSON Canvas 1.0 string to standalone SVG (LRU-cached).
pub fn render_canvas(data: &str, dark: bool, show_grid: bool, padding: f32) -> Result<RenderedCanvas, CanvasRenderError> {
    render_canvas_arc(data, dark, show_grid, padding, true).map(|arc| (*arc).clone())
}

/// Returns LRU hit/miss/eviction metrics for [`render_canvas`].
pub fn canvas_cache_stats() -> CacheStats {
    canvas_cache().lock().unwrap_or_else(|p| p.into_inner()).stats()
}

/// Clears all cached JSON Canvas SVGs.
pub fn clear_canvas_cache() {
    canvas_cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

fn extract_svg_dimensions(svg: &str) -> Option<(f32, f32)> {
    let header_end = svg.find('>')?;
    let header = &svg[..header_end];
    let width = parse_attr_f32(header, "width")?;
    let height = parse_attr_f32(header, "height")?;
    if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 {
        Some((width, height))
    } else {
        None
    }
}

fn parse_attr_f32(tag: &str, name: &str) -> Option<f32> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    rest[..end].trim_end_matches("px").parse::<f32>().ok()
}

fn fallback_dimensions(canvas: &Canvas, padding: f32) -> (f32, f32) {
    match canvas.content_bounds() {
        Some(bounds) => (
            ((bounds.width as f32) + padding * 2.0).max(1.0),
            ((bounds.height as f32) + padding * 2.0).max(1.0),
        ),
        None => (400.0, 300.0),
    }
}

/// Props of [`VvCanvas`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvCanvasProps {
    /// JSON Canvas 1.0 document string.
    pub data: Prop<SharedString>,
    /// Show the subtle dot grid behind nodes (default true).
    #[prop(default = true)]
    pub show_grid: Prop<bool>,
    /// Outer canvas padding in points around content bounds (default 32).
    #[prop(default = 32.0)]
    pub padding: Prop<f32>,
    /// When true, incomplete JSON while token-streaming shows a lightweight loading placeholder
    /// without polluting the cache or highlighting incomplete JSON on every token.
    #[prop(default)]
    pub streaming: Prop<bool>,
}

fn render_canvas_loading() -> AnyElement {
    view()
        .test_id("canvas-loading")
        .flex_col()
        .rounded_md()
        .border_1()
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::SIDE)
        .p(px(12.0))
        .child(text("…").text_size(px(12.0)).text_color(AdaptiveUi::MUTED))
        .into_element()
}

/// Native static JSON Canvas view rendered via `vibevalley-canvas` and `ImageSrc::svg_markup`.
///
/// Reacts to `dark()`, caches rendered SVGs in an LRU cache, offloads large uncached payloads off
/// the UI thread, and falls back to [`crate::VvCodeBlock`] plus an error message when invalid.
#[component]
pub fn VvCanvas(props: VvCanvasProps) -> impl IntoElement {
    let async_result: Signal<CanvasAsyncSlot> = signal(None);
    let generation = signal(0u64);
    let latest_gen = Arc::new(AtomicU64::new(0));

    let effect_latest_gen = Arc::clone(&latest_gen);
    effect(move || {
        let data = props.data.get();
        let show_grid = props.show_grid.get();
        let padding = props.padding.get();
        let streaming = props.streaming.get();
        let is_dark = dark();

        let next_gen = generation.get_untracked().wrapping_add(1);
        generation.set(next_gen);
        effect_latest_gen.store(next_gen, Ordering::Release);

        if !should_offload_canvas(data.as_str()) || cached_render_canvas_arc(data.as_str(), is_dark, show_grid, padding).is_some() {
            async_result.set(None);
            return;
        }

        async_result.set(None);
        let data_owned = data.to_string();
        let job_latest_gen = Arc::clone(&effect_latest_gen);
        spawn(async move {
            let rendered = run_offloaded(move || {
                (job_latest_gen.load(Ordering::Acquire) == next_gen).then(|| render_canvas_arc(&data_owned, is_dark, show_grid, padding, !streaming))
            })
            .await;
            if let Some(rendered) = rendered
                && generation.get_untracked() == next_gen
            {
                async_result.set(Some((next_gen, rendered)));
            }
        });
    });

    view().test_id("canvas").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let data = props.data.get();
        let show_grid = props.show_grid.get();
        let padding = props.padding.get();
        let streaming = props.streaming.get();
        let is_dark = dark();

        let result = if should_offload_canvas(data.as_str()) {
            let current_gen = generation.get_untracked();
            async_result
                .with(|slot| match slot {
                    Some((gen_id, res)) if *gen_id == current_gen => Some(res.clone()),
                    Some(_) | None => None,
                })
                .or_else(|| cached_render_canvas_arc(data.as_str(), is_dark, show_grid, padding))
        } else {
            Some(render_canvas_arc(data.as_str(), is_dark, show_grid, padding, !streaming))
        };

        match result {
            Some(Ok(rendered)) => {
                let src = ImageSrc::svg_markup(&rendered.svg).size(Size::new(px(rendered.width), px(rendered.height)));
                image(src)
                    .test_id("canvas-image")
                    .role(AccessibilityRole::Image)
                    .accessible(true)
                    .label("Canvas")
                    .w(px(rendered.width))
                    .max_w(relative(1.0))
                    .aspect_ratio(rendered.width / rendered.height)
                    .rounded_md()
                    .border_1()
                    .border_color(AdaptiveUi::LINE)
                    .into_element()
            }
            Some(Err(_)) if streaming => render_canvas_loading(),
            Some(Err(err)) => view()
                .flex_col()
                .gap(px(4.0))
                .child(vv_code_block().code(data).language(Some(SharedString::from("json"))))
                .child(text(err.message).test_id("canvas-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                .into_element(),
            None => render_canvas_loading(),
        }
    }))
}
