use crate::color::canonical_hex;
use crate::measure::{TextMeasurer, truncate_text, wrap_text};
use crate::scale::NumericScale;
use crate::spec::{Annotation, AxisSpec, ChartSpec, LegendPosition, ValueAxisSide, XRef};
use crate::svg::{DominantBaseline, Paint, SvgBuilder, TextAnchor, TextStyle};
use crate::theme::PaintTokens;

pub const PAD_X: f64 = 20.0;
pub const PAD_TOP: f64 = 18.0;
pub const PAD_BOTTOM: f64 = 18.0;
pub const TITLE_FONT: f64 = 15.0;
pub const SUBTITLE_FONT: f64 = 11.5;
pub const AXIS_TITLE_FONT: f64 = 11.5;
pub const TICK_FONT: f64 = 10.5;
pub const LEGEND_FONT: f64 = 11.0;
pub const DATA_LABEL_FONT: f64 = 10.0;

/// Shared rendering context threaded across chart renderers and layout helpers.
#[derive(Clone, Copy)]
pub struct DrawCtx<'a> {
    pub width: f64,
    pub height: f64,
    pub tokens: &'a PaintTokens,
    pub measurer: &'a dyn TextMeasurer,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn right(self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(self) -> f64 {
        self.y + self.height
    }

    pub fn center_x(self) -> f64 {
        self.x + self.width * 0.5
    }

    pub fn center_y(self) -> f64 {
        self.y + self.height * 0.5
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegendSwatch {
    Square,
    Line,
    Circle,
}

#[derive(Debug, Clone)]
pub struct LegendItem {
    pub label: String,
    pub color: String,
    pub swatch: LegendSwatch,
    pub dashed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedLegend {
    Top,
    Bottom,
    Right,
    None,
}

pub fn resolve_legend_position(requested: LegendPosition, item_count: usize, default_auto: ResolvedLegend) -> ResolvedLegend {
    if item_count == 0 {
        return ResolvedLegend::None;
    }
    match requested {
        LegendPosition::Auto => default_auto,
        LegendPosition::Top => ResolvedLegend::Top,
        LegendPosition::Bottom => ResolvedLegend::Bottom,
        LegendPosition::Right => ResolvedLegend::Right,
        LegendPosition::None => ResolvedLegend::None,
    }
}

#[derive(Debug, Clone)]
struct LegendRow {
    items: Vec<PlacedLegendItem>,
    width: f64,
}

#[derive(Debug, Clone)]
struct PlacedLegendItem {
    label: String,
    color: String,
    swatch: LegendSwatch,
    dashed: bool,
    width: f64,
}

#[derive(Debug, Clone)]
pub struct ChromeLayout {
    pub width: f64,
    pub height: f64,
    pub title_lines: Vec<String>,
    pub subtitle_lines: Vec<String>,
    pub title_top: f64,
    pub subtitle_top: f64,
    pub legend_pos: ResolvedLegend,
    legend_rows: Vec<LegendRow>,
    legend_rect: Option<Rect>,
    /// Remaining inner rectangle available for the chart (axes + plot area).
    pub content: Rect,
}

impl ChromeLayout {
    pub fn compute(spec: &ChartSpec, ctx: DrawCtx<'_>, legend_items: &[LegendItem], default_legend: ResolvedLegend) -> Self {
        let usable_w = (ctx.width - PAD_X * 2.0).max(80.0);
        let title_lines = spec
            .title
            .as_deref()
            .map(|t| wrap_text(t, usable_w, TITLE_FONT, true, ctx.measurer))
            .unwrap_or_default();
        let subtitle_lines = spec
            .subtitle
            .as_deref()
            .map(|t| wrap_text(t, usable_w, SUBTITLE_FONT, false, ctx.measurer))
            .unwrap_or_default();

        let title_lh = TITLE_FONT * 1.32;
        let sub_lh = SUBTITLE_FONT * 1.32;

        let mut cursor_y = PAD_TOP;
        let title_top = cursor_y;
        if !title_lines.is_empty() {
            cursor_y += title_lines.len() as f64 * title_lh;
        }
        let subtitle_top = cursor_y + if !title_lines.is_empty() { 2.0 } else { 0.0 };
        if !subtitle_lines.is_empty() {
            cursor_y = subtitle_top + subtitle_lines.len() as f64 * sub_lh;
        }
        if !title_lines.is_empty() || !subtitle_lines.is_empty() {
            cursor_y += 10.0;
        }

        let legend_pos = resolve_legend_position(spec.legend, legend_items.len(), default_legend);
        let mut content_y = cursor_y;
        let mut content_w = usable_w;
        let mut content_bottom = ctx.height - PAD_BOTTOM;

        let mut legend_rows = Vec::new();
        let mut legend_rect = None;
        let row_h = LEGEND_FONT * 1.55;

        match legend_pos {
            ResolvedLegend::None => {}
            ResolvedLegend::Top => {
                legend_rows = pack_horizontal_legend(legend_items, usable_w, ctx.measurer);
                let lh = legend_rows.len() as f64 * row_h;
                legend_rect = Some(Rect {
                    x: PAD_X,
                    y: content_y,
                    width: usable_w,
                    height: lh,
                });
                content_y += lh + 10.0;
            }
            ResolvedLegend::Bottom => {
                legend_rows = pack_horizontal_legend(legend_items, usable_w, ctx.measurer);
                let lh = legend_rows.len() as f64 * row_h;
                let ly = (content_bottom - lh).max(content_y + 40.0);
                legend_rect = Some(Rect {
                    x: PAD_X,
                    y: ly,
                    width: usable_w,
                    height: lh,
                });
                content_bottom = ly - 10.0;
            }
            ResolvedLegend::Right => {
                let max_legend_w = (usable_w * 0.30).clamp(84.0, 190.0);
                let mut longest = 0.0_f64;
                for item in legend_items {
                    let trunc = truncate_text(&item.label, max_legend_w - 22.0, LEGEND_FONT, false, ctx.measurer);
                    let w = 18.0 + ctx.measurer.measure(&trunc, LEGEND_FONT, false).width;
                    longest = longest.max(w);
                    legend_rows.push(LegendRow {
                        items: vec![PlacedLegendItem {
                            label: trunc,
                            color: item.color.clone(),
                            swatch: item.swatch,
                            dashed: item.dashed,
                            width: w,
                        }],
                        width: w,
                    });
                }
                let col_w = longest.min(max_legend_w);
                let gap = 14.0;
                content_w = (usable_w - col_w - gap).max(120.0);
                let total_h = legend_rows.len() as f64 * row_h;
                let avail_h = (content_bottom - content_y).max(row_h);
                let start_y = content_y + ((avail_h - total_h).max(0.0) * 0.25);
                legend_rect = Some(Rect {
                    x: PAD_X + content_w + gap,
                    y: start_y,
                    width: col_w,
                    height: total_h,
                });
            }
        }

        if content_bottom < content_y + 32.0 {
            content_bottom = content_y + 32.0;
        }

        Self {
            width: ctx.width,
            height: ctx.height,
            title_lines,
            subtitle_lines,
            title_top,
            subtitle_top,
            legend_pos,
            legend_rows,
            legend_rect,
            content: Rect {
                x: PAD_X,
                y: content_y,
                width: content_w,
                height: (content_bottom - content_y).max(32.0),
            },
        }
    }

    pub fn draw_background(&self, svg: &mut SvgBuilder, tokens: &PaintTokens) {
        svg.open_group("background");
        svg.rect(
            0.5,
            0.5,
            self.width - 1.0,
            self.height - 1.0,
            Some(8.0),
            Paint::fill(&tokens.background).with_stroke(&tokens.border, 1.0),
        );
        svg.close_group();
    }

    pub fn draw_header(&self, svg: &mut SvgBuilder, tokens: &PaintTokens) {
        if self.title_lines.is_empty() && self.subtitle_lines.is_empty() {
            return;
        }
        svg.open_group("header");
        let title_lh = TITLE_FONT * 1.32;
        for (i, line) in self.title_lines.iter().enumerate() {
            svg.text(
                PAD_X,
                self.title_top + (i as f64) * title_lh + TITLE_FONT * 0.85,
                line,
                TextStyle::new(&tokens.text, TITLE_FONT).bold(true),
            );
        }
        let sub_lh = SUBTITLE_FONT * 1.32;
        for (i, line) in self.subtitle_lines.iter().enumerate() {
            svg.text(
                PAD_X,
                self.subtitle_top + (i as f64) * sub_lh + SUBTITLE_FONT * 0.85,
                line,
                TextStyle::new(&tokens.text_muted, SUBTITLE_FONT),
            );
        }
        svg.close_group();
    }

    pub fn draw_legend(&self, svg: &mut SvgBuilder, tokens: &PaintTokens) {
        let Some(rect) = self.legend_rect else {
            return;
        };
        if self.legend_rows.is_empty() {
            return;
        }
        let row_h = LEGEND_FONT * 1.55;
        let item_gap = 16.0;

        svg.open_group("legend");
        match self.legend_pos {
            ResolvedLegend::Top | ResolvedLegend::Bottom => {
                for (r_idx, row) in self.legend_rows.iter().enumerate() {
                    let cy = rect.y + (r_idx as f64) * row_h + row_h * 0.5;
                    let mut x = match self.legend_pos {
                        ResolvedLegend::Bottom => rect.x + ((rect.width - row.width).max(0.0) * 0.5),
                        ResolvedLegend::Top | ResolvedLegend::Right | ResolvedLegend::None => rect.x,
                    };
                    for item in &row.items {
                        draw_legend_item(svg, x, cy, item, tokens);
                        x += item.width + item_gap;
                    }
                }
            }
            ResolvedLegend::Right => {
                for (r_idx, row) in self.legend_rows.iter().enumerate() {
                    let cy = rect.y + (r_idx as f64) * row_h + row_h * 0.5;
                    if let Some(item) = row.items.first() {
                        draw_legend_item(svg, rect.x, cy, item, tokens);
                    }
                }
            }
            ResolvedLegend::None => {}
        }
        svg.close_group();
    }
}

fn draw_legend_item(svg: &mut SvgBuilder, x: f64, cy: f64, item: &PlacedLegendItem, tokens: &PaintTokens) {
    match item.swatch {
        LegendSwatch::Square => {
            svg.rect(x, cy - 4.5, 9.0, 9.0, Some(2.0), Paint::fill(&item.color));
        }
        LegendSwatch::Circle => {
            svg.circle(x + 4.5, cy, 4.2, Paint::fill(&item.color));
        }
        LegendSwatch::Line => {
            let dash = if item.dashed { Some("4,2") } else { None };
            svg.line(x, cy, x + 12.0, cy, Paint::stroke(&item.color, 2.2).dash(dash));
            svg.circle(x + 6.0, cy, 2.4, Paint::fill(&item.color));
        }
    }
    let text_x = match item.swatch {
        LegendSwatch::Line => x + 17.0,
        LegendSwatch::Square | LegendSwatch::Circle => x + 14.0,
    };
    svg.text(
        text_x,
        cy,
        &item.label,
        TextStyle::new(&tokens.text_muted, LEGEND_FONT).baseline(DominantBaseline::Central),
    );
}

fn pack_horizontal_legend(items: &[LegendItem], max_width: f64, measurer: &dyn TextMeasurer) -> Vec<LegendRow> {
    let item_gap = 16.0;
    let max_item_text = (max_width - 24.0).max(40.0);
    let mut rows: Vec<LegendRow> = Vec::new();
    let mut cur_items: Vec<PlacedLegendItem> = Vec::new();
    let mut cur_w = 0.0_f64;

    for item in items {
        let swatch_w = match item.swatch {
            LegendSwatch::Line => 17.0,
            LegendSwatch::Square | LegendSwatch::Circle => 14.0,
        };
        let label = truncate_text(&item.label, max_item_text, LEGEND_FONT, false, measurer);
        let item_w = swatch_w + measurer.measure(&label, LEGEND_FONT, false).width;

        let next_w = if cur_items.is_empty() { item_w } else { cur_w + item_gap + item_w };

        if !cur_items.is_empty() && next_w > max_width {
            rows.push(LegendRow {
                items: std::mem::take(&mut cur_items),
                width: cur_w,
            });
            cur_w = item_w;
        } else {
            cur_w = next_w;
        }

        cur_items.push(PlacedLegendItem {
            label,
            color: item.color.clone(),
            swatch: item.swatch,
            dashed: item.dashed,
            width: item_w,
        });
    }

    if !cur_items.is_empty() {
        rows.push(LegendRow {
            items: cur_items,
            width: cur_w,
        });
    }
    rows
}

/// Label layout plan for a horizontal category X axis (decides rotation + stride thinning).
#[derive(Debug, Clone)]
pub struct CategoryXPlan {
    pub rotation_deg: Option<f64>,
    pub stride: usize,
    pub label_height: f64,
    pub max_label_px: f64,
}

impl CategoryXPlan {
    pub fn compute(categories: &[String], plot_width: f64, measurer: &dyn TextMeasurer) -> Self {
        let count = categories.len().max(1);
        let slot = (plot_width / count as f64).max(1.0);
        let max_label_px = 132.0_f64;

        let max_w = categories
            .iter()
            .map(|c| measurer.measure(c, TICK_FONT, false).width.min(max_label_px))
            .fold(0.0_f64, f64::max);

        if max_w + 6.0 <= slot {
            return Self {
                rotation_deg: None,
                stride: 1,
                label_height: TICK_FONT * 1.45,
                max_label_px,
            };
        }

        let angle_deg = -38.0_f64;
        let angle_rad = 38.0_f64.to_radians();
        let min_rotated_pitch = TICK_FONT * 1.55 / angle_rad.sin().max(0.5);
        let stride = if slot >= min_rotated_pitch {
            1
        } else {
            (min_rotated_pitch / slot).ceil() as usize
        }
        .max(1);

        let proj_h = (max_w * angle_rad.sin() + TICK_FONT * angle_rad.cos()).clamp(24.0, 96.0);

        Self {
            rotation_deg: Some(angle_deg),
            stride,
            label_height: proj_h,
            max_label_px,
        }
    }
}

/// Axis inputs for Cartesian plot margin sizing.
pub struct CartesianAxes<'a> {
    pub x_axis: &'a AxisSpec,
    pub y_axis: &'a AxisSpec,
    pub y2_axis: Option<&'a AxisSpec>,
    pub y_scale: &'a NumericScale,
    pub y2_scale: Option<&'a NumericScale>,
    pub x_categories: Option<&'a [String]>,
    pub x_scale: Option<&'a NumericScale>,
}

/// Computes plot box inside `content` for standard Cartesian charts.
pub fn compute_cartesian_plot(content: Rect, axes: &CartesianAxes<'_>, measurer: &dyn TextMeasurer) -> (Rect, Option<CategoryXPlan>) {
    let max_y_tick_w = axes
        .y_scale
        .tick_labels
        .iter()
        .map(|s| measurer.measure(s, TICK_FONT, false).width)
        .fold(20.0_f64, f64::max)
        .min(110.0);

    let y_title_w = if axes.y_axis.label.as_deref().is_some_and(|l| !l.is_empty()) {
        AXIS_TITLE_FONT * 1.65
    } else {
        0.0
    };
    let left_margin = max_y_tick_w + 10.0 + y_title_w;

    let right_margin = if let Some(s2) = axes.y2_scale {
        let max_y2_w = s2
            .tick_labels
            .iter()
            .map(|s| measurer.measure(s, TICK_FONT, false).width)
            .fold(20.0_f64, f64::max)
            .min(110.0);
        let y2_title_w = if axes.y2_axis.and_then(|a| a.label.as_deref()).is_some_and(|l| !l.is_empty()) {
            AXIS_TITLE_FONT * 1.65
        } else {
            0.0
        };
        max_y2_w + 10.0 + y2_title_w
    } else {
        12.0
    };

    let plot_w = (content.width - left_margin - right_margin).max(60.0);
    let x_plan = axes.x_categories.map(|cats| CategoryXPlan::compute(cats, plot_w, measurer));
    let x_tick_h = match (&x_plan, axes.x_scale) {
        (Some(plan), _) => plan.label_height + 6.0,
        (None, Some(_)) => TICK_FONT * 1.45 + 6.0,
        (None, None) => 12.0,
    };
    let x_title_h = if axes.x_axis.label.as_deref().is_some_and(|l| !l.is_empty()) {
        AXIS_TITLE_FONT * 1.65
    } else {
        0.0
    };

    let top_pad = 8.0;
    let bottom_margin = x_tick_h + x_title_h;
    let plot_h = (content.height - top_pad - bottom_margin).max(48.0);

    let plot = Rect {
        x: content.x + left_margin,
        y: content.y + top_pad,
        width: plot_w,
        height: plot_h,
    };

    (plot, x_plan)
}

/// Computes plot box for horizontal charts (category labels on Y axis, numeric values on X axis).
pub fn compute_horizontal_plot(content: Rect, x_axis: &AxisSpec, y_axis: &AxisSpec, categories: &[String], measurer: &dyn TextMeasurer) -> (Rect, f64) {
    let max_cat_cap = (content.width * 0.34).clamp(64.0, 170.0);
    let max_cat_w = categories
        .iter()
        .map(|c| measurer.measure(c, TICK_FONT, false).width)
        .fold(24.0_f64, f64::max)
        .min(max_cat_cap);

    let y_title_w = if y_axis.label.as_deref().is_some_and(|l| !l.is_empty()) {
        AXIS_TITLE_FONT * 1.65
    } else {
        0.0
    };
    let left_margin = max_cat_w + 10.0 + y_title_w;
    let right_margin = 24.0;

    let x_tick_h = TICK_FONT * 1.45 + 6.0;
    let x_title_h = if x_axis.label.as_deref().is_some_and(|l| !l.is_empty()) {
        AXIS_TITLE_FONT * 1.65
    } else {
        0.0
    };

    let top_pad = 6.0;
    let plot = Rect {
        x: content.x + left_margin,
        y: content.y + top_pad,
        width: (content.width - left_margin - right_margin).max(60.0),
        height: (content.height - top_pad - x_tick_h - x_title_h).max(48.0),
    };
    (plot, max_cat_cap)
}

pub fn draw_y_gridlines(svg: &mut SvgBuilder, plot: Rect, y_scale: &NumericScale, y_axis: &AxisSpec, tokens: &PaintTokens) {
    if !y_axis.gridlines.unwrap_or(true) {
        return;
    }
    svg.open_group("grid");
    for &tick in &y_scale.ticks {
        let py = y_scale.map(tick, plot.bottom(), plot.y);
        if py < plot.y - 1.0 || py > plot.bottom() + 1.0 {
            continue;
        }
        svg.line(plot.x, py, plot.right(), py, Paint::stroke(&tokens.grid, 1.0));
    }
    svg.close_group();
}

pub fn draw_x_gridlines(svg: &mut SvgBuilder, plot: Rect, x_scale: &NumericScale, x_axis: &AxisSpec, default_on: bool, tokens: &PaintTokens) {
    if !x_axis.gridlines.unwrap_or(default_on) {
        return;
    }
    svg.open_group("grid-x");
    for &tick in &x_scale.ticks {
        let px = x_scale.map(tick, plot.x, plot.right());
        if px < plot.x - 1.0 || px > plot.right() + 1.0 {
            continue;
        }
        svg.line(px, plot.y, px, plot.bottom(), Paint::stroke(&tokens.grid, 1.0));
    }
    svg.close_group();
}

pub fn draw_left_y_axis(svg: &mut SvgBuilder, plot: Rect, content_left: f64, y_scale: &NumericScale, y_axis: &AxisSpec, tokens: &PaintTokens) {
    svg.open_group("y-axis");
    svg.line(plot.x, plot.y, plot.x, plot.bottom(), Paint::stroke(&tokens.axis, 1.0));
    for (tick, label) in y_scale.ticks.iter().zip(y_scale.tick_labels.iter()) {
        let py = y_scale.map(*tick, plot.bottom(), plot.y);
        if py < plot.y - 1.0 || py > plot.bottom() + 1.0 {
            continue;
        }
        svg.line(plot.x - 4.0, py, plot.x, py, Paint::stroke(&tokens.axis, 1.0));
        svg.text(
            plot.x - 7.0,
            py,
            label,
            TextStyle::new(&tokens.text_faint, TICK_FONT)
                .anchor(TextAnchor::End)
                .baseline(DominantBaseline::Central),
        );
    }
    if let Some(title) = y_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            content_left + AXIS_TITLE_FONT * 0.65,
            plot.center_y(),
            title,
            TextStyle::new(&tokens.text_muted, AXIS_TITLE_FONT)
                .anchor(TextAnchor::Middle)
                .baseline(DominantBaseline::Central)
                .rotate(Some(-90.0)),
        );
    }
    svg.close_group();
}

