use serde::{Deserialize, Serialize};

use crate::error::GenUiError;
use crate::spec::{Align, CalloutKind, ChartKind, StackDirection, TextAlign, TextSize, Tone};
use crate::value::{FormatKind, StateValue};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolveDiagnostic {
    pub node_id: String,
    pub field: String,
    pub error: GenUiError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedDoc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub is_complete: bool,
    pub doc_generation: u64,
    pub state_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<ResolvedNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<ResolveDiagnostic>,
}

impl ResolvedDoc {
    pub fn find_node(&self, id: &str) -> Option<&ResolvedNode> {
        self.root.as_ref().and_then(|root| root.find_by_id(id))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedNode {
    pub id: String,
    pub generation: u64,
    #[serde(flatten)]
    pub kind: ResolvedNodeKind,
}

impl ResolvedNode {
    pub fn find_by_id(&self, id: &str) -> Option<&ResolvedNode> {
        if self.id == id {
            return Some(self);
        }
        match &self.kind {
            ResolvedNodeKind::Stack { children, .. } | ResolvedNodeKind::Grid { children, .. } | ResolvedNodeKind::Card { children, .. } => {
                children.iter().find_map(|child| child.find_by_id(id))
            }
            ResolvedNodeKind::Tabs { tabs, .. } => tabs.iter().flat_map(|tab| tab.children.iter()).find_map(|child| child.find_by_id(id)),
            ResolvedNodeKind::Divider { .. }
            | ResolvedNodeKind::Text { .. }
            | ResolvedNodeKind::Markdown { .. }
            | ResolvedNodeKind::Metric { .. }
            | ResolvedNodeKind::Badge { .. }
            | ResolvedNodeKind::Progress { .. }
            | ResolvedNodeKind::Callout { .. }
            | ResolvedNodeKind::Table { .. }
            | ResolvedNodeKind::Slider { .. }
            | ResolvedNodeKind::Switch { .. }
            | ResolvedNodeKind::Select { .. }
            | ResolvedNodeKind::Chart(_)
            | ResolvedNodeKind::Diagram { .. }
            | ResolvedNodeKind::Canvas { .. }
            | ResolvedNodeKind::CodeBlock { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedTab {
    pub id: String,
    pub label: String,
    pub active: bool,
    pub children: Vec<ResolvedNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedTableColumn {
    pub key: String,
    pub label: String,
    pub align: TextAlign,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<FormatKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedTableRow {
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedSelectOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedChartSeries {
    pub name: String,
    pub values: Vec<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedReactiveChart {
    pub chart_kind: ChartKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_format: Option<FormatKind>,
    pub categories: Vec<String>,
    pub series: Vec<ResolvedChartSeries>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ResolvedChartContent {
    Reactive(ResolvedReactiveChart),
    SpecJson { spec_json: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedChart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub content: ResolvedChartContent,
}

impl ResolvedChart {
    pub fn to_chart_spec_json(&self) -> Result<String, GenUiError> {
        match &self.content {
            ResolvedChartContent::SpecJson { spec_json } => Ok(spec_json.clone()),
            ResolvedChartContent::Reactive(chart) => {
                let x_axis = chart.x_label.as_deref().map(|label| WireXAxis { label });
                let y_axis = if chart.y_label.is_some() || chart.y_format.is_some() {
                    Some(WireYAxis {
                        label: chart.y_label.as_deref(),
                        format: chart.y_format.map(FormatKind::as_chart_format),
                    })
                } else {
                    None
                };

                let serialize_err = |err: serde_json::Error| GenUiError::Serialization { message: err.to_string() };

                match chart.chart_kind {
                    ChartKind::Line | ChartKind::Area | ChartKind::Bar | ChartKind::StackedBar => {
                        let mode = match chart.chart_kind {
                            ChartKind::StackedBar => Some("stacked"),
                            ChartKind::Line
                            | ChartKind::Area
                            | ChartKind::Bar
                            | ChartKind::Scatter
                            | ChartKind::Pie
                            | ChartKind::Donut
                            | ChartKind::Sparkline => None,
                        };
                        let wire = WireCartesianChartSpec {
                            chart_type: chart.chart_kind.as_spec_str(),
                            mode,
                            title: self.title.as_deref(),
                            subtitle: self.subtitle.as_deref(),
                            width: self.width,
                            height: self.height,
                            categories: &chart.categories,
                            x_axis,
                            y_axis,
                            series: chart
                                .series
                                .iter()
                                .map(|s| WireChartSeries {
                                    name: &s.name,
                                    data: &s.values,
                                    color: s.color.as_deref(),
                                })
                                .collect(),
                        };
                        serde_json::to_string(&wire).map_err(serialize_err)
                    }
                    ChartKind::Pie | ChartKind::Donut => {
                        let slices = build_pie_slices(chart);
                        let wire = WirePieChartSpec {
                            chart_type: chart.chart_kind.as_spec_str(),
                            title: self.title.as_deref(),
                            subtitle: self.subtitle.as_deref(),
                            width: self.width,
                            height: self.height,
                            slices,
                        };
                        serde_json::to_string(&wire).map_err(serialize_err)
                    }
                    ChartKind::Sparkline => {
                        let (data, color) = match chart.series.first() {
                            Some(first) => (first.values.as_slice(), first.color.as_deref()),
                            None => (&[][..], None),
                        };
                        let wire = WireSparklineSpec {
                            chart_type: chart.chart_kind.as_spec_str(),
                            title: self.title.as_deref(),
                            subtitle: self.subtitle.as_deref(),
                            width: self.width,
                            height: self.height,
                            data,
                            color,
                        };
                        serde_json::to_string(&wire).map_err(serialize_err)
                    }
                    ChartKind::Scatter => {
                        let series = chart
                            .series
                            .iter()
                            .map(|s| {
                                let points = s
                                    .values
                                    .iter()
                                    .enumerate()
                                    .filter_map(|(i, maybe_y)| {
                                        let y = (*maybe_y)?;
                                        if !y.is_finite() {
                                            return None;
                                        }
                                        let x = chart
                                            .categories
                                            .get(i)
                                            .and_then(|c| c.trim().parse::<f64>().ok())
                                            .filter(|v| v.is_finite())
                                            .unwrap_or(i as f64);
                                        Some(WireScatterPoint { x, y })
                                    })
                                    .collect();
                                WireScatterSeries {
                                    name: &s.name,
                                    points,
                                    color: s.color.as_deref(),
                                }
                            })
                            .collect();
                        let wire = WireScatterChartSpec {
                            chart_type: chart.chart_kind.as_spec_str(),
                            title: self.title.as_deref(),
                            subtitle: self.subtitle.as_deref(),
                            width: self.width,
                            height: self.height,
                            x_axis,
                            y_axis,
                            series,
                        };
                        serde_json::to_string(&wire).map_err(serialize_err)
                    }
                }
            }
        }
    }
}

fn build_pie_slices(chart: &ResolvedReactiveChart) -> Vec<WirePieSlice<'_>> {
    if !chart.categories.is_empty()
        && let Some(first) = chart.series.first()
    {
        return chart
            .categories
            .iter()
            .zip(first.values.iter())
            .filter_map(|(label, maybe_val)| {
                let value = (*maybe_val)?;
                if !value.is_finite() {
                    return None;
                }
                Some(WirePieSlice {
                    label: label.as_str(),
                    value,
                    color: None,
                })
            })
            .collect();
    }
    chart
        .series
        .iter()
        .filter_map(|s| {
            let value = s.values.iter().flatten().copied().find(|v| v.is_finite())?;
            Some(WirePieSlice {
                label: s.name.as_str(),
                value,
                color: s.color.as_deref(),
            })
        })
        .collect()
}

#[derive(Serialize)]
struct WireCartesianChartSpec<'a> {
    #[serde(rename = "type")]
    chart_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    categories: &'a [String],
    #[serde(rename = "xAxis", skip_serializing_if = "Option::is_none")]
    x_axis: Option<WireXAxis<'a>>,
    #[serde(rename = "yAxis", skip_serializing_if = "Option::is_none")]
    y_axis: Option<WireYAxis<'a>>,
    series: Vec<WireChartSeries<'a>>,
}

#[derive(Serialize)]
struct WirePieChartSpec<'a> {
    #[serde(rename = "type")]
    chart_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    slices: Vec<WirePieSlice<'a>>,
}

#[derive(Serialize)]
struct WirePieSlice<'a> {
    label: &'a str,
    value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<&'a str>,
}

#[derive(Serialize)]
struct WireSparklineSpec<'a> {
    #[serde(rename = "type")]
    chart_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    data: &'a [Option<f64>],
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<&'a str>,
}

#[derive(Serialize)]
struct WireScatterChartSpec<'a> {
    #[serde(rename = "type")]
    chart_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(rename = "xAxis", skip_serializing_if = "Option::is_none")]
    x_axis: Option<WireXAxis<'a>>,
    #[serde(rename = "yAxis", skip_serializing_if = "Option::is_none")]
    y_axis: Option<WireYAxis<'a>>,
    series: Vec<WireScatterSeries<'a>>,
}

#[derive(Serialize)]
struct WireScatterSeries<'a> {
    name: &'a str,
    points: Vec<WireScatterPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<&'a str>,
}

#[derive(Serialize)]
struct WireScatterPoint {
    x: f64,
    y: f64,
}

#[derive(Serialize)]
struct WireXAxis<'a> {
    label: &'a str,
}

#[derive(Serialize)]
struct WireYAxis<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'a str>,
}

#[derive(Serialize)]
struct WireChartSeries<'a> {
    name: &'a str,
    data: &'a [Option<f64>],
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedNodeKind {
    Stack {
        direction: StackDirection,
        gap: f32,
        align: Align,
        children: Vec<ResolvedNode>,
    },
    Grid {
        columns: u16,
        gap: f32,
        children: Vec<ResolvedNode>,
    },
    Card {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle: Option<String>,
        children: Vec<ResolvedNode>,
    },
    Tabs {
        bind: String,
        active_tab: String,
        tabs: Vec<ResolvedTab>,
    },
    Divider {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Text {
        value: String,
        tone: Tone,
        size: TextSize,
    },
    Markdown {
        text: String,
    },
    Metric {
        label: String,
        value: String,
        raw_value: StateValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delta: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<FormatKind>,
    },
    Badge {
        label: String,
        tone: Tone,
    },
    Progress {
        value: f64,
        max: f64,
        ratio: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Callout {
        callout_kind: CalloutKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        body: String,
    },
    Table {
        columns: Vec<ResolvedTableColumn>,
        rows: Vec<ResolvedTableRow>,
    },
    Slider {
        bind: String,
        label: String,
        value: f64,
        min: f64,
        max: f64,
        step: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Switch {
        bind: String,
        label: String,
        checked: bool,
    },
    Select {
        bind: String,
        label: String,
        selected: String,
        options: Vec<ResolvedSelectOption>,
    },
    Chart(ResolvedChart),
    Diagram {
        source: String,
    },
    Canvas {
        data: String,
    },
    CodeBlock {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
}
