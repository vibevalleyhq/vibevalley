use std::collections::HashMap;

use crate::diagram::RenderContext;
use crate::diagram::common::{tighten, title_room};
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::edges::{edge_label_svg, marker, marker_trim};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::SvgTheme;
use crate::text::label::{Label, Span, layout_label};
use crate::util::yaml::YamlValue;
use crate::{IconResolver, Rendered};

use super::db::{ArchNode, ArchitectureDb};
use super::icons::builtin_icon;
use super::layout::{place_on_grid, side_index};

const STUB: f64 = 12.0;
const CORNER: f64 = 6.0;
const LABEL_GAP: f64 = 4.0;
const DOT: f64 = 3.0;
const DX: [f64; 4] = [-1.0, 1.0, 0.0, 0.0];
const DY: [f64; 4] = [0.0, 0.0, -1.0, 1.0];

fn setting(ctx: &RenderContext<'_>, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let val = ctx.config.section("architecture").and_then(|s| s.get(key)).and_then(YamlValue::as_f64);
    match val {
        Some(v) if v.is_finite() => v.clamp(min, max),
        _ => fallback,
    }
}

/// Maps the grid lines in use to consecutive indexes, so empty rows and columns take no room.
fn rank(mut values: Vec<i32>) -> HashMap<i32, usize> {
    values.sort_unstable();
    let mut out: HashMap<i32, usize> = HashMap::new();
    for value in values {
        let next = out.len();
        out.entry(value).or_insert(next);
    }
    out
}

fn icon_slot(name: &str, x: f64, y: f64, side: f64, theme: &SvgTheme, icons: Option<&IconResolver<'_>>) -> String {
    let inner = icons.and_then(|f| f(name)).unwrap_or_else(|| builtin_icon(name, theme));
    format!(
        r#"<svg class="pele-icon" data-icon="{}" x="{}" y="{}" width="{}" height="{}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>"#,
        esc_text(name),
        num(x),
        num(y),
        num(side),
        num(side),
    )
}

/// Cuts a label down to a box, ending what is left with an ellipsis.
fn fit(label: &Label, max_width: f64, max_lines: usize, measurer: &dyn TextMeasurer) -> Label {
    let cut = label.lines.len() > max_lines;
    if !cut && label.width <= max_width {
        return label.clone();
    }
    let dots = measurer.width("…", label.size, TextStyle::NONE);
    let mut lines: Vec<Vec<Span>> = Vec::new();
    let mut widths: Vec<f64> = Vec::new();
    let mut widest = 0.0f64;
    let take = max_lines.min(label.lines.len());
    for i in 0..take {
        let mut line = label.lines[i].clone();
        let mut width = label.widths[i];
        if width > max_width || (cut && i == max_lines - 1) {
            loop {
                let Some(last) = line.last_mut() else {
                    line.push(Span::plain("…".to_string(), TextStyle::NONE, dots));
                    width = dots;
                    break;
                };
                let rest = width - last.width;
                if last.icon.is_none() && rest + dots < max_width {
                    let chars: Vec<char> = last.text.chars().collect();
                    let mut lo = 0usize;
                    let mut hi = chars.len();
                    while lo < hi {
                        let mid = (lo + hi + 1) >> 1;
                        let prefix: String = chars[..mid].iter().collect();
                        if rest + measurer.width(&prefix, label.size, last.style) + dots <= max_width {
                            lo = mid;
                        } else {
                            hi = mid - 1;
                        }
                    }
                    let prefix: String = chars[..lo].iter().collect();
                    let trimmed = format!("{}…", prefix.trim_end());
                    let w = measurer.width(&trimmed, label.size, last.style);
                    last.text = trimmed;
                    last.width = w;
                    width = rest + w;
                    break;
                }
                line.pop();
                width = rest;
            }
        }
        lines.push(line);
        widths.push(width);
        widest = widest.max(width);
    }
    let height = (lines.len() as f64) * label.line_height;
    Label {
        lines,
        widths,
        width: widest,
        height,
        size: label.size,
        line_height: label.line_height,
        heights: None,
    }
}

