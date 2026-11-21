use std::collections::HashMap;

use crate::Rendered;
use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::edges::{marker, marker_trim};
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::boundaries::{FOLD, HORIZON, WaveOptions, backward, cliff, curve_path, ellipse_path, forward, resolve_seed, wave};
use super::model::{CynefinModel, DomainName};

const QUADRANTS: [(DomainName, usize, usize, usize); 4] = [
    (DomainName::Complex, 0, 0, 0),
    (DomainName::Complicated, 1, 0, 1),
    (DomainName::Chaotic, 0, 1, 3),
    (DomainName::Clear, 1, 1, 2),
];
const CONFUSION_COLOR: usize = 4;

fn domain_meta(name: DomainName) -> (&'static str, &'static str, &'static str) {
    match name {
        DomainName::Complex => ("Complex", "Probe → Sense → Respond", "Emergent Practices"),
        DomainName::Complicated => ("Complicated", "Sense → Analyse → Respond", "Good Practices"),
        DomainName::Clear => ("Clear", "Sense → Categorise → Respond", "Best Practices"),
        DomainName::Chaotic => ("Chaotic", "Act → Sense → Respond", "Novel Practices"),
        DomainName::Confusion => ("Confusion", "", "Disorder"),
    }
}

const MAX_CONFUSION_ITEMS: usize = 3;
const ITEM_MAX_WIDTH: f64 = 200.0;
const ITEM_PAD_X: f64 = 10.0;
const ITEM_PAD_Y: f64 = 4.0;
const ITEM_GAP: f64 = 6.0;
const HEAD_GAP: f64 = 10.0;
const MARGIN: f64 = 20.0;
const CLEARANCE: f64 = 10.0;

struct Badge {
    text: String,
    label: Label,
    w: f64,
    h: f64,
    overflow: bool,
}

struct Block {
    name: DomainName,
    title: Label,
    subtitles: Vec<Label>,
    badges: Vec<Badge>,
    w: f64,
    h: f64,
    cx: f64,
    cy: f64,
}

fn setting(config: &DiagramConfig, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let val = config.section("cynefin").and_then(|s| s.get(key)).and_then(YamlValue::as_f64);
    match val {
        Some(v) if v.is_finite() && v >= min && v <= max => v,
        _ => fallback,
    }
}

