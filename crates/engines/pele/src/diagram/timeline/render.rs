use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{fit_label, plain_label, turn_to_fit};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::edges::{ARROW, marker};
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::Label;
use crate::util::yaml::YamlValue;

use super::db::{TimelineDirection, TimelineModel};

const PAD_X: f64 = 12.0;
const PAD_Y: f64 = 8.0;
const MIN_TEXT: f64 = 152.0;
const MAX_TEXT: f64 = 216.0;
const EVENT_TEXT_TD: f64 = 264.0;
const GAP: f64 = 20.0;
const AXIS: f64 = 20.0;
const SPINE: f64 = 14.0;
const EVENT_GAP: f64 = 8.0;
const SECTION_GAP: f64 = 8.0;
const TAIL: f64 = 12.0;

struct Group {
    section: isize,
    periods: Vec<usize>,
}

pub fn render_timeline(model: &TimelineModel, ctx: &RenderContext<'_>) -> Rendered {
    match model.direction {
        TimelineDirection::Td => draw(model, ctx, true),
        TimelineDirection::Lr => turn_to_fit(ctx.options, |down| draw(model, ctx, down)),
    }
}

fn draw(model: &TimelineModel, ctx: &RenderContext<'_>, vertical: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let multicolor = ctx
        .config
        .section("timeline")
        .and_then(|s| s.get("disableMulticolor"))
        .and_then(YamlValue::as_bool)
        != Some(true);
    let periods = &model.periods;
    let has_sections = !model.sections.is_empty();

    let mut groups: Vec<Group> = (0..model.sections.len())
        .map(|s| Group {
            section: s as isize,
            periods: Vec::new(),
        })
        .collect();
    let mut leading = Group {
        section: -1,
        periods: Vec::new(),
    };
    for (i, period) in periods.iter().enumerate() {
        if period.section_index >= 0 && (period.section_index as usize) < groups.len() {
            groups[period.section_index as usize].periods.push(i);
        } else {
            leading.periods.push(i);
        }
    }
    if !leading.periods.is_empty() {
        groups.insert(0, leading);
    }

    let room = match ctx.options.max_width {
        Some(mw) if vertical && mw > 0.0 => mw - 2.0 * pad,
        _ => f64::INFINITY,
    };
    let taken = AXIS + SPINE * 2.0 + 4.0 * PAD_X;
    let period_text = MIN_TEXT.min(80.0f64.max(((room - taken) * 0.38).round()));
    let event_text = EVENT_TEXT_TD.min(110.0f64.max(room - taken - period_text));
    let mut text_w = period_text;
    let event_text_w = |tw: f64| if vertical { event_text } else { tw };

    let mut period_labels: Vec<Label> = periods
        .iter()
        .map(|p| plain_label(Some(&p.text), ctx.measurer, size, text_w, TextStyle::NONE))
        .collect();
    let mut event_labels: Vec<Vec<Label>> = periods
        .iter()
        .map(|p| {
            p.events
                .iter()
                .map(|e| plain_label(Some(e), ctx.measurer, small, event_text_w(text_w), TextStyle::NONE))
                .collect()
        })
        .collect();

    let mut widest = 0.0f64;
    for label in &period_labels {
        widest = widest.max(label.width);
    }
    if !vertical {
        for labels in &event_labels {
            for label in labels {
                widest = widest.max(label.width);
            }
        }
    }
    let mut overflow = widest > text_w;
    if vertical {
        for labels in &event_labels {
            for label in labels {
                overflow |= label.width > event_text;
            }
        }
    }
    if overflow {
        let cap = if room.is_infinite() { MAX_TEXT } else { period_text };
        text_w = widest.ceil().max(period_text).min(cap);
        period_labels = periods
            .iter()
            .map(|p| fit_label(Some(&p.text), ctx.measurer, size, text_w, TextStyle::NONE))
            .collect();
        event_labels = periods
            .iter()
            .map(|p| {
                p.events
                    .iter()
                    .map(|e| fit_label(Some(e), ctx.measurer, small, event_text_w(text_w), TextStyle::NONE))
                    .collect()
            })
            .collect();
    }

    let line_height = (size * 1.5).round();
    let small_line_height = (small * 1.5).round();
    let col_w = text_w + 2.0 * PAD_X;
    let event_w = event_text_w(text_w) + 2.0 * PAD_X;
    let chip_height = |label: &Label| label.height.max(line_height) + 2.0 * PAD_Y;
    let event_height = |label: &Label| label.height.max(small_line_height) + 2.0 * PAD_Y;

    let series_of = |group: &Group, period_idx: usize| -> Option<usize> {
        if group.section >= 0 {
            Some(group.section as usize)
        } else if has_sections {
            None
        } else if multicolor {
            Some(period_idx)
        } else {
            Some(0)
        }
    };
    let color_of = |group: &Group, period_idx: usize| -> String {
        match series_of(group, period_idx) {
            None => ctx.theme.muted().to_string(),
            Some(s) => ctx.theme.series_color(s, ctx.palette).into_owned(),
        }
    };
    let on_color_default = format!(r#" fill="{}""#, ctx.theme.bg());
    let on_color = |series: Option<usize>| -> String {
        if let Some(s) = series {
            let ink = ctx.palette.series_ink_fill(s, ctx.theme);
            if !ink.is_empty() {
                return ink;
            }
        }
        on_color_default.clone()
    };
    let line_attrs = format!(r#" fill="none" stroke="{}""#, ctx.theme.border());

    let has_events = event_labels.iter().any(|l| !l.is_empty());
    let slots: usize = groups.iter().map(|g| g.periods.len().max(1)).sum();
    let pitch = col_w + GAP;
    let drawn = !periods.is_empty();
    let body_w = if vertical {
        col_w
            + if has_events {
                AXIS + SPINE * 2.0 + event_w
            } else if drawn {
                AXIS + TAIL
            } else {
                0.0
            }
    } else if slots > 0 {
        slots as f64 * pitch - GAP + if drawn { TAIL + ARROW } else { 0.0 }
    } else {
        0.0
    };

    let title = fit_label(model.title.as_deref(), ctx.measurer, size, body_w.max(320.0), TextStyle::BOLD);
    let title_h = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let width = body_w.max(title.width);
    let left = pad + (width - body_w) / 2.0;
    let top = pad + title_h;

    let box_svg = |x: f64, y: f64, w: f64, h: f64, attrs: &str| -> String {
        format!(
            r#"<rect x="{}" y="{}" width="{}" height="{}"{}/>"#,
            num(x),
            num(y),
            num(w),
            num(h),
            ctx.theme.rounded(attrs),
        )
    };
    let section_label = |group: &Group, w: f64| -> Label {
        fit_label(
            Some(&model.sections[group.section as usize]),
            ctx.measurer,
            size,
            w - 2.0 * PAD_X,
            TextStyle::BOLD,
        )
    };
    let header_svg = |group: &Group, label: &Label, x: f64, y: f64, w: f64, h: f64| -> String {
        let s = group.section as usize;
        let fill = format!(r#" fill="{}""#, ctx.theme.series_color(s, ctx.palette));
        let label_attrs = format!(r#" font-weight="{}"{}"#, ctx.theme.heading_weight(), on_color(Some(s)));
        format!(
            "{}{}",
            box_svg(x, y, w, h, &fill),
            label_svg(label, x + w / 2.0, y + h / 2.0, &label_attrs, ctx.theme, None),
        )
    };
    let period_svg = |i: usize, group: &Group, color: &str, x: f64, y: f64, h: f64| -> String {
        let fill = format!(r#" fill="{color}""#);
        let label_attrs = on_color(series_of(group, i));
        format!(
            "{}{}",
            box_svg(x, y, col_w, h, &fill),
            label_svg(&period_labels[i], x + col_w / 2.0, y + h / 2.0, &label_attrs, ctx.theme, None),
        )
    };
    let event_svg = |label: &Label, color: &str, x: f64, y: f64, h: f64| -> String {
        let fill = format!(r#" fill="{color}" fill-opacity="0.16""#);
        let label_attrs = format!(r#" font-size="{}""#, num(small));
        format!(
            r#"<g class="pele-node pele-event">{}{}</g>"#,
            box_svg(x, y, event_w, h, &fill),
            label_svg(label, x + event_w / 2.0, y + h / 2.0, &label_attrs, ctx.theme, None),
        )
    };
    let dot_svg = |x: f64, y: f64, color: &str| -> String {
        format!(
            r#"<circle class="pele-dot" cx="{}" cy="{}" r="4" fill="{color}" stroke="{}" stroke-width="2"/>"#,
            num(x),
            num(y),
            ctx.theme.bg(),
        )
    };
    let open_group = |group: &Group| -> String {
        if group.section >= 0 {
            format!(
                r#"<g class="pele-cluster pele-section" data-id="{}">"#,
                esc_text(model.sections[group.section as usize].trim()),
            )
        } else {
            String::new()
        }
    };
    let open_period = |i: usize| -> String { format!(r#"<g class="pele-node pele-period" data-id="{}">"#, esc_text(periods[i].text.trim())) };

    let mut body = String::new();
    let height: f64 = if vertical {
        let axis_x = left + col_w + AXIS;
        let spine_x = axis_x + SPINE;
        let events_x = spine_x + SPINE;
        let mut y = top;
        for group in &groups {
            body.push_str(&open_group(group));
            if group.section >= 0 {
                let label = section_label(group, body_w);
                let h = chip_height(&label);
                body.push_str(&header_svg(group, &label, left, y, body_w, h));
                y += h + SECTION_GAP + 4.0;
            }
            for &i in &group.periods {
                let color = color_of(group, i);
                let h = chip_height(&period_labels[i]);
                let first = event_labels[i].first().map_or(h, event_height);
                let cy = y + h.max(first) / 2.0;
                let mut d = format!("M{},{}H{}", num(left + col_w), num(cy), num(axis_x));
                let mut cards = String::new();
                let mut ey = cy - first / 2.0;
                let mut last = cy;
                for label in &event_labels[i] {
                    let eh = event_height(label);
                    last = ey + eh / 2.0;
                    d.push_str(&format!("M{},{}H{}", num(spine_x), num(last), num(events_x)));
                    cards.push_str(&event_svg(label, &color, events_x, ey, eh));
                    ey += eh + EVENT_GAP;
                }
                if !cards.is_empty() {
                    d.push_str(&format!("M{},{}H{}V{}", num(axis_x), num(cy), num(spine_x), num(last)));
                }
                body.push_str(&open_period(i));
                body.push_str(&period_svg(i, group, &color, left, cy - h / 2.0, h));
                body.push_str(&format!(r#"<path class="pele-edge" d="{d}"{line_attrs}/>"#));
                body.push_str(&dot_svg(axis_x, cy, &color));
                body.push_str(&cards);
                body.push_str("</g>");
                y = (cy + h / 2.0).max(ey - EVENT_GAP) + GAP;
            }
            if group.periods.is_empty() {
                y += GAP - SECTION_GAP - 4.0;
            }
            if group.section >= 0 {
                body.push_str("</g>");
            }
        }
        if !groups.is_empty() {
            y -= GAP;
        }
        if drawn {
            let tip = y + TAIL + ARROW;
            let axis = format!(
                r#"<path class="pele-axis" d="M{},{}V{}" fill="none" stroke="{}"/>{}"#,
                num(axis_x),
                num(top),
                num(tip - ARROW + 1.0),
                ctx.theme.line(),
                marker("arrow_point", axis_x, tip, 0.0, 1.0, ctx.theme.line(), "none"),
            );
            body.insert_str(0, &axis);
            y = tip;
        }
        y + pad
    } else {
        let mut header_h = 0.0f64;
        let section_labels: Vec<Option<Label>> = groups
            .iter()
            .map(|group| {
                if group.section < 0 {
                    return None;
                }
                let span = group.periods.len().max(1) as f64;
                let label = section_label(group, span * pitch - GAP);
                header_h = header_h.max(chip_height(&label));
                Some(label)
            })
            .collect();
        let mut chip_h = 0.0f64;
        for label in &period_labels {
            chip_h = chip_h.max(chip_height(label));
        }
        let periods_y = top + if has_sections { header_h + SECTION_GAP } else { 0.0 };
        let axis_y = periods_y + chip_h + if chip_h > 0.0 { AXIS } else { 0.0 };
        let events_y = axis_y + AXIS;
        let mut bottom = if drawn { axis_y + TAIL } else { top + header_h };
        let mut slot = 0usize;
        for (g, group) in groups.iter().enumerate() {
            let span = group.periods.len().max(1);
            let gx = left + slot as f64 * pitch;
            body.push_str(&open_group(group));
            if let Some(label) = &section_labels[g] {
                body.push_str(&header_svg(group, label, gx, top, span as f64 * pitch - GAP, header_h));
            }
            for (k, &i) in group.periods.iter().enumerate() {
                let color = color_of(group, i);
                let x = gx + k as f64 * pitch;
                let cx = x + col_w / 2.0;
                let stem_end = if event_labels[i].is_empty() { axis_y } else { events_y };
                let mut d = format!("M{},{}V{}", num(cx), num(periods_y + chip_h), num(stem_end));
                let mut cards = String::new();
                let mut ey = events_y;
                for event_label in &event_labels[i] {
                    let eh = event_height(event_label);
                    if ey > events_y {
                        d.push_str(&format!("M{},{}V{}", num(cx), num(ey - EVENT_GAP), num(ey)));
                    }
                    cards.push_str(&event_svg(event_label, &color, x, ey, eh));
                    ey += eh + EVENT_GAP;
                }
                bottom = bottom.max(ey - EVENT_GAP);
                body.push_str(&open_period(i));
                body.push_str(&period_svg(i, group, &color, x, periods_y, chip_h));
                body.push_str(&format!(r#"<path class="pele-edge" d="{d}"{line_attrs}/>"#));
                body.push_str(&dot_svg(cx, axis_y, &color));
                body.push_str(&cards);
                body.push_str("</g>");
            }
            if group.section >= 0 {
                body.push_str("</g>");
            }
            slot += span;
        }
        if drawn {
            let tip = left + body_w;
            let axis = format!(
                r#"<path class="pele-axis" d="M{},{}H{}" fill="none" stroke="{}"/>{}"#,
                num(left),
                num(axis_y),
                num(tip - ARROW + 1.0),
                ctx.theme.line(),
                marker("arrow_point", tip, axis_y, 1.0, 0.0, ctx.theme.line(), "none"),
            );
            body.insert_str(0, &axis);
        }
        bottom + pad
    };

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = height.max(pad * 2.0).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{body}",
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
    );
    let svg = svg_document(
        "timeline",
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