#[derive(Debug, Clone, Copy)]
struct Port {
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    gap: f64,
    wire: bool,
}

/// An orthogonal route from one port to another, each left along its side's normal.
fn route(s: Port, e: Port) -> Vec<f64> {
    let (sx, sy, sdx, sdy) = (s.x, s.y, s.dx, s.dy);
    let (ex, ey, edx, edy) = (e.x, e.y, e.dx, e.dy);
    let s1x = sx + sdx * STUB;
    let s1y = sy + sdy * STUB;
    let e1x = ex + edx * STUB;
    let e1y = ey + edy * STUB;
    if sdx * edx + sdy * edy == 0.0 {
        let cx = if sdx != 0.0 { ex } else { sx };
        let cy = if sdx != 0.0 { sy } else { ey };
        if (cx - sx) * sdx + (cy - sy) * sdy > 0.0 && (cx - ex) * edx + (cy - ey) * edy > 0.0 {
            return vec![sx, sy, cx, cy, ex, ey];
        }
        return if sdx != 0.0 {
            vec![sx, sy, s1x, s1y, s1x, e1y, e1x, e1y, ex, ey]
        } else {
            vec![sx, sy, s1x, s1y, e1x, s1y, e1x, e1y, ex, ey]
        };
    }
    let sideways = sdx != 0.0;
    let offset = if sideways { ey - sy } else { ex - sx };
    if sdx == -edx && sdy == -edy {
        let ahead = (ex - sx) * sdx + (ey - sy) * sdy;
        if ahead > 0.0 {
            if offset.abs() < 0.5 {
                return vec![sx, sy, ex, ey];
            }
            if sideways {
                let lo = if sdx > 0.0 { s.x1 } else { e.x1 };
                let hi = if sdx > 0.0 { e.x0 } else { s.x0 };
                let mx = if lo < hi { (lo + hi) / 2.0 } else { (sx + ex) / 2.0 };
                return vec![sx, sy, mx, sy, mx, ey, ex, ey];
            }
            let lo = if sdy > 0.0 { s.y1 } else { e.y1 };
            let hi = if sdy > 0.0 { e.y0 } else { s.y0 };
            let my = if lo < hi { (lo + hi) / 2.0 } else { (sy + ey) / 2.0 };
            return vec![sx, sy, sx, my, ex, my, ex, ey];
        }
    } else if offset.abs() >= 1.0 {
        if sideways {
            let x = if sdx > 0.0 { sx.max(ex) + STUB } else { sx.min(ex) - STUB };
            return vec![sx, sy, x, sy, x, ey, ex, ey];
        }
        let y = if sdy > 0.0 { sy.max(ey) + STUB } else { sy.min(ey) - STUB };
        return vec![sx, sy, sx, y, ex, y, ex, ey];
    }
    if sideways {
        let lane = if s.y1 + STUB <= e.y0 {
            (s.y1 + e.y0) / 2.0
        } else if e.y1 + STUB <= s.y0 {
            (e.y1 + s.y0) / 2.0
        } else {
            s.y1.max(e.y1) + STUB
        };
        return vec![sx, sy, s1x, sy, s1x, lane, e1x, lane, e1x, ey, ex, ey];
    }
    let lane = if s.x1 + STUB <= e.x0 {
        (s.x1 + e.x0) / 2.0
    } else if e.x1 + STUB <= s.x0 {
        (e.x1 + s.x0) / 2.0
    } else {
        s.x1.max(e.x1) + STUB
    };
    vec![sx, sy, sx, s1y, lane, s1y, lane, e1y, ex, e1y, ex, ey]
}

