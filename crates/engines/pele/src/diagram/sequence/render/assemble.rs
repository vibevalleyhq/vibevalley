use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::title_room;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{class_names, resolve_style};
use crate::svg::title::title_label;
use crate::text::literal::break_label;

use super::super::actors::draw_actor;
use super::super::db::SeqDb;
use super::layout::{Column, HorizontalLayout};
use super::style::{InkCache, Metrics};
use super::timeline::TimelineOutput;

pub(super) enum DrawOutcome {
    Done(Rendered),
    Retry(f64),
}

pub(super) fn finish_sequence<'a>(
    db: &'a SeqDb,
    ctx: &RenderContext<'_>,
    m: &Metrics,
    layout: HorizontalLayout<'a>,
    mut timeline: TimelineOutput<'a>,
    inks: &mut InkCache,
) -> DrawOutcome {
    let mut actors_out = String::new();
    let mut actor_svg = |col: &Column<'_>, top: f64, footer: bool| -> String {
        let cls = col.actor.properties.get("class").and_then(|v| v.as_str()).map(class_names).unwrap_or_default();
        let fig_ink = if col.kind.is_figure() {
            let bf = col.actor.box_idx.map(|bi| db.boxes[bi].fill.as_str());
            inks.get(bf, ctx.theme).map_or_else(String::new, |c| format!(r#" fill="{c}""#))
        } else {
            String::new()
        };
        format!(
            r#"<g class="pele-node pele-actor pele-actor-{}{}{cls}" data-id="{}">{}</g>"#,
            col.kind.as_str(),
            if footer { " pele-actor-footer" } else { "" },
            esc_text(col.id),
            draw_actor(col.kind, col.x, top, col.size, &col.label, ctx.theme, ctx.icons, &fig_ink),
        )
    };

    let y = timeline.y;
    let mut bottom = y;
    if m.mirror {
        let mut foot_h = 0.0f64;
        for col in &layout.cols {
            if col.life_end >= 0.0 {
                continue;
            }
            foot_h = foot_h.max(col.size.h);
            actors_out.push_str(&actor_svg(col, y, true));
        }
        bottom = y + foot_h;
    }

    let mut lifelines = String::new();
    for col in &layout.cols {
        actors_out.push_str(&actor_svg(col, col.top, false));
        let end = if col.life_end >= 0.0 { col.life_end } else { y };
        if end > col.life_start {
            lifelines.push_str(&format!(
                r#"<path class="pele-lifeline" data-id="{}" d="M{},{}V{}"/>"#,
                esc_text(col.id),
                num(col.x),
                num(col.life_start),
                num(end),
            ));
        }
    }

    let mut boxes_out = String::new();
    for (idx, run) in layout.runs.iter().enumerate() {
        let (x0, x1, fill_str) = timeline.box_ranges[idx];
        let fill = if fill_str == "transparent" {
            String::new()
        } else {
            resolve_style(&[format!("fill:{fill_str}")]).shape
        };
        let box_style = if fill.is_empty() { r#" fill-opacity="0.5""#.to_string() } else { fill };
        let title_fill = inks
            .get(Some(fill_str), ctx.theme)
            .map(|c| format!(r#" fill="{c}""#))
            .unwrap_or_else(|| format!(r#" fill="{}""#, ctx.theme.muted()));
        let data_id = run
            .box_ref
            .name
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or_else(String::new, |n| format!(r#" data-id="{}""#, esc_text(n)));
        boxes_out.push_str(&format!(
            r#"<g class="pele-cluster pele-box"{data_id}><rect x="{}" y="0" width="{}" height="{}" fill="{}" stroke="{}"{}/>{}</g>"#,
            num(x0),
            num(x1 - x0),
            num(bottom + m.box_pad),
            ctx.theme.surface_alt(),
            ctx.theme.border(),
            ctx.theme.rounded(&box_style),
            label_svg(
                &run.title,
                (x0 + x1) / 2.0,
                m.box_pad / 2.0 + 2.0 + run.title.height / 2.0,
                &format!(r#" class="pele-cluster-label"{title_fill}"#),
                ctx.theme,
                ctx.icons,
            ),
        ));
    }
    if !layout.runs.is_empty() {
        bottom += m.box_pad;
    }

    let mut min_x = layout.min_x;
    let mut max_x = layout.max_x;
    let mut min_y = 0.0f64;
    let mut title_out = String::new();
    let room = title_room(ctx.options);
    let plain_title = title_label(db.title.as_deref(), ctx.measurer, m.size, if m.tight { room } else { f64::INFINITY });
    let title = if m.tight {
        break_label(plain_title, ctx.measurer, 120.0f64.max(room))
    } else {
        plain_title
    };
    if min_x > max_x {
        min_x = 0.0;
        max_x = title.width.max(40.0);
    }
    if title.width > 0.0 {
        let cx = (min_x + max_x) / 2.0;
        if cx - title.width / 2.0 < min_x {
            min_x = cx - title.width / 2.0;
        }
        if cx + title.width / 2.0 > max_x {
            max_x = cx + title.width / 2.0;
        }
        min_y = -title.height - 12.0;
        let t_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
        title_out = label_svg(&title, cx, min_y + title.height / 2.0, &t_attrs, ctx.theme, ctx.icons);
    }

    let width = (max_x - min_x + 2.0 * m.pad).ceil();
    if layout.grown
        && let Some(max_width) = ctx.options.max_width
        && width > max_width
    {
        let next_hold = if layout.uneven {
            layout.hold
        } else if layout.hold > 0.0 {
            f64::INFINITY
        } else {
            width - max_width.floor()
        };
        return DrawOutcome::Retry(next_hold);
    }

    let height = (bottom - min_y + 2.0 * m.pad).ceil();
    timeline.rects_out.reverse();
    timeline.activations_out.reverse();

    let mut body = format!(r#"<g transform="translate({},{})">{title_out}"#, num(m.pad - min_x), num(m.pad - min_y),);
    if !boxes_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-boxes" font-size="{}">{boxes_out}</g>"#, num(m.small)));
    }
    if !timeline.rects_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-rects" fill="{}">{}</g>"#,
            ctx.theme.surface_alt(),
            timeline.rects_out.concat(),
        ));
    }
    if !lifelines.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-lifelines" fill="none" stroke="{}">{lifelines}</g>"#,
            ctx.theme.border(),
        ));
    }
    if !timeline.activations_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-activations" fill="{}" stroke="{}">{}</g>"#,
            ctx.theme.surface(),
            ctx.theme.border(),
            timeline.activations_out.concat(),
        ));
    }
    if !timeline.frames_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-frames" font-size="{}" stroke="{}">{}</g>"#,
            num(m.small),
            ctx.theme.border(),
            timeline.frames_out,
        ));
    }
    if !timeline.edges_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{}</g>"#,
            ctx.theme.line(),
            timeline.edges_out,
        ));
    }
    if !timeline.crosses_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-destroys" fill="none" stroke="{}" stroke-width="1.5" stroke-linecap="round">{}</g>"#,
            ctx.theme.line(),
            timeline.crosses_out,
        ));
    }
    if !timeline.labels_out.is_empty() {
        let mono_attr = if m.monospaced {
            format!(r#" font-family="{}""#, ctx.theme.font_mono())
        } else {
            String::new()
        };
        body.push_str(&format!(
            r#"<g class="pele-edge-labels" font-size="{}"{mono_attr}>{}</g>"#,
            num(m.small),
            timeline.labels_out,
        ));
    }
    if !timeline.notes_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-notes" font-size="{}" fill="{}" stroke="{}">{}</g>"#,
            num(m.small),
            ctx.theme.surface_alt(),
            ctx.theme.border(),
            timeline.notes_out,
        ));
    }
    if !actors_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-nodes">{actors_out}</g>"#));
    }
    body.push_str("</g>");

    let svg = svg_document(
        "sequence",
        width,
        height,
        m.size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: db.acc_title.as_deref(),
            acc_descr: db.acc_descr.as_deref(),
        },
        &body,
    );

    DrawOutcome::Done(Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    })
}
