use std::collections::{HashMap, HashSet};

use crate::diagram::RenderContext;
use crate::diagram::common::{tighten, title_room};
use crate::error::PeleError;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::edges::{ARROW, EdgePath, Fill, OverFill, casings_svg, edge_casing, marker, marker_trim, over_fills};
use crate::svg::ink::{ink_fill, paints};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::draw_shape;
use crate::svg::theme::{ResolvedStyle, resolve_style};
use crate::text::label::layout_label;
use crate::text::literal::left_label_svg;
use crate::util::url::{linked, sanitize_url};
use crate::{LinkInfo, RenderOptions, Rendered};

use super::db::C4Db;
use super::layout::{HEAD_LEFT, HEAD_TOP, layout_c4};
use super::route::{C4Box, C4Form, HEAD, LABEL_PAD, LANE, Lanes, crosses, cyl_ry, queue_rx, route};
use super::types::C4RelKind;

const PAIR_SHIFT: f64 = 7.0;
const NARROW_GAP: f64 = 36.0;
const WIDEN: f64 = 24.0;
const MAX_OFFSET: f64 = 2000.0;
const EDGE: f64 = 8.0;
const SLIDE: [f64; 7] = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
const CARE_BUDGET: usize = 2_000_000;

fn user_style(fill: Option<&str>, stroke: Option<&str>, color: Option<&str>) -> ResolvedStyle {
    let mut decls = Vec::new();
    if let Some(f) = fill
        && !f.is_empty()
    {
        decls.push(format!("fill:{f}"));
    }
    if let Some(s) = stroke
        && !s.is_empty()
    {
        decls.push(format!("stroke:{s}"));
    }
    if let Some(c) = color
        && !c.is_empty()
    {
        decls.push(format!("color:{c}"));
    }
    resolve_style(&decls)
}

fn wrap_link(body: &str, url: Option<&str>, id: &str, links: &mut Vec<LinkInfo>, options: &RenderOptions<'_>) -> String {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return body.to_string();
    };
    let restored = if url.contains("¶ß") {
        url.replace("ﬂ°°", "#").replace("ﬂ°", "#").replace("¶ß", ";")
    } else {
        url.to_string()
    };
    let clean = sanitize_url(&restored);
    linked(body, &clean, id, links, options, "")
}

pub fn try_render_c4(db: &C4Db, ctx: &RenderContext<'_>) -> Result<Rendered, PeleError> {
    db.validate_rels()?;
    Ok(render_c4(db, ctx))
}

pub fn render_c4(db: &C4Db, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| {
        if !tight {
            return draw(db, ctx, false, NARROW_GAP).0;
        }
        let (mut best, mut squeezed) = draw(db, ctx, true, NARROW_GAP);
        let mut gap = NARROW_GAP + WIDEN;
        while squeezed > 0 && gap <= NARROW_GAP + 3.0 * WIDEN {
            let (wider, left) = draw(db, ctx, true, gap);
            if left < squeezed {
                best = wider;
                squeezed = left;
            }
            gap += WIDEN;
        }
        best
    })
}