pub fn draw_right_y_axis(svg: &mut SvgBuilder, plot: Rect, content_right: f64, y2_scale: &NumericScale, y2_axis: &AxisSpec, tokens: &PaintTokens) {
    svg.open_group("y2-axis");
    svg.line(plot.right(), plot.y, plot.right(), plot.bottom(), Paint::stroke(&tokens.axis, 1.0));
    for (tick, label) in y2_scale.ticks.iter().zip(y2_scale.tick_labels.iter()) {
        let py = y2_scale.map(*tick, plot.bottom(), plot.y);
        if py < plot.y - 1.0 || py > plot.bottom() + 1.0 {
            continue;
        }
        svg.line(plot.right(), py, plot.right() + 4.0, py, Paint::stroke(&tokens.axis, 1.0));
        svg.text(
            plot.right() + 7.0,
            py,
            label,
            TextStyle::new(&tokens.text_faint, TICK_FONT).baseline(DominantBaseline::Central),
        );
    }
    if let Some(title) = y2_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            content_right - AXIS_TITLE_FONT * 0.65,
            plot.center_y(),
            title,
            TextStyle::new(&tokens.text_muted, AXIS_TITLE_FONT)
                .anchor(TextAnchor::Middle)
                .baseline(DominantBaseline::Central)
                .rotate(Some(90.0)),
        );
    }
    svg.close_group();
}

