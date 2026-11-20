//! Native `VvCanvas` component rendering JSON Canvas 1.0 documents via pure-Rust `vibevalley-canvas`.
//!
//! Decodes and validates JSON Canvas 1.0, renders a warm light/dark resvg-safe SVG, caches the
//! output in a bounded LRU cache, and mounts it via `image(ImageSrc::svg_markup(&svg).size(...))`
//! so all card text and labels rasterize crisply (NEVER `element::svg`).

use std::sync::{Mutex, OnceLock};

use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;
use vibevalley_canvas::{Canvas, SvgRenderOptions, SvgTheme, render_svg};

use crate::cache::{CacheStats, LruCache, hash_str};
use crate::code_block::vv_code_block;
use crate::theme::{AdaptiveUi, DIAGRAM_FONT_SANS, vv_canvas_palette};

/// Maximum number of rendered JSON Canvas SVGs retained in the LRU cache.
const CANVAS_CACHE_CAPACITY: usize = 32;

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
    hash: u64,
    dark: bool,
    show_grid: bool,
    padding_bits: u32,
    data: String,
}

fn canvas_cache() -> &'static Mutex<LruCache<CanvasCacheKey, Result<RenderedCanvas, CanvasRenderError>>> {
    static CACHE: OnceLock<Mutex<LruCache<CanvasCacheKey, Result<RenderedCanvas, CanvasRenderError>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(CANVAS_CACHE_CAPACITY)))
}

/// Parses, validates, and renders a JSON Canvas 1.0 string to standalone SVG (LRU-cached).
pub fn render_canvas(data: &str, dark: bool, show_grid: bool, padding: f32) -> Result<RenderedCanvas, CanvasRenderError> {
    let clamped_padding = if padding.is_finite() && padding >= 0.0 { padding } else { 32.0 };
    let key = CanvasCacheKey {
        hash: hash_str(data),
        dark,
        show_grid,
        padding_bits: clamped_padding.to_bits(),
        data: data.to_owned(),
    };

    if let Some(cached) = canvas_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return cached;
    }

    let result = Canvas::from_json_str(data)
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
            RenderedCanvas {
                svg,
                width,
                height,
                node_count: canvas.nodes.len(),
                edge_count: canvas.edges.len(),
            }
        })
        .map_err(|err| CanvasRenderError { message: err.to_string() });

    canvas_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, result.clone());
    result
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
}

/// Native static JSON Canvas view rendered via `vibevalley-canvas` and `ImageSrc::svg_markup`.
///
/// Reacts to `dark()`, caches rendered SVGs in an LRU cache, and falls back to [`crate::VvCodeBlock`]
/// plus an error message when the JSON Canvas payload is invalid.
#[component]
pub fn VvCanvas(props: VvCanvasProps) -> impl IntoElement {
    view().test_id("canvas").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let data = props.data.get();
        let show_grid = props.show_grid.get();
        let padding = props.padding.get();
        let is_dark = dark();
        match render_canvas(data.as_str(), is_dark, show_grid, padding) {
            Ok(rendered) => {
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
            Err(err) => view()
                .flex_col()
                .gap(px(4.0))
                .child(vv_code_block().code(data).language(Some(SharedString::from("json"))))
                .child(text(err.message).test_id("canvas-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                .into_element(),
        }
    }))
}
