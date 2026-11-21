use indexmap::IndexMap;

use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::cap_width;
use crate::error::PeleError;
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::resolve_style;
use crate::text::label::{Label, layout_label};
use crate::util::url::linked;
use crate::util::yaml::YamlValue;
use crate::{LinkInfo, Rendered};

use super::axis::{auto_ticks, interval_ticks, time_format};
use super::dates::{DurationUnit, add, add_days, end_of_day, start_of_day};
use super::db::{GanttDb, clock};
use super::types::GanttTask;

const WIDTH: f64 = 800.0;
const MIN_PLOT: f64 = 240.0;
const LABEL_GAP: f64 = 8.0;

fn setting(config: &DiagramConfig, key: &str, min: f64, max: f64) -> Option<f64> {
    let val = config.section("gantt")?.get(key)?.as_f64()?;
    val.is_finite().then(|| val.clamp(min, max))
}

fn text_cfg<'a>(config: &'a DiagramConfig, key: &str) -> Option<&'a str> {
    config.section("gantt")?.get(key)?.as_str()
}

fn flag_cfg(config: &DiagramConfig, key: &str) -> bool {
    config.section("gantt").and_then(|s| s.get(key)).and_then(YamlValue::as_bool) == Some(true)
}

fn strip_br_tags(raw: &str) -> String {
    if !raw.contains('<') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && i + 3 <= bytes.len() && bytes[i + 1..i + 3].eq_ignore_ascii_case(b"br") {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if bytes.get(j) == Some(&b'/') {
                j += 1;
            }
            if bytes.get(j) == Some(&b'>') {
                out.push(' ');
                i = j + 1;
                continue;
            }
        }
        let ch = raw[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn one_line(raw: &str, measurer: &dyn TextMeasurer, size: f64) -> Label {
    let cleaned = strip_br_tags(raw);
    let label = layout_label(Some(&cleaned), false, measurer, size, 4000.0, TextStyle::NONE, None, None);
    if label.lines.len() <= 1 {
        return label;
    }
    Label {
        lines: vec![label.lines[0].clone()],
        widths: vec![label.widths[0]],
        width: label.widths[0],
        height: label.line_height,
        size: label.size,
        line_height: label.line_height,
        heights: None,
    }
}

fn scheduled(task: &GanttTask) -> bool {
    task.start_time.is_some() && task.end_time.is_some()
}

fn pack_rows(task_indices: &[usize], tasks: &[GanttTask], offset: usize, row_of: &mut [Option<usize>]) -> usize {
    let mut sorted: Vec<usize> = task_indices.iter().copied().filter(|&i| scheduled(&tasks[i])).collect();
    sorted.sort_by_key(|&i| (tasks[i].start_time.unwrap(), tasks[i].order));
    let mut free: Vec<i64> = Vec::new();
    for idx in sorted {
        let st = tasks[idx].start_time.unwrap();
        let et = tasks[idx].end_time.unwrap();
        let mut row = 0;
        while row < free.len() && st < free[row] {
            row += 1;
        }
        if row == free.len() {
            free.push(et);
        } else {
            free[row] = et;
        }
        row_of[idx] = Some(offset + row);
    }
    let mut rows = free.len();
    for &idx in task_indices {
        if row_of[idx].is_none() {
            row_of[idx] = Some(offset + rows);
            rows += 1;
        }
    }
    rows.max(1)
}

struct Bar {
    task_idx: usize,
    label: Label,
    row: usize,
    x0: f64,
    x1: f64,
    label_x: f64,
    inside: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskState {
    Normal,
    Active,
    Done,
}

pub fn render_gantt(model: &GanttDb, ctx: &RenderContext<'_>) -> Rendered {
    try_render_gantt(model, ctx).unwrap_or_else(|_| empty_gantt(model, ctx))
}

fn empty_gantt(model: &GanttDb, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let pad = ctx.options.padding.unwrap_or(8.0);
    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, None, None);
    let width = (title.width.max(1.0) + 2.0 * pad).ceil();
    let height = (title.height.max(1.0) + 2.0 * pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None);
    let svg = svg_document(
        "gantt",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    }
}

pub fn try_render_gantt(model: &GanttDb, ctx: &RenderContext<'_>) -> Result<Rendered, PeleError> {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let pad = ctx.options.padding.unwrap_or(8.0);
    let now = clock(ctx.options.now_ms);

    let label_size = setting(ctx.config, "fontSize", 4.0, 72.0).unwrap_or_else(|| (size * 0.8125).round());
    let section_size = setting(ctx.config, "sectionFontSize", 4.0, 72.0).unwrap_or(label_size);
    let tick_size = (size * 0.75).round();
    let bar_height = setting(ctx.config, "barHeight", 4.0, 400.0).unwrap_or_else(|| (label_size * 1.85).round());
    let bar_gap = setting(ctx.config, "barGap", 0.0, 400.0).unwrap_or_else(|| (bar_height / 4.0).round());
    let row_height = bar_height + bar_gap;
    let section_styles = setting(ctx.config, "numberSectionStyles", 1.0, 1000.0).unwrap_or(4.0).round() as usize;
    let compact = model.display_mode == "compact";
    let top_axis = model.top_axis || flag_cfg(ctx.config, "topAxis");

    let mut sched = model.schedule(Some(now))?;
    let task_count = sched.tasks.len();
    let row_task_indices: Vec<usize> = (0..task_count).filter(|&i| !sched.tasks[i].vert).collect();
    let vert_indices: Vec<usize> = (0..task_count).filter(|&i| sched.tasks[i].vert && scheduled(&sched.tasks[i])).collect();

    let mut categories: IndexMap<String, usize> = IndexMap::new();
    for &idx in &row_task_indices {
        let sec = &sched.tasks[idx].section;
        if !categories.contains_key(sec) {
            let next = categories.len();
            categories.insert(sec.clone(), next);
        }
    }

    let mut row_of: Vec<Option<usize>> = vec![None; task_count];
    let mut row_section: Vec<String> = Vec::new();
    if compact {
        let mut groups: IndexMap<String, Vec<usize>> = IndexMap::new();
        for &idx in &row_task_indices {
            groups.entry(sched.tasks[idx].section.clone()).or_default().push(idx);
        }
        for (sec, group) in &groups {
            let rows = pack_rows(group, &sched.tasks, row_section.len(), &mut row_of);
            for _ in 0..rows {
                row_section.push(sec.clone());
            }
        }
    } else {
        for &idx in &row_task_indices {
            row_of[idx] = Some(row_section.len());
            row_section.push(sched.tasks[idx].section.clone());
        }
    }
    let row_count = row_section.len();

    let mut start_opt: Option<i64> = None;
    let mut stop_opt: Option<i64> = None;
    for task in &sched.tasks {
        if let (Some(st), Some(et)) = (task.start_time, task.end_time) {
            start_opt = Some(start_opt.map_or(st, |cur| cur.min(st)));
            stop_opt = Some(stop_opt.map_or(et, |cur| cur.max(et)));
        }
    }

    let (Some(start), Some(stop)) = (start_opt, stop_opt) else {
        return Ok(empty_gantt(model, ctx));
    };
    if start > stop {
        return Ok(empty_gantt(model, ctx));
    }

    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, None, None);
    let title_height = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };

    let mut section_labels: IndexMap<String, Label> = IndexMap::new();
    let mut section_width = 0.0f64;
    for sec in categories.keys() {
        let label = layout_label(Some(sec), false, ctx.measurer, section_size, 180.0, TextStyle::NONE, ctx.icons, None);
        section_width = section_width.max(label.width);
        section_labels.insert(sec.clone(), label);
    }

    let axis_format: &str = if !model.axis_format.is_empty() {
        &model.axis_format
    } else if model.date_format == "D" {
        "%d"
    } else {
        text_cfg(ctx.config, "axisFormat").unwrap_or("%Y-%m-%d")
    };
    let tick_label = |t: i64| time_format(axis_format, t);
    let sample_width =
        ctx.measurer
            .width(&tick_label(start), tick_size, TextStyle::NONE)
            .max(ctx.measurer.width(&tick_label(stop), tick_size, TextStyle::NONE));

    let left = pad
        + setting(ctx.config, "leftPadding", 0.0, 2000.0)
            .unwrap_or_else(|| (if section_width > 0.0 { section_width + 24.0 } else { 0.0 }).max(sample_width / 2.0));
    let right_padding = setting(ctx.config, "rightPadding", 0.0, 2000.0).unwrap_or_else(|| 16.0f64.max(sample_width / 2.0));
    let target = cap_width(ctx.options, setting(ctx.config, "useWidth", 100.0, 20_000.0).unwrap_or(WIDTH), 280.0, 0.0);
    let plot_width = MIN_PLOT.max(target - left - right_padding - pad);
    let right = left + plot_width;
    let scale = if stop > start { plot_width / (stop as f64 - start as f64) } else { 0.0 };
    let x_of = |t: i64| -> f64 {
        if scale == 0.0 {
            left + plot_width / 2.0
        } else {
            left + (t as f64 - start as f64) * scale
        }
    };

    let tick_height = (tick_size * 1.75).round();
    let top_padding = setting(ctx.config, "topPadding", 0.0, 2000.0);
    let grid_start = setting(ctx.config, "gridLineStartPadding", 0.0, 2000.0);
    let head_height = pad + title_height + if top_axis { tick_height } else { 0.0 };
    let plot_top = head_height.max(top_padding.unwrap_or(0.0));
    let grid_lead = match (top_padding, grid_start) {
        (Some(tp), Some(gs)) => 0.0f64.max((tp - gs).min(plot_top - head_height)),
        _ => 0.0,
    };
    let plot_height = row_count.max(1) as f64 * row_height;
    let plot_bottom = plot_top + plot_height;

    let mut bars: Vec<Bar> = Vec::with_capacity(row_task_indices.len());
    let mut extent = right + right_padding;
    for &idx in &row_task_indices {
        let task = &sched.tasks[idx];
        let label = one_line(&task.task, ctx.measurer, label_size);
        let row = row_of[idx].unwrap_or(0);
        if !scheduled(task) {
            let label_x = left + LABEL_GAP + label.width / 2.0;
            extent = extent.max(label_x + label.width / 2.0);
            bars.push(Bar {
                task_idx: idx,
                label,
                row,
                x0: f64::NAN,
                x1: f64::NAN,
                label_x,
                inside: false,
            });
            continue;
        }
        let st = task.start_time.unwrap();
        let et = task.end_time.unwrap();
        let render_end = task.render_end_time.unwrap_or(et);
        let mut x0 = x_of(st);
        let mut x1 = x_of(render_end).max(x0 + if task.milestone { 0.0 } else { 2.0 });
        if task.milestone {
            let mid = x0 + (x_of(et) - x0) / 2.0;
            x0 = mid - bar_height / 2.0;
            x1 = mid + bar_height / 2.0;
        }
        let inside = !task.milestone && label.width + 2.0 * LABEL_GAP <= x1 - x0;
        let mut label_x = (x0 + x1) / 2.0;
        if !inside {
            let fits_right = x1 + LABEL_GAP + label.width <= right + right_padding;
            let fits_left = x0 - LABEL_GAP - label.width >= left;
            label_x = if fits_right || !fits_left {
                x1 + LABEL_GAP + label.width / 2.0
            } else {
                x0 - LABEL_GAP - label.width / 2.0
            };
            extent = extent.max(label_x + label.width / 2.0);
        }
        bars.push(Bar {
            task_idx: idx,
            label,
            row,
            x0,
            x1,
            label_x,
            inside,
        });
    }

    let interval = model
        .tick_interval
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| text_cfg(ctx.config, "tickInterval"))
        .unwrap_or("");
    let weekday = model.weekday.as_deref().or_else(|| text_cfg(ctx.config, "weekday")).unwrap_or("sunday");
    let count = ((plot_width / (sample_width + 24.0)).floor() as isize).clamp(2, 10) as usize;
    let tick_limit = (plot_width / 3.0).ceil().max(1.0) as usize;
    let ticks = interval_ticks(interval, weekday, start, stop, tick_limit).unwrap_or_else(|| auto_ticks(start, stop, count));

    let mut grid = String::new();
    let mut axis_bottom = String::new();
    let mut axis_top = String::new();
    let mut last_right = f64::NEG_INFINITY;
    let mut last_label = String::new();
    let bottom_y = plot_bottom + tick_height / 2.0 + 2.0;
    let top_y = plot_top - grid_lead - tick_height / 2.0 - 2.0;
    for t in ticks {
        let tx = x_of(t);
        grid.push_str(&format!("M{},{}V{}", num(tx), num(plot_top - grid_lead), num(plot_bottom)));
        let label = tick_label(t);
        let w = ctx.measurer.width(&label, tick_size, TextStyle::NONE);
        if tx - w / 2.0 < last_right + 8.0 || label == last_label {
            continue;
        }
        last_right = tx + w / 2.0;
        last_label = label.clone();
        extent = extent.max(last_right);
        let escaped = esc(&label);
        axis_bottom.push_str(&format!(
            r#"<text x="{}" y="{}" text-anchor="middle">{escaped}</text>"#,
            num(tx),
            num(bottom_y + tick_size * 0.35),
        ));
        if top_axis {
            axis_top.push_str(&format!(
                r#"<text x="{}" y="{}" text-anchor="middle">{escaped}</text>"#,
                num(tx),
                num(top_y + tick_size * 0.35),
            ));
        }
    }

    let mut sorted_verts = vert_indices;
    sorted_verts.sort_by_key(|&i| sched.tasks[i].start_time.unwrap());
    let mut vert_lines = String::new();
    let mut vert_labels = String::new();
    let mut vert_ends: Vec<f64> = Vec::new();
    let vert_top = plot_bottom + tick_height + 4.0;
    let vert_line = (label_size * 1.5).round();
    for idx in sorted_verts {
        let task = &sched.tasks[idx];
        let vx = x_of(task.start_time.unwrap());
        let label = one_line(&task.task, ctx.measurer, label_size);
        let cx = (pad + label.width / 2.0).max(vx);
        let mut line = 0;
        while line < vert_ends.len() && cx - label.width / 2.0 < vert_ends[line] + 8.0 {
            line += 1;
        }
        let end_x = cx + label.width / 2.0;
        if line == vert_ends.len() {
            vert_ends.push(end_x);
        } else {
            vert_ends[line] = end_x;
        }
        extent = extent.max(end_x);
        let id_esc = esc_text(&task.id);
        vert_lines.push_str(&format!(
            r#"<path class="pele-vert" data-id="{id_esc}" d="M{},{}V{}"/>"#,
            num(vx),
            num(plot_top - grid_lead),
            num(plot_bottom),
        ));
        vert_labels.push_str(&label_svg(
            &label,
            cx,
            vert_top + line as f64 * vert_line + vert_line / 2.0,
            &format!(r#" class="pele-vert-label" data-id="{id_esc}""#),
            ctx.theme,
            None,
        ));
    }

    let width = (extent.max(pad + title.width) + pad).ceil();
    let height = (plot_bottom
        + tick_height
        + if vert_ends.is_empty() {
            0.0
        } else {
            4.0 + vert_ends.len() as f64 * vert_line
        }
        + pad)
        .ceil();

    let mut bands = String::new();
    let mut section_out = String::new();
    let mut row = 0;
    while row < row_count {
        let section = &row_section[row];
        let mut end = row + 1;
        while end < row_count && &row_section[end] == section {
            end += 1;
        }
        let index = categories[section] % section_styles;
        let y = plot_top + row as f64 * row_height;
        let h = (end - row) as f64 * row_height;
        if categories.len() > 1 || !section.is_empty() {
            let fill = if index.is_multiple_of(2) { ctx.theme.surface() } else { "none" };
            bands.push_str(&format!(
                r#"<rect class="pele-section pele-section-{index}" x="0" y="{}" width="{}" height="{}" fill="{fill}"/>"#,
                num(y),
                num(width),
                num(h),
            ));
        }
        if let Some(label) = section_labels.get(section) {
            section_out.push_str(&label_svg(
                label,
                pad + 8.0 + label.width / 2.0,
                y + h / 2.0,
                &format!(r#" class="pele-section-label" data-id="{}""#, esc_text(section)),
                ctx.theme,
                ctx.icons,
            ));
        }
        row = end;
    }

    let mut excluded = String::new();
    if (!model.excludes.is_empty() || !model.includes.is_empty()) && add(start, 6.0, DurationUnit::Y).is_some_and(|lim| lim > stop) {
        let mut from: Option<i64> = None;
        let mut to: Option<i64> = None;
        let flush = |from: &mut Option<i64>, to: &mut Option<i64>, excluded: &mut String| {
            let (Some(f), Some(t)) = (*from, *to) else { return };
            let ex0 = left.max(x_of(start_of_day(f)));
            let ex1 = right.min(x_of(end_of_day(t)));
            if ex1 > ex0 {
                excluded.push_str(&format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}"/>"#,
                    num(ex0),
                    num(plot_top),
                    num(ex1 - ex0),
                    num(plot_height),
                ));
            }
            *from = None;
            *to = None;
        };
        let mut day_opt = Some(start);
        while let Some(day) = day_opt {
            if day > stop {
                break;
            }
            if sched.is_invalid_date(day)? {
                if from.is_none() {
                    from = Some(day);
                }
                to = Some(day);
            } else {
                flush(&mut from, &mut to, &mut excluded);
            }
            day_opt = add_days(day, 1);
        }
        flush(&mut from, &mut to, &mut excluded);
    }

    let rounded = ctx.theme.rounded_standalone();
    let mut links: Vec<LinkInfo> = Vec::new();
    let mut tasks_out = String::new();
    for bar in &bars {
        let task = &sched.tasks[bar.task_idx];
        let cy = plot_top + bar.row as f64 * row_height + row_height / 2.0;
        let state = if task.active {
            TaskState::Active
        } else if task.done {
            TaskState::Done
        } else {
            TaskState::Normal
        };
        let mut classes = String::from("pele-task");
        match state {
            TaskState::Active => classes.push_str(" pele-active"),
            TaskState::Done => classes.push_str(" pele-done"),
            TaskState::Normal => {}
        }
        if task.crit {
            classes.push_str(" pele-crit");
        }
        if task.milestone {
            classes.push_str(" pele-milestone");
        }
        if task.classes.iter().any(|c| c == "clickable") {
            classes.push_str(" pele-clickable");
        }

        let shape: String;
        let text_fill: String;
        if bar.x0.is_nan() {
            classes.push_str(" pele-unscheduled");
            shape = String::new();
            text_fill = format!(r#" fill="{}""#, ctx.theme.muted());
        } else {
            let color = if task.crit { ctx.theme.critical() } else { ctx.theme.accent() };
            let paint = match state {
                TaskState::Done => format!(r#"fill="{}""#, ctx.theme.surface_alt()),
                TaskState::Active => format!(r#"fill="{color}" fill-opacity="0.25""#),
                TaskState::Normal => format!(r#"fill="{color}""#),
            };
            let stroke = format!(
                r#"stroke="{}""#,
                if state == TaskState::Done && !task.crit { ctx.theme.border() } else { color },
            );
            if task.milestone {
                let cx = (bar.x0 + bar.x1) / 2.0;
                let r = bar_height / 2.0;
                shape = format!(
                    r#"<path d="M{},{}L{},{}L{},{}L{},{}Z" {paint} {stroke} stroke-linejoin="round"/>"#,
                    num(cx),
                    num(cy - r),
                    num(cx + r),
                    num(cy),
                    num(cx),
                    num(cy + r),
                    num(cx - r),
                    num(cy),
                );
            } else {
                shape = format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" {paint} {stroke}{rounded}/>"#,
                    num(bar.x0),
                    num(cy - bar_height / 2.0),
                    num(bar.x1 - bar.x0),
                    num(bar_height),
                );
            }
            text_fill = if bar.inside {
                if state == TaskState::Normal {
                    format!(r#" fill="{}""#, ctx.theme.bg())
                } else {
                    String::new()
                }
            } else if state == TaskState::Done {
                format!(r#" fill="{}""#, ctx.theme.muted())
            } else {
                String::new()
            };
        }

        let mut body = format!(
            "{shape}{}",
            label_svg(&bar.label, bar.label_x, cy, &format!(r#" class="pele-label"{text_fill}"#), ctx.theme, None),
        );
        if let Some(url) = model.links.get(&task.id) {
            body = linked(&body, url, &task.id, &mut links, ctx.options, "");
        }
        tasks_out.push_str(&format!(r#"<g class="{classes}" data-id="{}">{body}</g>"#, esc_text(&task.id)));
    }

    let mut today = String::new();
    if model.today_marker != "off" && now >= start && now <= stop && stop > start {
        let tx = x_of(now);
        let top = plot_top - grid_lead;
        let style = if model.today_marker.is_empty() {
            String::new()
        } else {
            let decls: Vec<String> = model.today_marker.split(',').map(str::to_string).collect();
            resolve_style(&decls).line
        };
        let cap = if style.is_empty() {
            format!(
                r#"<path d="M{},{}H{}L{},{}Z" fill="{}"/>"#,
                num(tx - 4.0),
                num(top - 5.0),
                num(tx + 4.0),
                num(tx),
                num(top + 1.0),
                ctx.theme.accent(),
            )
        } else {
            String::new()
        };
        today = format!(
            r#"<g class="pele-today"><path d="M{},{}V{}" fill="none" stroke="{}" stroke-width="2"{style}/>{cap}</g>"#,
            num(tx),
            num(top),
            num(plot_bottom),
            ctx.theme.accent(),
        );
    }

    let mut axis_line = format!("M{},{}H{}", num(left), num(plot_bottom), num(right));
    if top_axis {
        axis_line.push_str(&format!("M{},{}H{}", num(left), num(plot_top - grid_lead), num(right)));
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None);
    if !bands.is_empty() {
        content.push_str(&format!(r#"<g class="pele-sections">{bands}</g>"#));
    }
    if !excluded.is_empty() {
        content.push_str(&format!(r#"<g class="pele-excluded" fill="{}">{excluded}</g>"#, ctx.theme.surface_alt()));
    }
    content.push_str(&format!(
        r#"<g class="pele-grid" fill="none"><path d="{grid}" stroke="{}" stroke-dasharray="1 3"/><path d="{axis_line}" stroke="{}"/></g>"#,
        ctx.theme.border(),
        ctx.theme.border(),
    ));
    if !vert_lines.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-verts" fill="none" stroke="{}" stroke-width="1.5" stroke-dasharray="4 3">{vert_lines}</g>"#,
            ctx.theme.line(),
        ));
    }
    content.push_str(&today);
    content.push_str(&format!(r#"<g class="pele-tasks" font-size="{}">{tasks_out}</g>"#, num(label_size)));
    content.push_str(&format!(
        r#"<g class="pele-section-labels" font-size="{}">{section_out}</g>"#,
        num(section_size),
    ));
    content.push_str(&format!(
        r#"<g class="pele-axis" font-size="{}" fill="{}">{axis_bottom}{axis_top}</g>"#,
        num(tick_size),
        ctx.theme.muted(),
    ));
    if !vert_labels.is_empty() {
        content.push_str(&format!(r#"<g class="pele-vert-labels" font-size="{}">{vert_labels}</g>"#, num(label_size)));
    }

    let svg = svg_document(
        "gantt",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Ok(Rendered { svg, width, height, links })
}