pub fn draw_category_x_axis(
    svg: &mut SvgBuilder,
    plot: Rect,
    categories: &[String],
    plan: &CategoryXPlan,
    x_axis: &AxisSpec,
    center_in_slot: bool,
    ctx: DrawCtx<'_>,
) {
    svg.open_group("x-axis");
    svg.line(plot.x, plot.bottom(), plot.right(), plot.bottom(), Paint::stroke(&ctx.tokens.axis, 1.0));

    let count = categories.len();
    for (idx, cat) in categories.iter().enumerate() {
        if !idx.is_multiple_of(plan.stride) && idx != count.saturating_sub(1) {
            continue;
        }
        if plan.stride > 1 && idx == count.saturating_sub(1) && !idx.is_multiple_of(plan.stride) && (idx % plan.stride) * 2 < plan.stride {
            continue;
        }

        let px = category_x_center(plot, idx, count, center_in_slot);
        svg.line(px, plot.bottom(), px, plot.bottom() + 4.0, Paint::stroke(&ctx.tokens.axis, 1.0));

        let label = truncate_text(cat, plan.max_label_px, TICK_FONT, false, ctx.measurer);
        match plan.rotation_deg {
            Some(deg) => {
                svg.text(
                    px + 2.0,
                    plot.bottom() + 10.0,
                    &label,
                    TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                        .anchor(TextAnchor::End)
                        .baseline(DominantBaseline::Hanging)
                        .rotate(Some(deg)),
                );
            }
            None => {
                svg.text(
                    px,
                    plot.bottom() + 7.0,
                    &label,
                    TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                        .anchor(TextAnchor::Middle)
                        .baseline(DominantBaseline::Hanging),
                );
            }
        }
    }

    if let Some(title) = x_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            plot.center_x(),
            plot.bottom() + plan.label_height + 16.0,
            title,
            TextStyle::new(&ctx.tokens.text_muted, AXIS_TITLE_FONT).anchor(TextAnchor::Middle),
        );
    }
    svg.close_group();
}

