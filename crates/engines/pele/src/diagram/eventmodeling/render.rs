use std::collections::{HashMap, HashSet};

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::turn_to_fit;
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::edges::{marker, marker_trim};
use crate::svg::root::{Accessible, svg_document};
use crate::text::entities::decode_entities;
use crate::text::label::{Label, layout_label};
use crate::text::literal::{break_label, left_label_svg, literal_label};

use super::model::{EmLane, EventModelingModel};

const BOX_PAD_X: f64 = 12.0;
const BOX_PAD_Y: f64 = 10.0;
const BOX_MIN_WIDTH: f64 = 96.0;
const BOX_GAP: f64 = 16.0;
const STAGGER: f64 = 80.0;
const LANE_PAD: f64 = 12.0;
const LANE_GAP: f64 = 8.0;
const DATA_COLUMNS: usize = 48;
const NOTE_COLUMNS: usize = 80;
const CARD_GAP: f64 = 8.0;
const RAIL_GAP: f64 = 8.0;
const CARD_MIN: f64 = 120.0;
const ARROW_ROOM: f64 = 20.0;

struct Placed {
    box_idx: usize,
    name: Label,
    data: Vec<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct Band<'a> {
    lane: &'a EmLane,
    label: Label,
    right: f64,
    y: f64,
    h: f64,
}

fn hard_wrap(text: &str, columns: usize) -> Vec<String> {
    let mut out = Vec::new();
    for line in decode_entities(text).split('\n') {
        let chars: Vec<char> = line.chars().collect();
        if chars.len() <= columns {
            out.push(line.to_string());
            continue;
        }
        for chunk in chars.chunks(columns) {
            out.push(chunk.iter().collect());
        }
    }
    out
}