pub fn render_cynefin(model: &CynefinModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.8125).round();
    let item_size = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let show_descriptions = ctx
        .config
        .section("cynefin")
        .and_then(|s| s.get("showDomainDescriptions"))
        .and_then(YamlValue::as_bool)
        != Some(false);
    let amplitude = setting(ctx.config, "boundaryAmplitude", 8.0, 0.0, 50.0);
    let seed = resolve_seed(
        Some(setting(ctx.config, "seed", 0.0, -1e15, 1e15)),
        ctx.options.id_prefix.as_deref().unwrap_or("pele"),
    );
    let item_line = (item_size * 1.5).round();

    let make_badge = |text: String, overflow: bool| -> Badge {
        let label = layout_label(Some(&text), false, ctx.measurer, item_size, ITEM_MAX_WIDTH, TextStyle::NONE, ctx.icons, None);
        let w = label.width + 2.0 * ITEM_PAD_X;
        let h = label.height.max(item_line) + 2.0 * ITEM_PAD_Y;
        Badge { text, label, w, h, overflow }
    };

    let make_block = |name: DomainName| -> Block {
        let (title_text, sub1, sub2) = domain_meta(name);
        let title = layout_label(Some(title_text), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, ctx.icons, None);
        let mut subtitles = Vec::new();
        if show_descriptions {
            for t in [sub1, sub2] {
                if !t.is_empty() {
                    subtitles.push(layout_label(Some(t), false, ctx.measurer, small, 4000.0, TextStyle::ITALIC, ctx.icons, None));
                }
            }
        }
        let items = model.domains.get(&name).map_or(&[][..], |d| d.items.as_slice());
        let shown = if name == DomainName::Confusion && items.len() > MAX_CONFUSION_ITEMS {
            MAX_CONFUSION_ITEMS
        } else {
            items.len()
        };
        let mut badges = Vec::new();
        for item in &items[..shown] {
            badges.push(make_badge(item.label.clone(), false));
        }
        if shown < items.len() {
            badges.push(make_badge(format!("+{} more", items.len() - shown), true));
        }
        let mut w = title.width;
        let mut h = title.height;
        for s in &subtitles {
            w = w.max(s.width);
            h += s.height;
        }
        if !badges.is_empty() {
            h += HEAD_GAP - ITEM_GAP;
        }
        for b in &badges {
            w = w.max(b.w);
            h += ITEM_GAP + b.h;
        }
        Block {
            name,
            title,
            subtitles,
            badges,
            w,
            h,
            cx: 0.0,
            cy: 0.0,
        }
    };

    let mut quadrants: Vec<Block> = QUADRANTS.iter().map(|&(name, _, _, _)| make_block(name)).collect();
    let mut confusion = make_block(DomainName::Confusion);
    let rx = 88.0f64.max(confusion.w * 0.71 + 8.0);
    let ry = 64.0f64.max(confusion.h * 0.71 + 6.0);

    let mut quad_w = setting(ctx.config, "width", 640.0, 100.0, 10000.0) / 2.0;
    let mut quad_h = setting(ctx.config, "height", 440.0, 100.0, 10000.0) / 2.0;
    for b in &quadrants {
        quad_w = quad_w.max(b.w + 2.0 * MARGIN);
        quad_h = quad_h.max(b.h + 2.0 * MARGIN);
    }
    for b in &quadrants {
        let dx = (quad_w - b.w) / 2.0;
        let dy = (quad_h - b.h) / 2.0;
        if (dx / (rx + CLEARANCE)).powi(2) + (dy / (ry + CLEARANCE)).powi(2) >= 1.0 {
            continue;
        }
        let wider = b.w + 2.0 * (rx + CLEARANCE);
        let taller = b.h + 2.0 * (ry + CLEARANCE);
        if wider * quad_h <= quad_w * taller {
            quad_w = quad_w.max(wider);
        } else {
            quad_h = quad_h.max(taller);
        }
    }

    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, ctx.icons, None);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let width = 2.0 * quad_w;
    let height = 2.0 * quad_h;
    let x0 = pad;
    let y0 = pad + title_height;
    let cx = x0 + quad_w;
    let cy = y0 + quad_h;
    let right = x0 + width;
    let bottom = y0 + height;

    let fold = wave(
        y0,
        cy,
        cx,
        seed,
        amplitude,
        WaveOptions {
            segments: 4,
            pin_end: true,
            ..FOLD
        },
    );
    let west = wave(
        x0,
        cx,
        cy,
        seed + 100.0,
        amplitude,
        WaveOptions {
            segments: 4,
            pin_end: true,
            ..HORIZON
        },
    );
    let east = wave(
        cx,
        right,
        cy,
        seed + 200.0,
        amplitude,
        WaveOptions {
            segments: 4,
            pin_start: true,
            ..HORIZON
        },
    );
    let drop = cliff(cx, cy, bottom, width * 0.03);
    let at = |curve: &[f64], end: bool| -> String {
        if end {
            format!("{},{}", num(curve[curve.len() - 2]), num(curve[curve.len() - 1]))
        } else {
            format!("{},{}", num(curve[0]), num(curve[1]))
        }
    };

    let region_path = |name: DomainName| -> String {
        match name {
            DomainName::Complex => format!("M{},{}L{}{}{}Z", num(x0), num(y0), at(&fold, false), forward(&fold), backward(&west)),
            DomainName::Complicated => format!(
                "M{}L{},{}L{}{}{}Z",
                at(&fold, false),
                num(right),
                num(y0),
                at(&east, true),
                backward(&east),
                backward(&fold)
            ),
            DomainName::Chaotic => format!("M{}{}{}L{},{}Z", at(&west, false), forward(&west), forward(&drop), num(x0), num(bottom)),
            DomainName::Clear => format!(
                "M{}{}L{},{}L{}{}Z",
                at(&east, false),
                forward(&east),
                num(right),
                num(bottom),
                at(&drop, true),
                backward(&drop)
            ),
            DomainName::Confusion => String::new(),
        }
    };

    let mut fills = String::new();
    for &(name, _, _, color) in &QUADRANTS {
        fills.push_str(&format!(
            r#"<path class="pele-cynefin-region" data-id="{}" d="{}" fill="{}" fill-opacity="0.14"/>"#,
            name.as_str(),
            region_path(name),
            ctx.theme.series_color(color, ctx.palette),
        ));
    }

    let boundaries = format!(
        r#"<g class="pele-cynefin-boundaries" fill="none" stroke="{}" stroke-dasharray="6 3"><path d="{}"/><path d="{}"/><path d="{}"/><path class="pele-cynefin-cliff" d="{}" stroke="{}" stroke-width="2" stroke-dasharray="none" stroke-linecap="round"/></g>"#,
        ctx.theme.border(),
        curve_path(&fold),
        curve_path(&west),
        curve_path(&east),
        curve_path(&drop),
        ctx.theme.line(),
    );

    let oval = ellipse_path(cx, cy, rx, ry);
    let ellipse = format!(
        r#"<path d="{oval}" fill="{}"/><path class="pele-cynefin-region" data-id="confusion" d="{oval}" fill="{}" fill-opacity="0.18" stroke="{}" stroke-dasharray="4 2"/>"#,
        ctx.theme.bg(),
        ctx.theme.series_color(CONFUSION_COLOR, ctx.palette),
        ctx.theme.border(),
    );

    let rounded = ctx.theme.rounded_standalone();
    let heading_attrs = format!(r#" class="pele-label" font-weight="{}""#, ctx.theme.heading_weight());
    let sub_attrs = format!(
        r#" class="pele-cynefin-subtitle" font-size="{}" font-style="italic" fill="{}""#,
        num(small),
        ctx.theme.muted(),
    );

    let draw_block = |b: &Block| -> String {
        let mut y = b.cy - b.h / 2.0;
        let mut out = label_svg(&b.title, b.cx, y + b.title.height / 2.0, &heading_attrs, ctx.theme, ctx.icons);
        y += b.title.height;
        for s in &b.subtitles {
            out.push_str(&label_svg(s, b.cx, y + s.height / 2.0, &sub_attrs, ctx.theme, ctx.icons));
            y += s.height;
        }
        y += HEAD_GAP - ITEM_GAP;
        for item in &b.badges {
            y += ITEM_GAP;
            let cls = if item.overflow { "pele-node pele-cynefin-overflow" } else { "pele-node" };
            let data_id = if item.overflow {
                String::new()
            } else {
                format!(r#" data-id="{}""#, esc_text(&item.text))
            };
            let dash = if item.overflow { r#" stroke-dasharray="3 2""# } else { "" };
            let fill_attr = if item.overflow {
                format!(r#" fill="{}""#, ctx.theme.muted())
            } else {
                String::new()
            };
            let item_attrs = format!(r#" class="pele-label" font-size="{}"{fill_attr}"#, num(item_size));
            out.push_str(&format!(
                r#"<g class="{cls}"{data_id}><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{dash}{rounded}/>{}</g>"#,
                num(b.cx - item.w / 2.0),
                num(y),
                num(item.w),
                num(item.h),
                ctx.theme.bg(),
                ctx.theme.border(),
                label_svg(&item.label, b.cx, y + item.h / 2.0, &item_attrs, ctx.theme, ctx.icons),
            ));
            y += item.h;
        }
        format!(r#"<g class="pele-cynefin-domain" data-id="{}">{out}</g>"#, b.name.as_str())
    };

    let mut domains_svg = String::new();
    for (idx, &(_, col, row, _)) in QUADRANTS.iter().enumerate() {
        quadrants[idx].cx = x0 + quad_w * (col as f64 + 0.5);
        quadrants[idx].cy = y0 + quad_h * (row as f64 + 0.5);
        domains_svg.push_str(&draw_block(&quadrants[idx]));
    }
    confusion.cx = cx;
    confusion.cy = cy;
    domains_svg.push_str(&draw_block(&confusion));

    let block_of = |name: DomainName| -> &Block {
        match name {
            DomainName::Complex => &quadrants[0],
            DomainName::Complicated => &quadrants[1],
            DomainName::Chaotic => &quadrants[2],
            DomainName::Clear => &quadrants[3],
            DomainName::Confusion => &confusion,
        }
    };

    let inside = |b: &Block, x: f64, y: f64| -> bool {
        if b.name == DomainName::Confusion {
            ((x - cx) / (rx + 4.0)).powi(2) + ((y - cy) / (ry + 4.0)).powi(2) <= 1.0
        } else {
            (x - b.cx).abs() <= b.w / 2.0 + 8.0 && (y - b.cy).abs() <= b.h / 2.0 + 8.0
        }
    };

    let mut edges_svg = String::new();
    let mut seen: HashMap<(DomainName, DomainName), usize> = HashMap::new();
    let line_color = ctx.theme.line();
    let edge_label_attrs = format!(r#" class="pele-edge-label" font-size="{}""#, num(small));

    for transition in &model.transitions {
        if transition.from == transition.to {
            continue;
        }
        let from = block_of(transition.from);
        let to = block_of(transition.to);
        let pair = if transition.from.as_str() < transition.to.as_str() {
            (transition.from, transition.to)
        } else {
            (transition.to, transition.from)
        };
        let repeat = *seen.get(&pair).unwrap_or(&0);
        seen.insert(pair, repeat + 1);

        let dx = to.cx - from.cx;
        let dy = to.cy - from.cy;
        let raw_len = dx.hypot(dy);
        let len = if raw_len == 0.0 { 1.0 } else { raw_len };
        let mx = (from.cx + to.cx) / 2.0;
        let my = (from.cy + to.cy) / 2.0;
        let outward = if -dy * (mx - cx) + dx * (my - cy) >= 0.0 { 1.0 } else { -1.0 };
        let nx = (-dy / len) * outward;
        let ny = (dx / len) * outward;
        let diagonal = from.name != DomainName::Confusion && to.name != DomainName::Confusion && dx.abs() > 1.0 && dy.abs() > 1.0;
        let bow = (if diagonal { 2.0 * ((rx * nx).hypot(ry * ny) + 16.0) } else { len * 0.15 }) + (repeat as f64) * 56.0;
        let px = mx + nx * bow;
        let py = my + ny * bow;
        let point = |t: f64| -> (f64, f64) {
            let u = 1.0 - t;
            (
                u * u * from.cx + 2.0 * u * t * px + t * t * to.cx,
                u * u * from.cy + 2.0 * u * t * py + t * t * to.cy,
            )
        };
        let crossing = |b: &Block, mut lo: f64, mut hi: f64, leaving: bool| -> f64 {
            for _ in 0..16 {
                let mid = (lo + hi) / 2.0;
                let (ptx, pty) = point(mid);
                if inside(b, ptx, pty) == leaving {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            (lo + hi) / 2.0
        };

        const STEPS: usize = 48;
        let mut step = 1usize;
        while step <= STEPS {
            let (ptx, pty) = point(step as f64 / STEPS as f64);
            if !inside(from, ptx, pty) {
                break;
            }
            step += 1;
        }
        if step > STEPS {
            continue;
        }
        let t0 = crossing(from, (step - 1) as f64 / STEPS as f64, step as f64 / STEPS as f64, true);
        while step <= STEPS {
            let (ptx, pty) = point(step as f64 / STEPS as f64);
            if inside(to, ptx, pty) {
                break;
            }
            step += 1;
        }
        let t1 = if step > STEPS {
            1.0
        } else {
            crossing(to, (step - 1) as f64 / STEPS as f64, step as f64 / STEPS as f64, false)
        };

        let (sx, sy) = point(t0);
        let (mut ex, mut ey) = point(t1);
        let blossom = |a: f64, b: f64, c: f64| (1.0 - t0) * (1.0 - t1) * a + ((1.0 - t0) * t1 + t0 * (1.0 - t1)) * b + t0 * t1 * c;
        let qx = blossom(from.cx, px, to.cx);
        let qy = blossom(from.cy, py, to.cy);
        let raw_el = (ex - qx).hypot(ey - qy);
        let el = if raw_el == 0.0 { 1.0 } else { raw_el };
        let ux = (ex - qx) / el;
        let uy = (ey - qy) / el;
        let head = marker("arrow_point", ex, ey, ux, uy, line_color, "");
        let trim = marker_trim("arrow_point");
        ex -= ux * trim;
        ey -= uy * trim;

        let text = if let Some(lbl_str) = &transition.label {
            let lbl = layout_label(Some(lbl_str), false, ctx.measurer, small, ITEM_MAX_WIDTH, TextStyle::NONE, ctx.icons, None);
            let (lx, ly) = point((t0 + t1) / 2.0);
            let away = (nx.abs() * lbl.width) / 2.0 + (ny.abs() * lbl.height) / 2.0 + 6.0;
            let half = lbl.width / 2.0 + 4.0;
            let tx = (lx + nx * away).max(x0 + half).min((right - half).max(x0 + half));
            label_svg(&lbl, tx, ly + ny * away, &edge_label_attrs, ctx.theme, ctx.icons)
        } else {
            String::new()
        };

        edges_svg.push_str(&format!(
            r#"<g class="pele-edge" data-id="{}-{}"><path d="M{},{}Q{},{} {},{}" fill="none" stroke="{line_color}"/>{head}{text}</g>"#,
            transition.from.as_str(),
            transition.to.as_str(),
            num(sx),
            num(sy),
            num(qx),
            num(qy),
            num(ex),
            num(ey),
        ));
    }

    let total_width = (width.max(title.width) + 2.0 * pad).ceil();
    let total_height = (height + title_height + 2.0 * pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(
        &title,
        x0 + width / 2.0,
        pad + title.height / 2.0,
        &title_attrs,
        ctx.theme,
        ctx.icons,
    ));
    content.push_str(&format!(r#"<g class="pele-cynefin-regions">{fills}</g>"#));
    content.push_str(&boundaries);
    content.push_str(&ellipse);
    content.push_str(&domains_svg);
    if !edges_svg.is_empty() {
        content.push_str(&format!(r#"<g class="pele-edges">{edges_svg}</g>"#));
    }

    let svg = svg_document(
        "cynefin",
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