pub fn draw_numeric_x_axis(svg: &mut SvgBuilder, plot: Rect, x_scale: &NumericScale, x_axis: &AxisSpec, ctx: DrawCtx<'_>) {
    svg.open_group("x-axis");
    svg.line(plot.x, plot.bottom(), plot.right(), plot.bottom(), Paint::stroke(&ctx.tokens.axis, 1.0));

    let mut last_right = f64::NEG_INFINITY;
    for (tick, label) in x_scale.ticks.iter().zip(x_scale.tick_labels.iter()) {
        let px = x_scale.map(*tick, plot.x, plot.right());
        if px < plot.x - 1.0 || px > plot.right() + 1.0 {
            continue;
        }
        svg.line(px, plot.bottom(), px, plot.bottom() + 4.0, Paint::stroke(&ctx.tokens.axis, 1.0));
        let w = ctx.measurer.measure(label, TICK_FONT, false).width;
        let left = px - w * 0.5;
        if left >= last_right + 6.0 {
            svg.text(
                px,
                plot.bottom() + 7.0,
                label,
                TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                    .anchor(TextAnchor::Middle)
                    .baseline(DominantBaseline::Hanging),
            );
            last_right = px + w * 0.5;
        }
    }

    if let Some(title) = x_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            plot.center_x(),
            plot.bottom() + TICK_FONT * 1.45 + 18.0,
            title,
            TextStyle::new(&ctx.tokens.text_muted, AXIS_TITLE_FONT).anchor(TextAnchor::Middle),
        );
    }
    svg.close_group();
}