/// Drops repeated points and joins runs that continue in a straight line.
fn simplify(p: &[f64]) -> Vec<f64> {
    if p.len() < 2 {
        return Vec::new();
    }
    let mut out = vec![p[0], p[1]];
    let mut i = 2;
    while i + 1 < p.len() {
        let x = p[i];
        let y = p[i + 1];
        let n = out.len();
        let same_x = (x - out[n - 2]).abs() < 0.01;
        let same_y = (y - out[n - 1]).abs() < 0.01;
        if same_x && same_y {
            i += 2;
            continue;
        }
        if n >= 4 && ((same_x && (out[n - 4] - out[n - 2]).abs() < 0.01) || (same_y && (out[n - 3] - out[n - 1]).abs() < 0.01)) {
            out[n - 2] = x;
            out[n - 1] = y;
        } else {
            out.push(x);
            out.push(y);
        }
        i += 2;
    }
    out
}

fn path_data(p: &[f64], start_trim: f64, end_trim: f64) -> String {
    let n = p.len() / 2;
    let mut xs = vec![0.0; n];
    let mut ys = vec![0.0; n];
    for i in 0..n {
        xs[i] = p[i * 2];
        ys[i] = p[i * 2 + 1];
    }
    let trim = |xs: &mut [f64], ys: &mut [f64], at: usize, toward: usize, amount: f64| {
        let len = (xs[toward] - xs[at]).hypot(ys[toward] - ys[at]);
        let t = amount.min((len - 1.0).max(0.0));
        if len > 0.0 && t > 0.0 {
            xs[at] += ((xs[toward] - xs[at]) / len) * t;
            ys[at] += ((ys[toward] - ys[at]) / len) * t;
        }
    };
    trim(&mut xs, &mut ys, 0, 1, start_trim);
    trim(&mut xs, &mut ys, n - 1, n - 2, end_trim);
    let mut d = format!("M{},{}", num(xs[0]), num(ys[0]));
    for i in 1..(n - 1) {
        let before = (xs[i] - xs[i - 1]).hypot(ys[i] - ys[i - 1]);
        let after = (xs[i + 1] - xs[i]).hypot(ys[i + 1] - ys[i]);
        let r = CORNER.min(before / 2.0).min(after / 2.0);
        if r < 0.5 {
            d.push_str(&format!("L{},{}", num(xs[i]), num(ys[i])));
            continue;
        }
        let in_x = xs[i] - ((xs[i] - xs[i - 1]) / before) * r;
        let in_y = ys[i] - ((ys[i] - ys[i - 1]) / before) * r;
        let out_x = xs[i] + ((xs[i + 1] - xs[i]) / after) * r;
        let out_y = ys[i] + ((ys[i + 1] - ys[i]) / after) * r;
        d.push_str(&format!(
            "L{},{}Q{},{} {},{}",
            num(in_x),
            num(in_y),
            num(xs[i]),
            num(ys[i]),
            num(out_x),
            num(out_y)
        ));
    }
    d.push_str(&format!("L{},{}", num(xs[n - 1]), num(ys[n - 1])));
    d
}

pub fn render_architecture(model: &ArchitectureDb, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| draw(model, ctx, tight))
}

