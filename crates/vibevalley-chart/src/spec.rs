use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

/// Top-level declarative chart specification parsed from JSON/JSONC or built in Rust.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub legend: LegendPosition,
    #[serde(default)]
    pub palette: Option<Vec<String>>,
    #[serde(default)]
    pub x_axis: AxisSpec,
    #[serde(default)]
    pub y_axis: AxisSpec,
    #[serde(default)]
    pub y2_axis: AxisSpec,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(flatten)]
    pub kind: ChartKind,
}

impl ChartSpec {
    pub fn new(kind: ChartKind) -> Self {
        Self {
            title: None,
            subtitle: None,
            width: None,
            height: None,
            legend: LegendPosition::Auto,
            palette: None,
            x_axis: AxisSpec::default(),
            y_axis: AxisSpec::default(),
            y2_axis: AxisSpec::default(),
            annotations: Vec::new(),
            kind,
        }
    }

    pub fn resolved_dimensions(&self) -> (f64, f64) {
        let (default_w, default_h) = match &self.kind {
            ChartKind::Bar(_)
            | ChartKind::Line(_)
            | ChartKind::Area(_)
            | ChartKind::Scatter(_)
            | ChartKind::Bubble(_)
            | ChartKind::Combo(_)
            | ChartKind::Boxplot(_)
            | ChartKind::Histogram(_) => (680.0, 400.0),
            ChartKind::Pie(_) | ChartKind::Donut(_) => (560.0, 380.0),
            ChartKind::Heatmap(hm) => {
                let cols = hm.x_labels.len().max(1) as f64;
                let rows = hm.y_labels.len().max(1) as f64;
                let w = (180.0 + cols * 54.0).clamp(420.0, 880.0);
                let h = (140.0 + rows * 40.0).clamp(280.0, 680.0);
                (w, h)
            }
            ChartKind::Sparkline(_) => (160.0, 40.0),
        };
        (self.width.unwrap_or(default_w), self.height.unwrap_or(default_h))
    }
}