pub fn draw_category_y_axis(
    svg: &mut SvgBuilder,
    plot: Rect,
    content_left: f64,
    categories: &[String],
    max_label_px: f64,
    y_axis: &AxisSpec,
    ctx: DrawCtx<'_>,
) {
    svg.open_group("y-axis");
    svg.line(plot.x, plot.y, plot.x, plot.bottom(), Paint::stroke(&ctx.tokens.axis, 1.0));

    let count = categories.len().max(1);
    let slot_h = plot.height / count as f64;
    for (idx, cat) in categories.iter().enumerate() {
        let cy = plot.y + (idx as f64 + 0.5) * slot_h;
        svg.line(plot.x - 4.0, cy, plot.x, cy, Paint::stroke(&ctx.tokens.axis, 1.0));
        let label = truncate_text(cat, max_label_px, TICK_FONT, false, ctx.measurer);
        svg.text(
            plot.x - 7.0,
            cy,
            &label,
            TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                .anchor(TextAnchor::End)
                .baseline(DominantBaseline::Central),
        );
    }

    if let Some(title) = y_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            content_left + AXIS_TITLE_FONT * 0.65,
            plot.center_y(),
            title,
            TextStyle::new(&ctx.tokens.text_muted, AXIS_TITLE_FONT)
                .anchor(TextAnchor::Middle)
                .baseline(DominantBaseline::Central)
                .rotate(Some(-90.0)),
        );
    }
    svg.close_group();
}