fn draw(model: &ArchitectureDb, ctx: &RenderContext<'_>, tight: bool) -> Rendered {
    let icon_size = setting(ctx, "iconSize", 48.0, 8.0, 512.0);
    let size = setting(ctx, "fontSize", ctx.options.font_size.unwrap_or(16.0), 4.0, 128.0);
    let group_pad = setting(ctx, "padding", 20.0, 0.0, 256.0).min(if tight { 12.0 } else { f64::INFINITY });
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let half = icon_size / 2.0;

    let nodes: Vec<&ArchNode> = model.nodes.values().collect();
    let groups: Vec<&_> = model.groups.values().collect();
    let n = nodes.len();
    let g_count = groups.len();
    let grid = place_on_grid(&nodes, &groups, &model.edges, &model.layout_hints);
    let mut index: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, node) in nodes.iter().enumerate() {
        index.insert(node.id(), i);
    }

    let mut labels: Vec<Label> = Vec::with_capacity(n);
    let mut box_w: Vec<f64> = vec![0.0; n];
    let mut box_h: Vec<f64> = vec![0.0; n];
    let wrap = if tight { icon_size.max(64.0) } else { (icon_size * 2.25).max(96.0) };
    for (i, node) in nodes.iter().enumerate() {
        let title_str = match node {
            ArchNode::Service(s) => s.title.as_deref(),
            ArchNode::Junction(_) => None,
        };
        let label = layout_label(title_str, true, ctx.measurer, size, wrap, TextStyle::NONE, ctx.icons, None);
        box_w[i] = icon_size.max(2.0 * (label.width / 2.0).ceil());
        box_h[i] = icon_size + if label.height > 0.0 { LABEL_GAP + label.height } else { 0.0 };
        labels.push(label);
    }

    let mut col_values: Vec<i32> = Vec::with_capacity(n + g_count);
    let mut row_values: Vec<i32> = Vec::with_capacity(n + g_count);
    for i in 0..n {
        col_values.push(grid.col[i]);
        row_values.push(grid.row[i]);
    }
    for g in 0..g_count {
        if grid.group_empty[g] {
            col_values.push(grid.group_col[g]);
            row_values.push(grid.group_row[g]);
        }
    }
    let col_of = rank(col_values);
    let row_of = rank(row_values);
    let cols = col_of.len();
    let rows = row_of.len();
    let mut col_w = vec![0.0f64; cols];
    let mut row_h = vec![0.0f64; rows];
    let gap = if tight {
        24.0f64.max(2.0 * STUB)
    } else {
        40.0f64.max((icon_size * 0.75).round())
    };
    let mut gap_x = vec![gap; cols];
    let mut gap_y = vec![gap; rows];
    let mut node_col = vec![0usize; n];
    let mut node_row = vec![0usize; n];
    for i in 0..n {
        let c = col_of[&grid.col[i]];
        let r = row_of[&grid.row[i]];
        node_col[i] = c;
        node_row[i] = r;
        col_w[c] = col_w[c].max(box_w[i]);
        row_h[r] = row_h[r].max(box_h[i]);
    }
    for g in 0..g_count {
        if !grid.group_empty[g] {
            continue;
        }
        let c = col_of[&grid.group_col[g]];
        let r = row_of[&grid.group_row[g]];
        col_w[c] = col_w[c].max(icon_size);
        row_h[r] = row_h[r].max(half);
    }

    let e_count = model.edges.len();
    let mut edge_labels: Vec<Label> = Vec::with_capacity(e_count);
    let mut ends: Vec<(Option<usize>, Option<usize>)> = Vec::with_capacity(e_count);
    for edge in &model.edges {
        let a = index.get(edge.lhs_id.as_str()).copied();
        let b = index.get(edge.rhs_id.as_str()).copied();
        ends.push((a, b));
        let label = layout_label(edge.title.as_deref(), true, ctx.measurer, small, 160.0, TextStyle::NONE, ctx.icons, None);
        if label.width > 0.0
            && let (Some(ai), Some(bi)) = (a, b)
        {
            if node_col[ai] != node_col[bi] {
                let c = node_col[ai].min(node_col[bi]);
                gap_x[c] = gap_x[c].max(label.width.ceil() + 28.0);
            } else {
                col_w[node_col[ai]] = col_w[node_col[ai]].max(2.0 * (label.width / 2.0).ceil() + 8.0);
                if node_row[ai] != node_row[bi] {
                    let r = node_row[ai].min(node_row[bi]);
                    gap_y[r] = gap_y[r].max(label.height.ceil() + 24.0);
                }
            }
        }
        edge_labels.push(label);
    }

    let mut group_labels: Vec<Label> = Vec::with_capacity(g_count);
    let mut c0 = vec![0usize; g_count];
    let mut c1 = vec![0usize; g_count];
    let mut r0 = vec![0usize; g_count];
    let mut r1 = vec![0usize; g_count];
    let mut ins_l = vec![0.0f64; g_count];
    let mut ins_r = vec![0.0f64; g_count];
    let mut ins_t = vec![0.0f64; g_count];
    let mut ins_b = vec![0.0f64; g_count];
    let mut head_w = vec![0.0f64; g_count];
    let mut head_h = vec![0.0f64; g_count];
    let mut col_l = vec![0.0f64; cols];
    let mut col_r = vec![0.0f64; cols];
    let mut row_t = vec![0.0f64; rows];
    let mut row_b = vec![0.0f64; rows];
    let badge = (size * 1.25).round();
    let group_max_w = if tight { 80.0f64.max(title_room(ctx.options) / 2.0) } else { 320.0 };
    for g in 0..g_count {
        c0[g] = col_of[&grid.group_col[g]];
        c1[g] = col_of[&(grid.group_col[g] + grid.group_cols[g] - 1)];
        r0[g] = row_of[&grid.group_row[g]];
        r1[g] = row_of[&(grid.group_row[g] + grid.group_rows[g] - 1)];
        let label = layout_label(
            groups[g].title.as_deref(),
            true,
            ctx.measurer,
            size,
            group_max_w,
            TextStyle::NONE,
            ctx.icons,
            None,
        );
        let icon = if groups[g].icon.is_some() { badge } else { 0.0 };
        head_w[g] = label.width + icon + if label.width > 0.0 && icon > 0.0 { 6.0 } else { 0.0 };
        head_h[g] = label.height.max(icon);
        group_labels.push(label);
    }
    for g in (0..g_count).rev() {
        let left_pad = group_pad + ins_l[g];
        let mut right_pad = group_pad + ins_r[g];
        let top_pad = (if head_h[g] > 0.0 { group_pad.max(head_h[g] + 12.0) } else { group_pad }) + ins_t[g];
        let bottom_pad = group_pad + ins_b[g];
        if head_w[g] > 0.0 {
            let mut inner = left_pad + right_pad;
            for c in c0[g]..=c1[g] {
                inner += col_w[c] + if c < c1[g] { col_r[c] + gap_x[c] + col_l[c + 1] } else { 0.0 };
            }
            if head_w[g] + 20.0 > inner {
                right_pad += (head_w[g] + 20.0 - inner).ceil();
            }
        }
        ins_l[g] = left_pad;
        ins_r[g] = right_pad;
        ins_t[g] = top_pad;
        ins_b[g] = bottom_pad;
        col_l[c0[g]] = col_l[c0[g]].max(left_pad);
        col_r[c1[g]] = col_r[c1[g]].max(right_pad);
        row_t[r0[g]] = row_t[r0[g]].max(top_pad);
        row_b[r1[g]] = row_b[r1[g]].max(bottom_pad);
        let p = grid.group_parent[g];
        if p < 0 {
            continue;
        }
        let pu = p as usize;
        if c0[pu] == c0[g] {
            ins_l[pu] = ins_l[pu].max(left_pad);
        }
        if c1[pu] == c1[g] {
            ins_r[pu] = ins_r[pu].max(right_pad);
        }
        if r0[pu] == r0[g] {
            ins_t[pu] = ins_t[pu].max(top_pad);
        }
        if r1[pu] == r1[g] {
            ins_b[pu] = ins_b[pu].max(bottom_pad);
        }
    }

    let mut x_pos = vec![0.0f64; cols];
    let mut y_pos = vec![0.0f64; rows];
    let mut inner_w = 0.0f64;
    for c in 0..cols {
        x_pos[c] = inner_w + col_l[c];
        inner_w = x_pos[c] + col_w[c] + col_r[c] + if c + 1 < cols { gap_x[c] } else { 0.0 };
    }
    let mut inner_h = 0.0f64;
    for r in 0..rows {
        y_pos[r] = inner_h + row_t[r];
        inner_h = y_pos[r] + row_h[r] + row_b[r] + if r + 1 < rows { gap_y[r] } else { 0.0 };
    }

    let mut min_x = 0.0f64;
    let mut min_y = 0.0f64;
    let mut max_x = inner_w;
    let mut max_y = inner_h;

    let left = |g: usize| -> f64 { x_pos[c0[g]] - ins_l[g] };
    let right = |g: usize| -> f64 { x_pos[c1[g]] + col_w[c1[g]] + ins_r[g] };
    let top = |g: usize| -> f64 { y_pos[r0[g]] - ins_t[g] };
    let bottom = |g: usize| -> f64 { y_pos[r1[g]] + row_h[r1[g]] + ins_b[g] };
    let center_x = |i: usize| -> f64 { x_pos[node_col[i]] + col_w[node_col[i]] / 2.0 };

    let port = |i: usize, side: usize, via_group: bool| -> Port {
        let dx = DX[side];
        let dy = DY[side];
        let cx = center_x(i);
        let y = y_pos[node_row[i]];
        let mut p = Port {
            x: cx,
            y: y + half,
            dx,
            dy,
            x0: cx - box_w[i] / 2.0,
            y0: y,
            x1: cx + box_w[i] / 2.0,
            y1: y + box_h[i],
            gap: 0.0,
            wire: false,
        };
        if nodes[i].is_junction() {
            p.x0 = cx;
            p.x1 = cx;
            p.y0 = p.y;
            p.y1 = p.y;
            p.gap = DOT;
        } else if dx != 0.0 {
            p.x = cx + dx * half;
        } else {
            p.y = if dy < 0.0 {
                y
            } else {
                y + box_h[i] + if labels[i].height > 0.0 { 2.0 } else { 0.0 }
            };
        }
        let g = if via_group { grid.node_parent[i] } else { -1 };
        if g >= 0 {
            let gu = g as usize;
            p.x0 = left(gu);
            p.x1 = right(gu);
            p.y0 = top(gu);
            p.y1 = bottom(gu);
            p.gap = 0.0;
            p.wire = nodes[i].is_junction();
            if dx != 0.0 {
                p.x = if dx < 0.0 { p.x0 } else { p.x1 };
            } else {
                p.y = if dy < 0.0 { p.y0 } else { p.y1 };
            }
        }
        p
    };

    let mut edges_out = String::new();
    let mut labels_out = String::new();
    let mut runs: Vec<(f64, f64, f64)> = Vec::new();
    let trim_length = marker_trim("arrow_point");
    let line_color = ctx.theme.line();
    let bg_color = ctx.theme.bg();

    for (k, edge) in model.edges.iter().enumerate() {
        let (Some(a), Some(b)) = ends[k] else {
            continue;
        };
        let mut s = port(a, side_index(edge.lhs_dir), edge.lhs_group);
        let mut e = port(b, side_index(edge.rhs_dir), edge.rhs_group);
        if s.x == e.x && s.y == e.y && s.dx == e.dx {
            s.x -= 8.0 * s.dy.abs();
            s.y -= 8.0 * s.dx.abs();
            e.x += 8.0 * s.dy.abs();
            e.y += 8.0 * s.dx.abs();
        }
        let mut routed = route(s, e);
        if s.wire {
            routed.splice(0..0, [center_x(a), y_pos[node_row[a]] + half]);
        }
        if e.wire {
            routed.push(center_x(b));
            routed.push(y_pos[node_row[b]] + half);
        }
        let points = simplify(&routed);
        if points.len() < 4 {
            continue;
        }
        let edge_id = format!("{}-{}", edge.lhs_id, edge.rhs_id);
        let start_trim = if edge.lhs_into && !s.wire { trim_length + s.gap } else { 0.0 };
        let end_trim = if edge.rhs_into && !e.wire { trim_length + e.gap } else { 0.0 };
        let lhs_mark = if edge.lhs_into {
            marker("arrow_point", s.x + s.dx * s.gap, s.y + s.dy * s.gap, -s.dx, -s.dy, line_color, bg_color)
        } else {
            String::new()
        };
        let rhs_mark = if edge.rhs_into {
            marker("arrow_point", e.x + e.dx * e.gap, e.y + e.dy * e.gap, -e.dx, -e.dy, line_color, bg_color)
        } else {
            String::new()
        };
        edges_out.push_str(&format!(
            r#"<g class="pele-edge" data-id="{}"><path d="{}"/>{lhs_mark}{rhs_mark}</g>"#,
            esc_text(&edge_id),
            path_data(&points, start_trim, end_trim),
        ));

        for pair in points.as_chunks::<2>().0 {
            min_x = min_x.min(pair[0] - 4.0);
            max_x = max_x.max(pair[0] + 4.0);
            min_y = min_y.min(pair[1] - 4.0);
            max_y = max_y.max(pair[1] + 4.0);
        }

        let mut best = 0usize;
        let mut best_length = -1.0f64;
        let mut flat = 0usize;
        let mut flat_length = -1.0f64;
        let mut i = 0usize;
        while i + 3 < points.len() {
            let horizontal = (points[i + 1] - points[i + 3]).abs() < 0.01;
            let seg_len = (points[i] - points[i + 2]).abs() + (points[i + 1] - points[i + 3]).abs();
            if !horizontal {
                runs.push((points[i], points[i + 1].min(points[i + 3]), points[i + 1].max(points[i + 3])));
            }
            if seg_len > best_length {
                best = i;
                best_length = seg_len;
            }
            if horizontal && seg_len > flat_length {
                flat = i;
                flat_length = seg_len;
            }
            i += 2;
        }

        let label = &edge_labels[k];
        if label.width > 0.0 {
            let at = if flat_length >= label.width + 8.0 { flat } else { best };
            let mut lx = (points[at] + points[at + 2]) / 2.0;
            let mut ly = (points[at + 1] + points[at + 3]) / 2.0;
            let lw = label.width + 8.0;
            let upright = (points[at] - points[at + 2]).abs() < 0.01;
            for p in [s, e] {
                if lx + lw / 2.0 <= p.x0 || lx - lw / 2.0 >= p.x1 || ly + label.height / 2.0 <= p.y0 || ly - label.height / 2.0 >= p.y1 {
                    continue;
                }
                if upright {
                    lx = if lx >= (p.x0 + p.x1) / 2.0 {
                        p.x1 + lw / 2.0 + 4.0
                    } else {
                        p.x0 - lw / 2.0 - 4.0
                    };
                } else {
                    ly = if ly >= (p.y0 + p.y1) / 2.0 {
                        p.y1 + label.height / 2.0 + 4.0
                    } else {
                        p.y0 - label.height / 2.0 - 4.0
                    };
                }
            }
            min_x = min_x.min(lx - lw / 2.0);
            max_x = max_x.max(lx + lw / 2.0);
            min_y = min_y.min(ly - label.height / 2.0);
            max_y = max_y.max(ly + label.height / 2.0);
            labels_out.push_str(&edge_label_svg(&edge_id, label, lx, ly, "", ctx.theme, ctx.icons));
        }
    }

    let rounded = ctx.theme.rounded_standalone();
    let mut clusters = String::new();
    for (g, group) in groups.iter().enumerate() {
        let gx = left(g);
        let gy = top(g);
        let gw = right(g) - gx;
        let label = &group_labels[g];
        let mut head = String::new();
        if head_w[g] > 0.0 {
            let band = gy + head_h[g] + 12.0;
            let mut crossings: Vec<f64> = Vec::new();
            for &(rx, ry0, ry1) in &runs {
                if ry0 < band && ry1 > gy && rx > gx && rx < gx + gw {
                    crossings.push(rx);
                }
            }
            crossings.sort_by(f64::total_cmp);
            crossings.push(gx + gw - 4.0);
            let mut start = gx + 10.0;
            for crossing in crossings {
                if crossing - 6.0 - start >= head_w[g] {
                    break;
                }
                start = start.max(crossing + 6.0);
            }
            if start + head_w[g] > gx + gw - 4.0 {
                start = gx + 10.0;
            }
            let cy = gy + 6.0 + head_h[g] / 2.0;
            let mut text_x = start;
            if let Some(ref icon) = group.icon {
                head.push_str(&icon_slot(icon, start, cy - badge / 2.0, badge, ctx.theme, ctx.icons));
                text_x += badge + 6.0;
            }
            let lbl_attrs = format!(r#" class="pele-cluster-label" fill="{}""#, ctx.theme.muted());
            head.push_str(&label_svg(label, text_x + label.width / 2.0, cy, &lbl_attrs, ctx.theme, ctx.icons));
        }
        clusters.push_str(&format!(
            r#"<g class="pele-cluster" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" fill-opacity="0.5" stroke="{}"{rounded}/>{head}</g>"#,
            esc_text(&group.id),
            num(gx),
            num(gy),
            num(gw),
            num(bottom(g) - gy),
            ctx.theme.surface_alt(),
            ctx.theme.border(),
        ));
    }

    let mut nodes_out = String::new();
    let glyph = icon_size * 0.5;
    let text_size = 6.0f64.max((size * 0.75).round());
    for (i, node) in nodes.iter().enumerate() {
        let at = format!(
            r#"data-id="{}" transform="translate({},{})""#,
            esc_text(node.id()),
            num(center_x(i)),
            num(y_pos[node_row[i]])
        );
        match node {
            ArchNode::Junction(_) => {
                nodes_out.push_str(&format!(
                    r#"<g class="pele-node pele-junction" {at}><circle cy="{}" r="{}" fill="{}"/></g>"#,
                    num(half),
                    num(DOT),
                    ctx.theme.line(),
                ));
            }
            ArchNode::Service(svc) => {
                let inner = if let Some(ref icon) = svc.icon {
                    icon_slot(icon, -glyph / 2.0, (icon_size - glyph) / 2.0, glyph, ctx.theme, ctx.icons)
                } else if let Some(ref icon_text) = svc.icon_text {
                    let text = layout_label(
                        Some(icon_text),
                        false,
                        ctx.measurer,
                        text_size,
                        icon_size - 8.0,
                        TextStyle::NONE,
                        ctx.icons,
                        None,
                    );
                    let lh = if text.line_height > 0.0 { text.line_height } else { 1.0 };
                    let max_lines = 1usize.max(((icon_size - 4.0) / lh).floor().max(1.0) as usize);
                    let fitted = fit(&text, icon_size - 8.0, max_lines, ctx.measurer);
                    label_svg(
                        &fitted,
                        0.0,
                        half,
                        &format!(r#" class="pele-icon-text" font-size="{}""#, num(text_size)),
                        ctx.theme,
                        ctx.icons,
                    )
                } else {
                    String::new()
                };
                nodes_out.push_str(&format!(
                    r#"<g class="pele-node pele-service" {at}><rect x="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>{inner}{}</g>"#,
                    num(-half),
                    num(icon_size),
                    num(icon_size),
                    ctx.theme.surface(),
                    ctx.theme.border(),
                    label_svg(
                        &labels[i],
                        0.0,
                        icon_size + LABEL_GAP + labels[i].height / 2.0,
                        r#" class="pele-label""#,
                        ctx.theme,
                        ctx.icons,
                    ),
                ));
            }
        }
    }

    let title_max_w = if tight { title_room(ctx.options) } else { 4000.0 };
    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, title_max_w, TextStyle::BOLD, None, None);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let width = ((max_x - min_x).max(title.width) + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();
    let ox = ((width - (max_x - min_x)) / 2.0 - min_x).round();
    let oy = (pad + title_height - min_y).round();

    let mut body = String::new();
    if !clusters.is_empty() {
        body.push_str(&format!(r#"<g class="pele-clusters">{clusters}</g>"#));
    }
    if !edges_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round" stroke-linejoin="round">{edges_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    if !labels_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(small)));
    }
    if !nodes_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None);
    if !body.is_empty() {
        content.push_str(&format!(r#"<g transform="translate({},{})">{body}</g>"#, num(ox), num(oy)));
    }

    let svg = svg_document(
        "architecture",
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
