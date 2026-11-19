#![forbid(unsafe_code)]

pub mod color;
pub mod error;
pub mod measure;
pub mod scale;
pub mod spec;
pub mod theme;
pub mod validate;

mod charts;
mod jsonc;
mod layout;
mod svg;

use std::sync::Arc;

pub use charts::stats::{HistogramBin, compute_box_stats, compute_histogram_bins};
pub use error::ChartError;
pub use measure::{DefaultTextMeasurer, TextMeasurer, TextMetrics, truncate_text, wrap_text};
pub use scale::{NumericScale, format_value, nice_number};
pub use spec::{
    Annotation, AreaMode, AreaSpec, AxisScale, AxisSpec, BarMode, BarOrientation, BarSeries, BarSpec, BoxStats, BoxplotGroup, BoxplotSpec, ChartKind,
    ChartSpec, ComboLineSeries, ComboSpec, HeatmapScale, HeatmapSpec, HistogramMode, HistogramSpec, Interpolation, LegendPosition, LineSeries, LineSpec,
    NumberFormat, PieLabelFormat, PieSlice, PieSpec, ScatterPoint, ScatterSeries, ScatterSpec, SparklineSpec, SparklineVariant, ValueAxisSide, XRef,
};
pub use theme::{ThemeMode, ThemePalette};
pub use validate::validate_spec;

use crate::svg::SvgBuilder;
use crate::theme::PaintTokens;

/// Options controlling chart rendering (theme mode and pluggable text measurer).
#[derive(Clone)]
pub struct RenderOptions {
    pub theme: ThemeMode,
    pub measurer: Arc<dyn TextMeasurer>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            theme: ThemeMode::light(),
            measurer: Arc::new(DefaultTextMeasurer),
        }
    }
}

impl RenderOptions {
    pub fn light() -> Self {
        Self::default()
    }

    pub fn dark() -> Self {
        Self {
            theme: ThemeMode::dark(),
            ..Self::default()
        }
    }

    pub fn with_theme(mut self, theme: ThemeMode) -> Self {
        self.theme = theme;
        self
    }

    pub fn with_measurer(mut self, measurer: Arc<dyn TextMeasurer>) -> Self {
        self.measurer = measurer;
        self
    }
}

/// Output of rendering a chart specification into pure `resvg`-safe SVG.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedChart {
    pub svg: String,
    pub width: f64,
    pub height: f64,
}

/// Parses a JSON or JSONC chart specification string and validates all domain invariants.
pub fn parse_spec(input: &str) -> Result<ChartSpec, ChartError> {
    if input.len() > validate::MAX_INPUT_BYTES {
        return Err(ChartError::InputTooLarge {
            actual_bytes: input.len(),
            max_bytes: validate::MAX_INPUT_BYTES,
        });
    }
    let clean_json = jsonc::strip_jsonc(input)?;
    let spec: ChartSpec = serde_json::from_str(&clean_json)?;
    validate_spec(&spec)?;
    Ok(spec)
}

/// Validates and renders a typed `ChartSpec` to pure SVG.
pub fn render(spec: &ChartSpec, options: &RenderOptions) -> Result<RenderedChart, ChartError> {
    validate_spec(spec)?;
    let (width, height) = spec.resolved_dimensions();
    let tokens = PaintTokens::from_mode(&options.theme);
    let mut svg = SvgBuilder::new(width, height, spec.title.as_deref(), &tokens.font_family);
    if let Some(title) = spec.title.as_deref()
        && !title.trim().is_empty()
    {
        svg.title_element(title.trim());
    }

    let ctx = layout::DrawCtx {
        width,
        height,
        tokens: &tokens,
        measurer: options.measurer.as_ref(),
    };
    charts::render_kind(spec, ctx, &mut svg);

    Ok(RenderedChart {
        svg: svg.finish(),
        width,
        height,
    })
}

/// Convenience helper: parses JSON/JSONC input, validates it, and renders SVG.
pub fn render_json(input: &str, options: &RenderOptions) -> Result<RenderedChart, ChartError> {
    let spec = parse_spec(input)?;
    render(&spec, options)
}