pub fn category_x_center(plot: Rect, idx: usize, count: usize, center_in_slot: bool) -> f64 {
    if count <= 1 {
        return plot.center_x();
    }
    if center_in_slot {
        let slot = plot.width / count as f64;
        plot.x + (idx as f64 + 0.5) * slot
    } else {
        let pad = (plot.width / count as f64) * 0.35;
        let inner = (plot.width - pad * 2.0).max(1.0);
        plot.x + pad + inner * (idx as f64 / (count - 1) as f64)
    }
}

pub enum XAxisMapping<'a> {
    Categories { categories: &'a [String], center_in_slot: bool },
    Numeric(&'a NumericScale),
}

impl XAxisMapping<'_> {
    fn resolve(&self, xref: &XRef, plot: Rect) -> Option<f64> {
        match (self, xref) {
            (XAxisMapping::Categories { categories, center_in_slot }, XRef::Category(name)) => {
                let idx = categories.iter().position(|c| c == name)?;
                Some(category_x_center(plot, idx, categories.len(), *center_in_slot))
            }
            (XAxisMapping::Categories { categories, center_in_slot }, XRef::Number(v)) => {
                if *v < 0.0 || *v >= categories.len() as f64 {
                    return None;
                }
                let idx = v.round() as usize;
                Some(category_x_center(
                    plot,
                    idx.min(categories.len().saturating_sub(1)),
                    categories.len(),
                    *center_in_slot,
                ))
            }
            (XAxisMapping::Numeric(scale), XRef::Number(v)) => Some(scale.map(*v, plot.x, plot.right())),
            (XAxisMapping::Numeric(_), XRef::Category(_)) => None,
        }
    }
}