/// Closed set of supported chart families.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChartKind {
    Bar(BarSpec),
    Line(LineSpec),
    Area(AreaSpec),
    Scatter(ScatterSpec),
    Bubble(ScatterSpec),
    Pie(PieSpec),
    Donut(PieSpec),
    Combo(ComboSpec),
    Heatmap(HeatmapSpec),
    Boxplot(BoxplotSpec),
    Histogram(HistogramSpec),
    Sparkline(SparklineSpec),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegendPosition {
    #[default]
    Auto,
    Top,
    Bottom,
    Right,
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisSpec {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub format: NumberFormat,
    #[serde(default)]
    pub currency_symbol: Option<String>,
    #[serde(default)]
    pub decimals: Option<u8>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub gridlines: Option<bool>,
    #[serde(default)]
    pub scale: AxisScale,
    #[serde(default)]
    pub tick_count: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NumberFormat {
    #[default]
    Number,
    Compact,
    Percent,
    Currency,
    Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisScale {
    #[default]
    Linear,
    Log,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueAxisSide {
    #[default]
    Left,
    Right,
}

/// Reference coordinate on the X axis (either numeric or category label).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum XRef {
    Number(f64),
    Category(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Annotation {
    HorizontalLine {
        value: f64,
        #[serde(default)]
        axis: ValueAxisSide,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default = "default_true")]
        dashed: bool,
    },
    VerticalLine {
        value: XRef,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default = "default_true")]
        dashed: bool,
    },
    HorizontalBand {
        from: f64,
        to: f64,
        #[serde(default)]
        axis: ValueAxisSide,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        opacity: Option<f64>,
    },
    VerticalBand {
        from: XRef,
        to: XRef,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        opacity: Option<f64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarOrientation {
    #[default]
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarMode {
    #[default]
    Grouped,
    Stacked,
    #[serde(alias = "stacked100", alias = "percent")]
    PercentStacked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarSeries {
    pub name: String,
    pub data: Vec<Option<f64>>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarSpec {
    pub categories: Vec<String>,
    pub series: Vec<BarSeries>,
    #[serde(default)]
    pub orientation: BarOrientation,
    #[serde(default)]
    pub mode: BarMode,
    #[serde(default)]
    pub show_values: bool,
    #[serde(default)]
    pub corner_radius: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Interpolation {
    #[default]
    Linear,
    Smooth,
    #[serde(alias = "stepAfter")]
    Step,
    StepBefore,
    StepMiddle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSeries {
    pub name: String,
    pub data: Vec<Option<f64>>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub dashed: bool,
    #[serde(default)]
    pub stroke_width: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSpec {
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub x_values: Option<Vec<f64>>,
    pub series: Vec<LineSeries>,
    #[serde(default)]
    pub interpolation: Interpolation,
    #[serde(default)]
    pub show_points: bool,
    #[serde(default)]
    pub show_values: bool,
    #[serde(default)]
    pub connect_nulls: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AreaMode {
    #[default]
    Standard,
    Stacked,
    #[serde(alias = "stacked100", alias = "percent")]
    PercentStacked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaSpec {
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub x_values: Option<Vec<f64>>,
    pub series: Vec<LineSeries>,
    #[serde(default)]
    pub mode: AreaMode,
    #[serde(default)]
    pub interpolation: Interpolation,
    #[serde(default)]
    pub show_points: bool,
    #[serde(default)]
    pub fill_opacity: Option<f64>,
    #[serde(default)]
    pub connect_nulls: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScatterPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScatterSeries {
    pub name: String,
    pub points: Vec<ScatterPoint>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScatterSpec {
    pub series: Vec<ScatterSeries>,
    #[serde(default)]
    pub point_radius: Option<f64>,
    #[serde(default)]
    pub min_radius: Option<f64>,
    #[serde(default)]
    pub max_radius: Option<f64>,
    #[serde(default)]
    pub show_labels: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PieLabelFormat {
    #[default]
    Auto,
    Percent,
    Value,
    LabelAndPercent,
    LabelAndValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieSlice {
    pub label: String,
    pub value: f64,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieSpec {
    pub slices: Vec<PieSlice>,
    #[serde(default)]
    pub inner_radius_ratio: Option<f64>,
    #[serde(default)]
    pub center_label: Option<String>,
    #[serde(default)]
    pub center_sublabel: Option<String>,
    #[serde(default)]
    pub show_labels: Option<bool>,
    #[serde(default)]
    pub label_format: PieLabelFormat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboLineSeries {
    pub name: String,
    pub data: Vec<Option<f64>>,
    #[serde(default = "default_right_axis")]
    pub axis: ValueAxisSide,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub dashed: bool,
    #[serde(default)]
    pub stroke_width: Option<f64>,
}

fn default_right_axis() -> ValueAxisSide {
    ValueAxisSide::Right
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboSpec {
    pub categories: Vec<String>,
    #[serde(default)]
    pub bars: Vec<BarSeries>,
    #[serde(default)]
    pub lines: Vec<ComboLineSeries>,
    #[serde(default)]
    pub bar_mode: BarMode,
    #[serde(default)]
    pub interpolation: Interpolation,
    #[serde(default = "default_true")]
    pub show_points: bool,
    #[serde(default)]
    pub show_values: bool,
    #[serde(default)]
    pub bar_corner_radius: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeatmapScale {
    #[default]
    Sequential,
    Diverging,
    Custom {
        low: String,
        #[serde(default)]
        mid: Option<String>,
        high: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapSpec {
    pub x_labels: Vec<String>,
    pub y_labels: Vec<String>,
    pub values: Vec<Vec<Option<f64>>>,
    #[serde(default)]
    pub color_scale: HeatmapScale,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub midpoint: Option<f64>,
    #[serde(default)]
    pub show_values: Option<bool>,
    #[serde(default)]
    pub value_format: NumberFormat,
    #[serde(default)]
    pub show_color_bar: Option<bool>,
    #[serde(default)]
    pub cell_radius: Option<f64>,
    #[serde(default)]
    pub cell_gap: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxStats {
    pub min: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub max: f64,
    #[serde(default)]
    pub outliers: Vec<f64>,
    #[serde(default)]
    pub mean: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxplotGroup {
    pub label: String,
    #[serde(default)]
    pub samples: Option<Vec<f64>>,
    #[serde(default)]
    pub stats: Option<BoxStats>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxplotSpec {
    pub groups: Vec<BoxplotGroup>,
    #[serde(default)]
    pub orientation: BarOrientation,
    #[serde(default)]
    pub show_mean: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistogramMode {
    #[default]
    Count,
    Percent,
    Density,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramSpec {
    pub values: Vec<f64>,
    #[serde(default)]
    pub bins: Option<usize>,
    #[serde(default)]
    pub bin_edges: Option<Vec<f64>>,
    #[serde(default)]
    pub normalize: HistogramMode,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub show_values: bool,
    #[serde(default)]
    pub show_mean: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SparklineVariant {
    #[default]
    Line,
    Area,
    Bar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SparklineSpec {
    pub data: Vec<Option<f64>>,
    #[serde(default)]
    pub variant: SparklineVariant,
    #[serde(default)]
    pub interpolation: Interpolation,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub negative_color: Option<String>,
    #[serde(default)]
    pub highlight_last: Option<bool>,
    #[serde(default)]
    pub highlight_extrema: bool,
    #[serde(default)]
    pub baseline: Option<f64>,
}