fn draw(db: &C4Db, ctx: &RenderContext<'_>, tight: bool, gap: f64) -> (Rendered, usize) {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.8125).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let mut links: Vec<LinkInfo> = Vec::new();
    let room = tight.then(|| 80.0f64.max(ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad));
    let mut layout = layout_c4(db, ctx.measurer, size, small, room, gap);

    let root_rect = layout.groups[0].box_rect;
    let mut min_x = 0.0f64;
    let mut min_y = 0.0f64;
    let mut max_x = root_rect.w;
    let mut max_y = root_rect.h;
    let mut grow = |x0: f64, y0: f64, x1: f64, y1: f64| {
        min_x = min_x.min(x0);
        min_y = min_y.min(y0);
        max_x = max_x.max(x1);
        max_y = max_y.max(y1);
    };

    let mut ends: Vec<(usize, C4Box, C4Box)> = Vec::with_capacity(db.rels.len());
    let mut pairs: HashMap<usize, HashSet<usize>> = HashMap::new();
    for (idx, rel) in db.rels.iter().enumerate() {
        let from_ref = if rel.from_attr.is_some() { None } else { db.get_c4_shape(&rel.from) };
        let to_ref = if rel.to_attr.is_some() { None } else { db.get_c4_shape(&rel.to) };
        let (Some(a), Some(b)) = (
            from_ref.and_then(|r| layout.boxes.get(&r).copied()),
            to_ref.and_then(|r| layout.boxes.get(&r).copied()),
        ) else {
            continue;
        };
        ends.push((idx, a, b));
        pairs.entry(a.id).or_default().insert(b.id);
    }

    let mut nodes: Vec<C4Box> = Vec::new();
    let mut taken: Vec<[f64; 4]> = Vec::new();
    for &g_idx in &layout.order {
        for node in &layout.groups[g_idx].nodes {
            let b = node.box_rect;
            nodes.push(b);
            taken.push([b.x + EDGE, b.y + EDGE, b.x + b.w - EDGE, b.y + b.h - EDGE]);
        }
    }
    let careful = db.rels.len().saturating_mul(nodes.len() + layout.order.len() + 3 * db.rels.len()) <= CARE_BUDGET;
    let covered = |taken: &[[f64; 4]], x0: f64, y0: f64, x1: f64, y1: f64| -> f64 {
        let mut area = 0.0;
        for &[tx0, ty0, tx1, ty1] in taken {
            let w = x1.min(tx1) - x0.max(tx0);
            if w <= 0.0 {
                continue;
            }
            let h = y1.min(ty1) - y0.max(ty0);
            if h > 0.0 {
                area += w * h;
            }
        }
        area
    };
    let clamp_offset = |value: Option<f64>| -> f64 {
        match value {
            Some(v) if v.is_finite() && v != 0.0 => v.clamp(-MAX_OFFSET, MAX_OFFSET),
            _ => 0.0,
        }
    };

    let mut casings = String::new();
    let mut edges_out = String::new();
    let trim = marker_trim("arrow_point");
    let mut fills: Vec<Fill> = Vec::new();
    for &g_idx in &layout.order {
        if g_idx == 0 {
            continue;
        }
        let g = &layout.groups[g_idx];
        let shape = user_style(db.boundaries[g.boundary_idx].el.bg_color.as_deref(), None, None).shape;
        if paints(&shape) {
            let b = g.box_rect;
            fills.push(Fill {
                bounds: [b.x, b.y, b.x + b.w, b.y + b.h],
                shape,
            });
        }
    }
    let mut lanes = Lanes::new();
    for &g_idx in &layout.order {
        if g_idx != 0 {
            lanes.frame(&layout.groups[g_idx].box_rect);
        }
    }

    let mut routes = Vec::with_capacity(ends.len());
    for &(rel_idx, a, b) in &ends {
        let rel = &db.rels[rel_idx];
        let style = user_style(None, rel.line_color.as_deref(), None);
        let start_arrow = matches!(rel.rel_type, C4RelKind::BiRel | C4RelKind::RelB);
        let end_arrow = rel.rel_type != C4RelKind::RelB;
        let reverse = a.id != b.id && pairs.get(&b.id).is_some_and(|set| set.contains(&a.id));
        let r = route(
            &a,
            &b,
            if reverse { PAIR_SHIFT } else { 0.0 },
            if careful { Some(nodes.as_slice()) } else { None },
            &mut lanes,
            if start_arrow { trim } else { 0.0 },
            if end_arrow { trim } else { 0.0 },
        );
        grow(r.x0.min(r.x1), r.y0.min(r.y1), r.x0.max(r.x1), r.y0.max(r.y1));
        if start_arrow && careful {
            taken.push([r.sx - ARROW, r.sy - ARROW, r.sx + ARROW, r.sy + ARROW]);
        }
        if end_arrow && careful {
            taken.push([r.ex - ARROW, r.ey - ARROW, r.ex + ARROW, r.ey + ARROW]);
        }
        let over = over_fills(&r.d, &[r.sx, r.sy, r.ex, r.ey], &fills, &style.line, None, ctx.theme);
        let (stroke_attr, color) = match over {
            OverFill::Ink(c) => (format!(r#" stroke="{c}""#), c),
            OverFill::Casing => {
                let ep = EdgePath {
                    d: r.d.clone(),
                    tokens: None,
                    sx: r.sx,
                    sy: r.sy,
                    sdx: r.sdx,
                    sdy: r.sdy,
                    ex: r.ex,
                    ey: r.ey,
                    edx: r.edx,
                    edy: r.edy,
                };
                casings.push_str(&edge_casing(
                    &ep,
                    if start_arrow { "arrow_point" } else { "none" },
                    if end_arrow { "arrow_point" } else { "none" },
                    &style.line,
                    false,
                    ctx.theme,
                ));
                let c = style.stroke.as_deref().map_or_else(|| ctx.theme.line().to_string(), esc);
                (String::new(), c)
            }
            OverFill::None => {
                let c = style.stroke.as_deref().map_or_else(|| ctx.theme.line().to_string(), esc);
                (String::new(), c)
            }
        };
        let id = format!("{}-{}", rel.from, rel.to);
        edges_out.push_str(&format!(
            r#"<g class="pele-edge" data-id="{}"{stroke_attr}{}><path d="{}"/>{}{}</g>"#,
            esc_text(&id),
            style.line,
            r.d,
            if start_arrow {
                marker("arrow_point", r.sx, r.sy, r.sdx, r.sdy, &color, "none")
            } else {
                String::new()
            },
            if end_arrow {
                marker("arrow_point", r.ex, r.ey, r.edx, r.edy, &color, "none")
            } else {
                String::new()
            },
        ));
        routes.push((rel_idx, r));
    }

    for &g_idx in &layout.order {
        if !careful || layout.groups[g_idx].head_w == 0.0 {
            continue;
        }
        let b = layout.groups[g_idx].box_rect;
        let head = layout.groups[g_idx].head;
        let head_w = layout.groups[g_idx].head_w;
        let top = b.y + HEAD_TOP;
        let bottom = b.y + head - LANE;
        let mut fewest = usize::MAX;
        let mut chosen = layout.groups[g_idx].head_x;
        for x in [HEAD_LEFT, (b.w - head_w) / 2.0, b.w - HEAD_LEFT - head_w] {
            let mut count = 0usize;
            for (_, r) in &routes {
                if crosses(&r.points, b.x + x - 4.0, top, b.x + x + head_w + 4.0, bottom) {
                    count += 1;
                }
            }
            if count < fewest {
                fewest = count;
                chosen = x;
            }
            if count == 0 {
                break;
            }
        }
        layout.groups[g_idx].head_x = chosen;
        taken.push([b.x + chosen - 4.0, top, b.x + chosen + head_w + 4.0, bottom]);
    }

    let mut labels_out = String::new();
    let is_dynamic = db.c4_type.as_deref() == Some("C4Dynamic");
    for (rel_idx, r) in &routes {
        let rel = &db.rels[*rel_idx];
        let id = format!("{}-{}", rel.from, rel.to);
        let style = user_style(None, None, rel.text_color.as_deref());
        let text = if is_dynamic {
            format!("{}: {}", rel_idx + 1, rel.label)
        } else {
            rel.label.clone()
        };
        let label = layout_label(Some(&text), false, ctx.measurer, small, r.room, TextStyle::NONE, None, None);
        let techn_text = rel.techn.as_deref().filter(|s| !s.is_empty()).map(|t| format!("[{t}]"));
        let techn = layout_label(techn_text.as_deref(), false, ctx.measurer, small, r.room, TextStyle::ITALIC, None, None);
        let lw = label.width.max(techn.width) + LABEL_PAD;
        let lh = label.height + techn.height;
        if lh == 0.0 {
            continue;
        }
        let beside = r.nx.abs() * (lw / 2.0) + r.ny.abs() * (lh / 2.0) + 2.0;
        let aside = if r.lean != 0.0 { 0.0f64.max(r.lean.min(beside - 14.0)) } else { beside };
        let mut dx = r.nx * aside + if tight { 0.0 } else { clamp_offset(rel.offset_x) };
        let mut dy = r.ny * aside + if tight { 0.0 } else { clamp_offset(rel.offset_y) };
        let mut at = 0.5f64;
        if careful {
            let mut least = f64::INFINITY;
            let moved = dx != r.nx * aside || dy != r.ny * aside;
            let passes = if moved { 2 } else { 1 };
            for pass in 0..passes {
                if least <= 0.0 {
                    break;
                }
                let px = if pass != 0 { r.nx * aside } else { dx };
                let py = if pass != 0 { r.ny * aside } else { dy };
                for &t in &SLIDE {
                    let cx = r.x0 + (r.x1 - r.x0) * t + px;
                    let cy = r.y0 + (r.y1 - r.y0) * t + py;
                    let area = covered(&taken, cx - lw / 2.0, cy - lh / 2.0, cx + lw / 2.0, cy + lh / 2.0);
                    if area < least {
                        least = area;
                        at = t;
                        dx = px;
                        dy = py;
                    }
                    if area == 0.0 {
                        break;
                    }
                }
            }
        }
        let cx = r.x0 + (r.x1 - r.x0) * at + dx;
        let top = r.y0 + (r.y1 - r.y0) * at + dy - lh / 2.0;
        if careful {
            taken.push([cx - lw / 2.0, top, cx + lw / 2.0, top + lh]);
        }
        grow(cx - lw / 2.0, top, cx + lw / 2.0, top + lh);
        let tip = rel
            .descr
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or_else(String::new, |d| format!("<title>{}</title>", esc_text(d)));
        let techn_attrs = format!(r#" class="pele-c4-techn" fill="{}"{}"#, ctx.theme.muted(), style.text);
        let inner = format!(
            "{}{}",
            label_svg(&label, cx, top + label.height / 2.0, &style.text, ctx.theme, None),
            label_svg(&techn, cx, top + label.height + techn.height / 2.0, &techn_attrs, ctx.theme, None),
        );
        labels_out.push_str(&format!(
            r#"<g class="pele-edge-label" data-id="{}">{tip}<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}"/>{}</g>"#,
            esc_text(&id),
            num(cx - lw / 2.0),
            num(top),
            num(lw),
            num(lh),
            ctx.theme.bg(),
            wrap_link(&inner, rel.link.as_deref(), &id, &mut links, ctx.options),
        ));
    }

    let mut clusters = String::new();
    let mut nodes_out = String::new();
    for &g_idx in &layout.order {
        let group = &layout.groups[g_idx];
        if g_idx != 0 {
            let boundary = &db.boundaries[group.boundary_idx];
            let style = user_style(
                boundary.el.bg_color.as_deref(),
                boundary.el.border_color.as_deref(),
                boundary.el.font_color.as_deref(),
            );
            let x = group.box_rect.x + group.head_x;
            let mut y = group.box_rect.y + HEAD_TOP;
            let color = format!("{}{}", ink_fill(&style.shape, &style.text, ctx.theme, None), style.text);
            let muted = format!("{}{}", ink_fill(&style.shape, &style.text, ctx.theme, Some(ctx.theme.muted())), style.text);
            let mut text = left_label_svg(
                &group.labels[0],
                x,
                y,
                &format!(r#" class="pele-cluster-label" font-weight="{}"{color}"#, ctx.theme.heading_weight()),
                ctx.theme,
            );
            y += group.labels[0].height;
            text.push_str(&left_label_svg(
                &group.labels[1],
                x,
                y,
                &format!(r#" class="pele-c4-type" font-size="{}"{muted}"#, num(small)),
                ctx.theme,
            ));
            y += group.labels[1].height;
            text.push_str(&left_label_svg(
                &group.labels[2],
                x,
                y,
                &format!(r#" class="pele-c4-descr" font-size="{}"{muted}"#, num(small)),
                ctx.theme,
            ));
            let kind_cls = if boundary.node_type.is_some() { "node" } else { "boundary" };
            let dash = if boundary.node_type.is_some() { "" } else { r#" stroke-dasharray="6 4""# };
            clusters.push_str(&format!(
                r#"<g class="pele-cluster pele-c4-{kind_cls}" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="none" stroke="{}"{dash}{}/>{}</g>"#,
                esc_text(&boundary.el.alias),
                num(group.box_rect.x),
                num(group.box_rect.y),
                num(group.box_rect.w),
                num(group.box_rect.h),
                ctx.theme.border(),
                ctx.theme.rounded(&style.shape),
                wrap_link(&text, boundary.el.link.as_deref(), &boundary.el.alias, &mut links, ctx.options),
            ));
        }
        for node in &group.nodes {
            let shape = &db.shapes[node.shape_idx];
            let external = shape.kind.starts_with("external");
            let style = user_style(shape.el.bg_color.as_deref(), shape.el.border_color.as_deref(), shape.el.font_color.as_deref());
            let stroke = format!(
                r#" stroke="{}"{}"#,
                ctx.theme.border(),
                if external { r#" stroke-dasharray="4 3""# } else { "" }
            );
            let b = node.box_rect;
            let dx = if b.form == C4Form::HCyl { -queue_rx(b.h) / 2.0 } else { 0.0 };
            let dy = match b.form {
                C4Form::Person => HEAD / 2.0,
                C4Form::Cyl => cyl_ry(b.w) / 2.0,
                C4Form::Rect | C4Form::HCyl => 0.0,
            };
            let color = format!("{}{}", ink_fill(&style.shape, &style.text, ctx.theme, None), style.text);
            let muted = format!("{}{}", ink_fill(&style.shape, &style.text, ctx.theme, Some(ctx.theme.muted())), style.text);
            let mut y = dy - node.text_h / 2.0;
            let mut text = label_svg(
                &node.labels[0],
                dx,
                y + node.labels[0].height / 2.0,
                &format!(r#" class="pele-c4-type" font-size="{}"{muted}"#, num(small - 1.0)),
                ctx.theme,
                None,
            );
            y += node.labels[0].height;
            text.push_str(&label_svg(
                &node.labels[1],
                dx,
                y + node.labels[1].height / 2.0,
                &format!(r#" class="pele-label" font-weight="{}"{color}"#, ctx.theme.heading_weight()),
                ctx.theme,
                None,
            ));
            y += node.labels[1].height;
            text.push_str(&label_svg(
                &node.labels[2],
                dx,
                y + node.labels[2].height / 2.0,
                &format!(r#" class="pele-c4-techn" font-size="{}"{muted}"#, num(small)),
                ctx.theme,
                None,
            ));
            y += node.labels[2].height + 4.0;
            text.push_str(&label_svg(
                &node.labels[3],
                dx,
                y + node.labels[3].height / 2.0,
                &format!(r#" class="pele-c4-descr" font-size="{}"{color}"#, num(small)),
                ctx.theme,
                None,
            ));
            let base_fill = if external { ctx.theme.bg() } else { ctx.theme.surface() };
            let shape_attrs = format!(r#" fill="{base_fill}"{stroke}{}"#, style.shape);
            let line_attrs = format!("{stroke}{}", style.line);
            let inner = format!("{}{text}", draw_shape(b.form.shape_kind(), b.w, b.h, &shape_attrs, &line_attrs, ctx.theme));
            let ext_cls = if external { " pele-c4-external" } else { "" };
            nodes_out.push_str(&format!(
                r#"<g class="pele-node pele-shape-{} pele-c4-{}{ext_cls}" data-id="{}" transform="translate({},{})">{}</g>"#,
                b.form.as_str(),
                shape.kind,
                esc_text(&shape.el.alias),
                num(b.x + b.w / 2.0),
                num(b.y + b.h / 2.0),
                wrap_link(&inner, shape.el.link.as_deref(), &shape.el.alias, &mut links, ctx.options),
            ));
        }
    }

    let title = layout_label(
        db.title.as_deref(),
        false,
        ctx.measurer,
        size,
        if tight { title_room(ctx.options) } else { 4000.0 },
        TextStyle::BOLD,
        None,
        None,
    );
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = (max_x - min_x).max(title.width);
    let width = (inner + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();
    let ox = pad - min_x + (inner - (max_x - min_x)) / 2.0;
    let oy = pad + title_height - min_y;

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut inner_svg = String::new();
    if !clusters.is_empty() {
        inner_svg.push_str(&format!(r#"<g class="pele-clusters">{clusters}</g>"#));
    }
    inner_svg.push_str(&casings_svg(&casings, ctx.theme));
    if !edges_out.is_empty() {
        inner_svg.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{edges_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    if !nodes_out.is_empty() {
        inner_svg.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));
    }
    if !labels_out.is_empty() {
        inner_svg.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(small)));
    }
    let content = format!(
        r#"{}<g transform="translate({},{})">{inner_svg}</g>"#,
        label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
        num(ox),
        num(oy),
    );
    let svg = svg_document(
        "c4",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: db.acc_title.as_deref(),
            acc_descr: db.acc_descr.as_deref(),
        },
        &content,
    );
    (Rendered { svg, width, height, links }, lanes.squeezed)
}