/// Scales used to map chart annotations onto SVG coordinates.
pub struct AnnotationScales<'a> {
    pub x_map: XAxisMapping<'a>,
    pub y_left: &'a NumericScale,
    pub y_right: Option<&'a NumericScale>,
}

pub fn draw_annotations_back(svg: &mut SvgBuilder, plot: Rect, annotations: &[Annotation], scales: &AnnotationScales<'_>, tokens: &PaintTokens) {
    let has_bands = annotations
        .iter()
        .any(|a| matches!(a, Annotation::HorizontalBand { .. } | Annotation::VerticalBand { .. }));
    if !has_bands {
        return;
    }

    svg.open_group("annotations-back");
    for ann in annotations {
        match ann {
            Annotation::HorizontalBand {
                from,
                to,
                axis,
                label,
                color,
                opacity,
            } => {
                let scale = match axis {
                    ValueAxisSide::Left => scales.y_left,
                    ValueAxisSide::Right => scales.y_right.unwrap_or(scales.y_left),
                };
                let y1 = scale.map(*from, plot.bottom(), plot.y);
                let y2 = scale.map(*to, plot.bottom(), plot.y);
                let top = y1.min(y2).clamp(plot.y, plot.bottom());
                let bot = y1.max(y2).clamp(plot.y, plot.bottom());
                let h = bot - top;
                if h > 0.5 {
                    let fill = resolve_ann_color(color.as_deref(), tokens);
                    svg.rect(plot.x, top, plot.width, h, None, Paint::fill(&fill).fill_opacity(opacity.unwrap_or(0.12)));
                    if let Some(text) = label.as_deref()
                        && !text.is_empty()
                    {
                        svg.text(
                            plot.right() - 6.0,
                            top + 12.0,
                            text,
                            TextStyle::new(&fill, DATA_LABEL_FONT).anchor(TextAnchor::End),
                        );
                    }
                }
            }
            Annotation::VerticalBand {
                from,
                to,
                label,
                color,
                opacity,
            } => {
                if let (Some(x1), Some(x2)) = (scales.x_map.resolve(from, plot), scales.x_map.resolve(to, plot)) {
                    let left = x1.min(x2).clamp(plot.x, plot.right());
                    let right = x1.max(x2).clamp(plot.x, plot.right());
                    let w = right - left;
                    if w > 0.5 {
                        let fill = resolve_ann_color(color.as_deref(), tokens);
                        svg.rect(left, plot.y, w, plot.height, None, Paint::fill(&fill).fill_opacity(opacity.unwrap_or(0.12)));
                        if let Some(text) = label.as_deref()
                            && !text.is_empty()
                        {
                            svg.text(
                                (left + right) * 0.5,
                                plot.y + 12.0,
                                text,
                                TextStyle::new(&fill, DATA_LABEL_FONT).anchor(TextAnchor::Middle),
                            );
                        }
                    }
                }
            }
            Annotation::HorizontalLine { .. } | Annotation::VerticalLine { .. } => {}
        }
    }
    svg.close_group();
}