fn lines_svg(rows: &[String], x: f64, y: f64, step: f64, attrs: &str) -> String {
    let mut body = String::new();
    for (i, row) in rows.iter().enumerate() {
        if !row.is_empty() {
            body.push_str(&format!(r#"<tspan x="{}" y="{}">{}</tspan>"#, num(x), num(y + i as f64 * step), esc(row),));
        }
    }
    if body.is_empty() {
        String::new()
    } else {
        format!(r#"<text{attrs} xml:space="preserve">{body}</text>"#)
    }
}

fn widest(rows: &[String], measurer: &dyn TextMeasurer, font_size: f64, style: TextStyle) -> f64 {
    rows.iter().map(|row| measurer.width(row, font_size, style)).fold(0.0f64, f64::max)
}

pub fn render_event_model(model: &EventModelingModel, ctx: &RenderContext<'_>) -> Rendered {
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

fn draw(model: &EventModelingModel, ctx: &RenderContext<'_>, down: bool) -> Rendered {
    if down {
        return vertical_event_model(model, ctx);
    }
    let size = ctx.options.font_size.unwrap_or(16.0);
    let name_size = (size * 0.875).round();
    let small = (size * 0.8125).round();
    let mono = (size * 0.75).round();
    let mono_step = (mono * 1.4).round();
    let small_step = (small * 1.5).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let rounded = ctx.theme.rounded_standalone();

    let mut bands: Vec<Band<'_>> = Vec::with_capacity(model.lanes.len());
    let mut band_pos: HashMap<usize, usize> = HashMap::with_capacity(model.lanes.len());
    let mut label_column = 0.0f64;
    for (pos, lane) in model.lanes.iter().enumerate() {
        let label = layout_label(Some(&lane.label), false, ctx.measurer, small, 4000.0, TextStyle::BOLD, None, None);
        label_column = label_column.max(label.width);
        band_pos.insert(lane.index, pos);
        bands.push(Band {
            lane,
            label,
            right: f64::NEG_INFINITY,
            y: 0.0,
            h: 0.0,
        });
    }
    label_column += 2.0 * LANE_PAD;

    let mut placed: Vec<Placed> = Vec::with_capacity(model.boxes.len());
    for (box_idx, b) in model.boxes.iter().enumerate() {
        let b_pos = band_pos[&b.lane_index];
        let name = layout_label(Some(&b.name), false, ctx.measurer, name_size, 4000.0, TextStyle::BOLD, None, None);
        let data = b.data.as_deref().map_or_else(Vec::new, |d| hard_wrap(d, DATA_COLUMNS));
        let w = BOX_MIN_WIDTH.max(name.width.max(widest(&data, ctx.measurer, mono, TextStyle::MONO)) + 2.0 * BOX_PAD_X);
        let h = 2.0 * BOX_PAD_Y + name.height + if data.is_empty() { 0.0 } else { 6.0 + data.len() as f64 * mono_step };
        let x = if let Some(prev) = placed.last() {
            let stagger = prev.x + (prev.w / 2.0).max(prev.w - STAGGER);
            let prev_lane = model.boxes[prev.box_idx].lane_index;
            if prev_lane == b.lane_index {
                bands[b_pos].right + BOX_GAP
            } else {
                stagger.max(bands[b_pos].right + BOX_GAP)
            }
        } else {
            0.0
        };
        bands[b_pos].right = x + w;
        bands[b_pos].h = bands[b_pos].h.max(h);
        placed.push(Placed {
            box_idx,
            name,
            data,
            x,
            y: 0.0,
            w,
            h,
        });
    }

    let content_right = placed.iter().map(|p| p.x + p.w).fold(0.0f64, f64::max);
    let lane_width = label_column + content_right + LANE_PAD;

    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, None, None);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let left = pad;
    let top = pad + title_height;

    let mut y = top;
    let mut lanes_svg = String::new();
    let lane_label_attrs = format!(
        r#" class="pele-cluster-label" font-size="{}" font-weight="{}" fill="{}""#,
        num(small),
        ctx.theme.heading_weight(),
        ctx.theme.muted(),
    );
    for band in &mut bands {
        band.y = y;
        band.h += 2.0 * LANE_PAD;
        lanes_svg.push_str(&format!(
            r#"<g class="pele-cluster pele-em-lane" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}"{rounded}/>{}</g>"#,
            esc_text(&band.lane.label),
            num(left),
            num(y),
            num(lane_width),
            num(band.h),
            ctx.theme.surface(),
            label_svg(
                &band.label,
                left + LANE_PAD + band.label.width / 2.0,
                y + band.h / 2.0,
                &lane_label_attrs,
                ctx.theme,
                None,
            ),
        ));
        y += band.h + LANE_GAP;
    }
    let mut bottom = if bands.is_empty() { top } else { y - LANE_GAP };

    let mut nodes_svg = String::new();
    let name_attrs = format!(
        r#" class="pele-label" font-size="{}" font-weight="{}""#,
        num(name_size),
        ctx.theme.heading_weight()
    );
    let data_attrs = format!(r#" class="pele-em-data" font-family="{}" font-size="{}""#, ctx.theme.font_mono(), num(mono));
    for item in &mut placed {
        let b = &model.boxes[item.box_idx];
        let band = &bands[band_pos[&b.lane_index]];
        item.x += left + label_column;
        item.y = band.y + (band.h - item.h) / 2.0;
        let frame = format!(r#"x="{}" y="{}" width="{}" height="{}""#, num(item.x), num(item.y), num(item.w), num(item.h));
        let shape = match b.kind.series_slot() {
            None => format!(r#"<rect {frame} fill="{}" stroke="{}"{rounded}/>"#, ctx.theme.bg(), ctx.theme.border()),
            Some(slot) => {
                let color = ctx.theme.series_color(slot, ctx.palette);
                format!(
                    r#"<rect {frame} fill="{}"{rounded}/><rect {frame} fill="{color}" fill-opacity="0.22" stroke="{color}"{rounded}/>"#,
                    ctx.theme.bg(),
                )
            }
        };
        let name_y = item.y + BOX_PAD_Y + item.name.height / 2.0;
        let text = format!(
            "{}{}",
            label_svg(&item.name, item.x + item.w / 2.0, name_y, &name_attrs, ctx.theme, None),
            lines_svg(
                &item.data,
                item.x + BOX_PAD_X,
                item.y + BOX_PAD_Y + item.name.height + 6.0 + mono_step / 2.0 + mono * 0.35,
                mono_step,
                &data_attrs,
            ),
        );
        let reset_cls = if b.reset { " pele-em-reset" } else { "" };
        nodes_svg.push_str(&format!(
            r#"<g class="pele-node pele-em-{}{reset_cls}" data-id="{}">{shape}{text}</g>"#,
            b.kind.as_str(),
            esc_text(&b.id),
        ));
    }

    let mut edges_svg = String::new();
    let trim = marker_trim("arrow_point");
    for rel in &model.relations {
        if rel.source_index == rel.target_index {
            continue;
        }
        let s = &placed[rel.source_index];
        let t = &placed[rel.target_index];
        let s_box = &model.boxes[rel.source_index];
        let t_box = &model.boxes[rel.target_index];
        let (d, head) = if s_box.lane_index == t_box.lane_index {
            let forward = t.x >= s.x;
            let sx = if forward { s.x + s.w } else { s.x };
            let tx = if forward { t.x } else { t.x + t.w };
            let sy = s.y + s.h / 2.0;
            let ty = t.y + t.h / 2.0;
            let dir = if tx >= sx { 1.0 } else { -1.0 };
            (
                format!("M{},{}L{},{}", num(sx), num(sy), num(tx - dir * trim), num(ty)),
                marker("arrow_point", tx, ty, dir, 0.0, ctx.theme.line(), "none"),
            )
        } else {
            let going_down = t.y > s.y;
            let from = s.x.max(t.x);
            let to = (s.x + s.w).min(t.x + t.w);
            let inset = |w: f64| 24.0f64.min(w / 4.0);
            let sx = if to - from >= 16.0 {
                (from + to) / 2.0
            } else if t.x > s.x {
                s.x + s.w - inset(s.w)
            } else {
                s.x + inset(s.w)
            };
            let tx = if to - from >= 16.0 {
                sx
            } else if t.x > s.x {
                t.x + inset(t.w)
            } else {
                t.x + t.w - inset(t.w)
            };
            let sy = if going_down { s.y + s.h } else { s.y };
            let ty = if going_down { t.y } else { t.y + t.h };
            let dir = if going_down { 1.0 } else { -1.0 };
            let end = ty - dir * trim;
            let mid = (sy + end) / 2.0;
            let d = if (sx - tx).abs() < f64::EPSILON {
                format!("M{},{}V{}", num(sx), num(sy), num(end))
            } else {
                format!(
                    "M{},{}C{},{} {},{} {},{}",
                    num(sx),
                    num(sy),
                    num(sx),
                    num(mid),
                    num(tx),
                    num(mid),
                    num(tx),
                    num(end),
                )
            };
            (d, marker("arrow_point", tx, ty, 0.0, dir, ctx.theme.line(), "none"))
        };
        edges_svg.push_str(&format!(
            r#"<g class="pele-edge" data-id="{}-{}"><path d="{d}" fill="none" stroke="{}"/>{head}</g>"#,
            esc_text(&rel.source_id),
            esc_text(&rel.target_id),
            ctx.theme.line(),
        ));
    }

    let names: HashMap<&str, &str> = model.boxes.iter().map(|b| (b.id.as_str(), b.name.as_str())).collect();
    let mut cards_svg = String::new();
    let mut cards_right = 0.0f64;
    let card_head_attrs = format!(r#" font-size="{}" font-weight="{}""#, num(small), ctx.theme.heading_weight());
    let card_body_attrs = format!(r#" font-size="{}""#, num(small));
    let mut push_card = |kind: &str, heading: &str, frame: &str, rows: Vec<String>| {
        let head_text = match names.get(frame) {
            Some(n) => format!("{heading} · {frame} {n}"),
            None => format!("{heading} · {frame}"),
        };
        let head = layout_label(Some(&head_text), false, ctx.measurer, small, 4000.0, TextStyle::BOLD, None, None);
        let w = head.width.max(widest(&rows, ctx.measurer, small, TextStyle::NONE)) + 2.0 * BOX_PAD_X;
        let h = 2.0 * BOX_PAD_Y + head.height + rows.len() as f64 * small_step;
        let cy = bottom + if cards_svg.is_empty() && bands.is_empty() { 0.0 } else { CARD_GAP };
        cards_svg.push_str(&format!(
            r#"<g class="pele-em-{kind}" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>{}{}</g>"#,
            esc_text(frame),
            num(left),
            num(cy),
            num(w),
            num(h),
            ctx.theme.bg(),
            ctx.theme.border(),
            label_svg(
                &head,
                left + BOX_PAD_X + head.width / 2.0,
                cy + BOX_PAD_Y + head.height / 2.0,
                &card_head_attrs,
                ctx.theme,
                None
            ),
            lines_svg(
                &rows,
                left + BOX_PAD_X,
                cy + BOX_PAD_Y + head.height + small_step / 2.0 + small * 0.35,
                small_step,
                &card_body_attrs,
            ),
        ));
        bottom = cy + h;
        cards_right = cards_right.max(w);
    };
    for note in &model.notes {
        push_card("note", "Note", &note.frame, hard_wrap(&note.text, NOTE_COLUMNS));
    }
    for spec in &model.specifications {
        let mut rows = vec![format!("Given  {}", spec.given.join(", "))];
        if !spec.when.is_empty() {
            rows.push(format!("When  {}", spec.when.join(", ")));
        }
        rows.push(format!("Then  {}", spec.then.join(", ")));
        let wrapped: Vec<String> = rows.into_iter().flat_map(|r| hard_wrap(&r, NOTE_COLUMNS)).collect();
        push_card("specification", "Given / When / Then", &spec.frame, wrapped);
    }

    let width = (if bands.is_empty() { 0.0 } else { lane_width }).max(cards_right).max(title.width);
    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (bottom + pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{lanes_svg}{edges_svg}{nodes_svg}{cards_svg}",
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
    );
    let svg = svg_document(
        "eventmodeling",
        total_width,
        total_height,
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
        width: total_width,
        height: total_height,
        links: Vec::new(),
    }
}

struct VPlaced {
    y: f64,
    h: f64,
    w: f64,
    index: usize,
    lane: f64,
}

fn vertical_event_model(model: &EventModelingModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let mono = (size * 0.75).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let rounded = ctx.theme.rounded_standalone();
    let room = 160.0f64.max(ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad);

    let lane_labels: HashMap<usize, &str> = model.lanes.iter().map(|l| (l.index, l.label.as_str())).collect();
    let mut runs: HashMap<usize, (usize, usize)> = HashMap::new();
    let mut passed: HashSet<usize> = HashSet::new();
    for rel in &model.relations {
        let s = rel.source_index;
        let t = rel.target_index;
        if s == t {
            continue;
        }
        if s.abs_diff(t) < 2 {
            passed.insert(s.max(t));
            continue;
        }
        runs.entry(t)
            .and_modify(|run| {
                run.0 = run.0.min(s);
                run.1 = run.1.max(s);
            })
            .or_insert((s.min(t), s.max(t)));
    }
    let mut sorted_runs: Vec<(usize, (usize, usize))> = runs.into_iter().collect();
    sorted_runs.sort_by_key(|&(t, (from, _))| (from, t));
    let mut rail_of: HashMap<usize, usize> = HashMap::new();
    let mut rail_ends: Vec<usize> = Vec::new();
    for (target, (from, to)) in sorted_runs {
        let rail = match rail_ends.iter().position(|&end| end < from) {
            Some(r) => {
                rail_ends[r] = to;
                r
            }
            None => {
                rail_ends.push(to);
                rail_ends.len() - 1
            }
        };
        rail_of.insert(target, rail);
    }

    let gutter = 24.0 + RAIL_GAP * rail_ends.len().saturating_sub(1) as f64;
    let card_width = CARD_MIN.max(room - gutter);
    let text_room = card_width - 2.0 * BOX_PAD_X;
    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, room, TextStyle::BOLD, None, None);
    let mut y = pad + if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let mut bottom = pad + title.height;
    let mut width = title.width.max(card_width + gutter);
    let mut nodes_svg = String::new();
    let mut edges_svg = String::new();
    let mut cards_svg = String::new();
    let mut placed: Vec<VPlaced> = Vec::with_capacity(model.boxes.len());

    let lane_attrs = format!(
        r#" class="pele-cluster-label" font-size="{}" font-weight="{}" fill="{}""#,
        num(small),
        ctx.theme.heading_weight(),
        ctx.theme.muted(),
    );
    let name_attrs = format!(r#" class="pele-label" font-size="{}" font-weight="{}""#, num(small), ctx.theme.heading_weight());
    let data_attrs = format!(r#" class="pele-em-data" font-family="{}" font-size="{}""#, ctx.theme.font_mono(), num(mono));

    for (index, b) in model.boxes.iter().enumerate() {
        let lane_text = lane_labels.get(&b.lane_index).copied().unwrap_or("");
        let lane_room = if passed.contains(&index) { text_room - ARROW_ROOM } else { text_room };
        let lane = break_label(
            layout_label(Some(lane_text), false, ctx.measurer, small, lane_room, TextStyle::BOLD, None, None),
            ctx.measurer,
            lane_room,
        );
        let name = layout_label(Some(&b.name), false, ctx.measurer, small, text_room - 36.0, TextStyle::BOLD, None, None);
        let data = b
            .data
            .as_deref()
            .map(|raw| literal_label(&decode_entities(raw), ctx.measurer, mono, text_room, TextStyle::MONO));
        let w = card_width
            .max(lane.width + 2.0 * BOX_PAD_X)
            .max(name.width + 2.0 * BOX_PAD_X + 36.0)
            .max(data.as_ref().map_or(0.0, |d| d.width) + 2.0 * BOX_PAD_X);
        let head_h = lane.height + 12.0;
        let h = 2.0 * BOX_PAD_Y + name.height + data.as_ref().map_or(0.0, |d| d.height + 6.0);
        let cy = y + head_h;
        let frame = format!(r#"x="{}" y="{}" width="{}" height="{}""#, num(pad), num(cy), num(w), num(h));
        let overlay = match b.kind.series_slot() {
            None => String::new(),
            Some(slot) => {
                let color = ctx.theme.series_color(slot, ctx.palette);
                format!(r#"<rect {frame} fill="{color}" fill-opacity="0.22" stroke="{color}"{rounded}/>"#)
            }
        };
        let data_svg = match &data {
            None => String::new(),
            Some(d) => {
                let rows: Vec<String> = d.lines.iter().map(|l| l.iter().map(|s| s.text.as_str()).collect::<String>()).collect();
                lines_svg(
                    &rows,
                    pad + BOX_PAD_X,
                    cy + BOX_PAD_Y + name.height + 6.0 + d.line_height / 2.0 + mono * 0.35,
                    d.line_height,
                    &data_attrs,
                )
            }
        };
        let reset_cls = if b.reset { " pele-em-reset" } else { "" };
        nodes_svg.push_str(&format!(
            r#"<g class="pele-cluster pele-em-lane" data-id="{}">{}<g class="pele-node pele-em-{}{reset_cls}" data-id="{}"><rect {frame} fill="{}" stroke="{}"{rounded}/>{overlay}{}<text class="pele-em-frame" x="{}" y="{}" text-anchor="end" font-size="{}" fill="{}">{}</text>{data_svg}</g></g>"#,
            esc_text(lane_text),
            left_label_svg(&lane, pad + BOX_PAD_X, y, &lane_attrs, ctx.theme),
            b.kind.as_str(),
            esc_text(&b.id),
            ctx.theme.bg(),
            ctx.theme.border(),
            label_svg(&name, pad + BOX_PAD_X + name.width / 2.0, cy + BOX_PAD_Y + name.height / 2.0, &name_attrs, ctx.theme, None),
            num(pad + w - BOX_PAD_X),
            num(cy + BOX_PAD_Y + small),
            num(mono),
            ctx.theme.muted(),
            esc(&b.id),
        ));
        placed.push(VPlaced {
            y: cy,
            h,
            w,
            index,
            lane: lane.width,
        });
        width = width.max(w + gutter);
        bottom = cy + h;
        y = bottom + 28.0;
    }

    let trim = marker_trim("arrow_point");
    for rel in &model.relations {
        if rel.source_index == rel.target_index {
            continue;
        }
        let s = &placed[rel.source_index];
        let t = &placed[rel.target_index];
        let going_down = t.y > s.y;
        let dir = if going_down { 1.0 } else { -1.0 };
        let sy = if going_down { s.y + s.h } else { s.y };
        let ty = if going_down { t.y } else { t.y + t.h };
        let (d, head) = if s.index.abs_diff(t.index) == 1 {
            let lane_w = if going_down { t.lane } else { s.lane };
            let cx = pad + (s.w.min(t.w) / 2.0).max(BOX_PAD_X + lane_w + 16.0);
            (
                format!("M{},{}V{}", num(cx), num(sy), num(ty - dir * trim)),
                marker("arrow_point", cx, ty, 0.0, dir, ctx.theme.line(), "none"),
            )
        } else {
            let rail = pad + width - gutter + 12.0 + RAIL_GAP * rail_of.get(&rel.target_index).copied().unwrap_or(0) as f64;
            let from = s.y + s.h / 2.0 - 5.0;
            let to = t.y + t.h / 2.0 + 5.0;
            (
                format!("M{},{}H{}V{}H{}", num(pad + s.w), num(from), num(rail), num(to), num(pad + t.w + trim)),
                marker("arrow_point", pad + t.w, to, -1.0, 0.0, ctx.theme.line(), "none"),
            )
        };
        edges_svg.push_str(&format!(
            r#"<g class="pele-edge" data-id="{}-{}"><path d="{d}" fill="none" stroke="{}"/>{head}</g>"#,
            esc_text(&rel.source_id),
            esc_text(&rel.target_id),
            ctx.theme.line(),
        ));
    }

    let names: HashMap<&str, &str> = model.boxes.iter().map(|b| (b.id.as_str(), b.name.as_str())).collect();
    let card_head_attrs = format!(r#" font-size="{}" font-weight="{}""#, num(small), ctx.theme.heading_weight());
    let card_body_attrs = format!(r#" font-size="{}""#, num(small));
    let mut push_card = |kind: &str, heading: &str, frame: &str, raw: &str| {
        let head_text = match names.get(frame) {
            Some(n) => format!("{heading} · {frame} {n}"),
            None => format!("{heading} · {frame}"),
        };
        let head = layout_label(Some(&head_text), false, ctx.measurer, small, text_room, TextStyle::BOLD, None, None);
        let body = literal_label(&decode_entities(raw), ctx.measurer, small, text_room, TextStyle::NONE);
        let w = card_width.max(head.width + 2.0 * BOX_PAD_X).max(body.width + 2.0 * BOX_PAD_X);
        let h = 2.0 * BOX_PAD_Y + head.height + body.height;
        let rows: Vec<String> = body.lines.iter().map(|l| l.iter().map(|s| s.text.as_str()).collect::<String>()).collect();
        cards_svg.push_str(&format!(
            r#"<g class="pele-em-{kind}" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>{}{}</g>"#,
            esc_text(frame),
            num(pad),
            num(y),
            num(w),
            num(h),
            ctx.theme.bg(),
            ctx.theme.border(),
            label_svg(
                &head,
                pad + BOX_PAD_X + head.width / 2.0,
                y + BOX_PAD_Y + head.height / 2.0,
                &card_head_attrs,
                ctx.theme,
                None
            ),
            lines_svg(
                &rows,
                pad + BOX_PAD_X,
                y + BOX_PAD_Y + head.height + body.line_height / 2.0 + small * 0.35,
                body.line_height,
                &card_body_attrs,
            ),
        ));
        bottom = y + h;
        y = bottom + CARD_GAP;
        width = width.max(w);
    };
    for note in &model.notes {
        push_card("note", "Note", &note.frame, &note.text);
    }
    for spec in &model.specifications {
        let mut rows = vec![format!("Given  {}", spec.given.join(", "))];
        if !spec.when.is_empty() {
            rows.push(format!("When  {}", spec.when.join(", ")));
        }
        rows.push(format!("Then  {}", spec.then.join(", ")));
        push_card("specification", "Given / When / Then", &spec.frame, &rows.join("\n"));
    }

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (bottom + pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{edges_svg}{nodes_svg}{cards_svg}",
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
    );
    let svg = svg_document(
        "eventmodeling",
        total_width,
        total_height,
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
        width: total_width,
        height: total_height,
        links: Vec::new(),
    }
}
