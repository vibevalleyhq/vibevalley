//! Pure-Rust Mermaid diagram parser, layered graph layout engine, and `resvg`-safe SVG renderer.

pub mod config;
pub mod detect;
pub mod diagram;
pub mod error;
pub mod layout;
pub mod measure;
pub mod preprocess;
pub mod svg;
pub mod text;
pub mod util;

use std::sync::OnceLock;

pub use config::DiagramConfig;
pub use detect::{Detected, DiagramType, MermaidType, detect, detect_diagram};
pub use diagram::{DEFAULT_LIMIT, DEFAULT_MAX_EDGES, DEFAULT_OUTPUT_LIMIT, DiagramSpec, ParseContext, ParsedDiagram, ParsedModel, Registry, RenderContext};
pub use error::{ErrorCode, PeleError, SourceLocation};
pub use measure::{METRICS_MEASURER, MetricsMeasurer, MonoMeasurer, TextMeasurer, TextStyle};
pub use svg::theme::{ThemeMode, ThemePalette};

pub type IconResolver<'a> = dyn Fn(&str) -> Option<String> + 'a;

#[derive(Debug, Clone, PartialEq)]
pub struct MathSvg {
    pub svg: String,
    pub width: f64,
    pub height: f64,
}

pub type MathResolver<'a> = dyn Fn(&str, f64) -> Option<MathSvg> + 'a;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MonospacePart {
    Members,
    Attributes,
    Files,
    Messages,
}

#[derive(Debug, Clone, Default)]
pub struct ParseOptions {
    pub limit: Option<usize>,
    pub max_edges: Option<usize>,
    pub config: Option<DiagramConfig>,
}

pub struct RenderOptions<'a> {
    pub measurer: Option<&'a dyn TextMeasurer>,
    pub theme_mode: ThemeMode,
    pub font_family: Option<String>,
    pub font_family_mono: Option<String>,
    pub monospace: Vec<MonospacePart>,
    pub font_size: Option<f64>,
    pub id_prefix: Option<String>,
    pub responsive: Option<bool>,
    pub max_width: Option<f64>,
    pub auto_direction: Option<bool>,
    pub direction_breakpoint: Option<f64>,
    pub padding: Option<f64>,
    pub limit: Option<usize>,
    pub output_limit: Option<usize>,
    pub max_edges: Option<usize>,
    pub link_schemes: Option<Vec<String>>,
    pub image_schemes: Option<Vec<String>>,
    pub links: bool,
    pub images: bool,
    pub link_rel: Option<String>,
    pub icons: Option<&'a IconResolver<'a>>,
    pub math: Option<&'a MathResolver<'a>>,
    pub config: Option<DiagramConfig>,
    pub now_ms: Option<i64>,
}

impl Default for RenderOptions<'_> {
    fn default() -> Self {
        Self {
            measurer: None,
            theme_mode: ThemeMode::default(),
            font_family: None,
            font_family_mono: None,
            monospace: Vec::new(),
            font_size: None,
            id_prefix: None,
            responsive: None,
            max_width: None,
            auto_direction: None,
            direction_breakpoint: None,
            padding: None,
            limit: None,
            output_limit: None,
            max_edges: None,
            link_schemes: None,
            image_schemes: None,
            links: true,
            images: true,
            link_rel: None,
            icons: None,
            math: None,
            config: None,
            now_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkInfo {
    pub id: String,
    pub href: String,
    pub internal: bool,
}

#[derive(Debug, Clone)]
pub struct Rendered {
    pub svg: String,
    pub width: f64,
    pub height: f64,
    pub links: Vec<LinkInfo>,
}

#[derive(Debug, Clone)]
pub struct RenderResult {
    pub diagram_type: DiagramType,
    pub mermaid_type: MermaidType,
    pub svg: String,
    pub width: f64,
    pub height: f64,
    pub links: Vec<LinkInfo>,
}

fn default_registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::with_builtins)
}

pub fn detect_type(text: &str) -> Option<DiagramType> {
    default_registry().detect_type(text)
}

pub fn supports(text: &str) -> bool {
    default_registry().supports(text)
}

pub fn parse(text: &str, options: &ParseOptions) -> Result<ParsedDiagram, PeleError> {
    default_registry().parse(text, options)
}

pub fn render_model(parsed: &ParsedDiagram, options: &RenderOptions<'_>) -> Result<RenderResult, PeleError> {
    default_registry().render_model(parsed, options)
}

pub fn render(text: &str, options: &RenderOptions<'_>) -> Result<RenderResult, PeleError> {
    default_registry().render(text, options)
}