pub fn draw_annotations_front(svg: &mut SvgBuilder, plot: Rect, annotations: &[Annotation], scales: &AnnotationScales<'_>, ctx: DrawCtx<'_>) {
    let has_lines = annotations
        .iter()
        .any(|a| matches!(a, Annotation::HorizontalLine { .. } | Annotation::VerticalLine { .. }));
    if !has_lines {
        return;
    }

    svg.open_group("annotations-front");
    for ann in annotations {
        match ann {
            Annotation::HorizontalLine {
                value,
                axis,
                label,
                color,
                dashed,
            } => {
                let scale = match axis {
                    ValueAxisSide::Left => scales.y_left,
                    ValueAxisSide::Right => scales.y_right.unwrap_or(scales.y_left),
                };
                let py = scale.map(*value, plot.bottom(), plot.y);
                if py >= plot.y - 1.0 && py <= plot.bottom() + 1.0 {
                    let stroke = resolve_ann_color(color.as_deref(), ctx.tokens);
                    let dash = if *dashed { Some("5,4") } else { None };
                    svg.line(plot.x, py, plot.right(), py, Paint::stroke(&stroke, 1.4).dash(dash));
                    if let Some(text) = label.as_deref()
                        && !text.is_empty()
                    {
                        let tw = ctx.measurer.measure(text, DATA_LABEL_FONT, false).width;
                        let pill_w = tw + 10.0;
                        let pill_h = 16.0;
                        let px = (plot.right() - pill_w - 4.0).max(plot.x + 2.0);
                        let ly = if py - pill_h - 3.0 >= plot.y { py - pill_h - 3.0 } else { py + 3.0 };
                        svg.rect(
                            px,
                            ly,
                            pill_w,
                            pill_h,
                            Some(3.0),
                            Paint::fill(&ctx.tokens.background).fill_opacity(0.92).with_stroke(&stroke, 0.8),
                        );
                        svg.text(
                            px + pill_w * 0.5,
                            ly + pill_h * 0.5,
                            text,
                            TextStyle::new(&stroke, DATA_LABEL_FONT)
                                .anchor(TextAnchor::Middle)
                                .baseline(DominantBaseline::Central),
                        );
                    }
                }
            }
            Annotation::VerticalLine { value, label, color, dashed } => {
                if let Some(px) = scales.x_map.resolve(value, plot)
                    && px >= plot.x - 1.0
                    && px <= plot.right() + 1.0
                {
                    let stroke = resolve_ann_color(color.as_deref(), ctx.tokens);
                    let dash = if *dashed { Some("5,4") } else { None };
                    svg.line(px, plot.y, px, plot.bottom(), Paint::stroke(&stroke, 1.4).dash(dash));
                    if let Some(text) = label.as_deref()
                        && !text.is_empty()
                    {
                        let tw = ctx.measurer.measure(text, DATA_LABEL_FONT, false).width;
                        let pill_w = tw + 10.0;
                        let pill_h = 16.0;
                        let bx = (px - pill_w * 0.5).clamp(plot.x + 2.0, (plot.right() - pill_w - 2.0).max(plot.x + 2.0));
                        let by = plot.y + 4.0;
                        svg.rect(
                            bx,
                            by,
                            pill_w,
                            pill_h,
                            Some(3.0),
                            Paint::fill(&ctx.tokens.background).fill_opacity(0.92).with_stroke(&stroke, 0.8),
                        );
                        svg.text(
                            bx + pill_w * 0.5,
                            by + pill_h * 0.5,
                            text,
                            TextStyle::new(&stroke, DATA_LABEL_FONT)
                                .anchor(TextAnchor::Middle)
                                .baseline(DominantBaseline::Central),
                        );
                    }
                }
            }
            Annotation::HorizontalBand { .. } | Annotation::VerticalBand { .. } => {}
        }
    }
    svg.close_group();
}

fn resolve_ann_color(explicit: Option<&str>, tokens: &PaintTokens) -> String {
    match explicit {
        Some(c) => canonical_hex(c).unwrap_or_else(|| c.trim().to_string()),
        None => tokens.annotation.clone(),
    }
}
