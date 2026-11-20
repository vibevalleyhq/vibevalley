use std::collections::HashMap;

use indexmap::IndexMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::title_room;
use crate::diagram::xychart::db::js_number_string;
use crate::error::PeleError;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::resolve_style;
use crate::text::entities::decode_entities;
use crate::text::label::layout_label;
use crate::util::yaml::YamlValue;

use super::db::SankeyModel;
use super::layout::{Alignment, LayoutOptions, layout_sankey};

const LABEL_GAP: f64 = 6.0;
const VALUE_GAP: f64 = 15.0;
const LABEL_ROOM: f64 = 1.8;
const CAREFUL: usize = 300;

fn base36(mut value: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::new();
    while value > 0 {
        buf.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap()
}

fn content_id(text: &str) -> String {
    let mut a: u32 = 0x811c9dc5;
    let mut b: u32 = 5381;
    for unit in text.encode_utf16() {
        let c = unit as u32;
        a = (a ^ c).wrapping_mul(0x01000193);
        b = b.wrapping_mul(33).wrapping_add(c);
    }
    format!("{}{}", base36(a), base36(b))
}

fn number_option(conf: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    match conf.and_then(|m| m.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v >= min => v.min(max),
        _ => fallback,
    }
}

fn text_option(conf: Option<&IndexMap<String, YamlValue>>, key: &str) -> String {
    match conf.and_then(|m| m.get(key)) {
        Some(YamlValue::String(s)) => s.clone(),
        Some(YamlValue::Number(v)) if v.is_finite() => js_number_string(*v),
        Some(YamlValue::Number(_) | YamlValue::Null | YamlValue::Bool(_) | YamlValue::Seq(_) | YamlValue::Map(_)) | None => String::new(),
    }
}

fn rounded(value: f64) -> f64 {
    let v = if value.abs() < 1e15 { (value * 100.0).round() / 100.0 } else { value };
    if v == 0.0 { 0.0 } else { v }
}

fn fill_style(color: Option<&str>) -> String {
    match color {
        Some(c) => resolve_style(&[format!("fill:{c}")]).shape,
        None => String::new(),
    }
}

fn is_safe_id_prefix(prefix: &str) -> bool {
    !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

struct NodeLabel {
    value: String,
    width: f64,
    after: bool,
    left: f64,
    y: f64,
}

fn fit_width_try<F>(ctx: &RenderContext<'_>, natural: f64, least: f64, mut draw: F) -> Result<Rendered, PeleError>
where
    F: FnMut(f64) -> Result<Rendered, PeleError>,
{
    let mut result = draw(natural)?;
    let Some(available) = ctx.options.max_width else {
        return Ok(result);
    };
    if available.is_nan() || available <= 0.0 || result.width <= available {
        return Ok(result);
    }
    let floor = least.min(natural);
    let mut plot = natural;
    result = draw(plot)?;
    for _round in 0..3 {
        if result.width <= available || plot <= floor {
            break;
        }
        plot = floor.max(plot - (result.width - available));
        result = draw(plot)?;
    }
    Ok(result)
}

pub fn render_sankey(model: &SankeyModel, ctx: &RenderContext<'_>) -> Result<Rendered, PeleError> {
    let conf = ctx.config.section("sankey");
    let natural = number_option(conf, "width", 600.0, 1.0, 10000.0);
    fit_width_try(ctx, natural, 160.0, |chart_width| draw(model, conf, ctx, chart_width, natural))
}

fn draw(
    model: &SankeyModel,
    conf: Option<&IndexMap<String, YamlValue>>,
    ctx: &RenderContext<'_>,
    chart_width: f64,
    natural: f64,
) -> Result<Rendered, PeleError> {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let least = (size * 0.625).round();
    let mut small = least.max((size * 0.875 * (chart_width / natural).min(1.0)).round());
    let pad = ctx.options.padding.unwrap_or(8.0);

    let chart_height = number_option(conf, "height", 400.0, 1.0, 10000.0);
    let node_width = number_option(conf, "nodeWidth", 10.0, 1.0, 200.0).min(chart_width);
    let show_values = conf.and_then(|m| m.get("showValues")).and_then(YamlValue::as_bool) != Some(false);
    let prefix = decode_entities(&text_option(conf, "prefix"));
    let suffix = decode_entities(&text_option(conf, "suffix"));
    let outlined = conf.and_then(|m| m.get("labelStyle")).and_then(YamlValue::as_str) == Some("outlined");
    let alignment = match conf.and_then(|m| m.get("nodeAlignment")).and_then(YamlValue::as_str) {
        Some("left") => Alignment::Left,
        Some("right") => Alignment::Right,
        Some("center") => Alignment::Center,
        _ => Alignment::Justify,
    };
    let link_color = conf.and_then(|m| m.get("linkColor")).and_then(YamlValue::as_str).unwrap_or("gradient");
    let node_padding = number_option(conf, "nodePadding", 12.0, 0.0, 200.0) + if show_values { VALUE_GAP } else { 0.0 };

    let lay = |label_size: f64| {
        layout_sankey(
            model,
            LayoutOptions {
                width: chart_width,
                height: chart_height,
                node_width,
                node_padding,
                label_height: label_size * 1.15,
                alignment,
            },
        )
    };
    let mut layout = lay(small)?;
    let mut rows: HashMap<usize, usize> = HashMap::new();
    let mut fullest = 1usize;
    for node in &layout.nodes {
        let count = rows.entry(node.layer).or_insert(0);
        *count += 1;
        if *count > fullest {
            fullest = *count;
        }
    }
    let crowded = least.max((chart_height / (fullest as f64) / LABEL_ROOM).round());
    if crowded < small {
        small = crowded;
        layout = lay(small)?;
    }
    let nodes = &layout.nodes;
    let links = &layout.links;
    let line_height = small * 1.5;

    let mut custom: HashMap<String, String> = HashMap::new();
    if let Some(node_colors) = conf.and_then(|m| m.get("nodeColors")).and_then(YamlValue::as_map) {
        for (id, val) in node_colors {
            let style = fill_style(val.as_str());
            if !style.is_empty() {
                custom.insert(id.clone(), style);
            }
        }
    }
    let node_style = |i: usize| -> &str { custom.get(&model.nodes[i].id).map_or("", String::as_str) };
    let node_color = |i: usize| -> String {
        if let Some(inner) = node_style(i).strip_prefix(r#" style="fill:"#).and_then(|s| s.strip_suffix(r#";""#)) {
            inner.to_string()
        } else {
            ctx.theme.series_color(i, ctx.palette).into_owned()
        }
    };

    let mut central = 0usize;
    let mut most = 0.0f64;
    for node in nodes {
        if node.value > most {
            most = node.value;
            central = node.layer;
        }
    }

    let mut min_x = 0.0f64;
    let mut max_x = chart_width;
    let mut min_y = 0.0f64;
    let mut max_y = chart_height;

    let mut labels: Vec<NodeLabel> = Vec::with_capacity(nodes.len());
    for (i, node) in nodes.iter().enumerate() {
        let name = decode_entities(&model.nodes[i].id);
        let value = if show_values {
            format!("{prefix}{}{suffix}", js_number_string(rounded(node.value)))
        } else {
            String::new()
        };
        let combined = if value.is_empty() { name.clone() } else { format!("{name} {value}") };
        let width = ctx.measurer.width(&combined, small, TextStyle::NONE);
        let after = if outlined { node.layer >= central } else { node.x < chart_width / 2.0 };
        let x = if after { node.x + node_width + LABEL_GAP } else { node.x - LABEL_GAP };
        let y = node.y + node.height / 2.0;
        let left = if after { x } else { x - width };
        min_x = min_x.min(left);
        max_x = max_x.max(if after { x + width } else { x });
        min_y = min_y.min(y - small * 0.75);
        max_y = max_y.max(y + small * 0.75);
        labels.push(NodeLabel { value, width, after, left, y });
    }

    let mut bands: HashMap<i64, Vec<usize>> = HashMap::new();
    if nodes.len() <= CAREFUL {
        for (idx, label) in labels.iter().enumerate() {
            let band = (label.y / line_height).floor() as i64;
            for key in [band - 2, band - 1, band, band + 1, band + 2] {
                bands.entry(key).or_default().push(idx);
            }
        }
    }

    let mut labels_out = String::new();
    let mut nodes_out = String::new();
    for (i, node) in nodes.iter().enumerate() {
        let id = &model.nodes[i].id;
        let name = decode_entities(id);
        let height = node.height.max(1.0);
        nodes_out.push_str(&format!(
            r#"<rect class="pele-sankey-node" data-id="{}" x="{}" y="{}" width="{}" height="{}" rx="{}" fill="{}"{}/>"#,
            esc_text(id),
            num(node.x),
            num(node.y),
            num(node_width),
            num(height),
            num(2.0f64.min(height / 2.0)),
            ctx.theme.series_color(i, ctx.palette),
            node_style(i),
        ));

        let overlaps_label = |labels: &[NodeLabel], self_idx: usize, left: f64, y: f64| -> bool {
            let band = (y / line_height).floor() as i64;
            let Some(nearby) = bands.get(&band) else { return false };
            let self_width = labels[self_idx].width;
            nearby.iter().any(|&other_idx| {
                if other_idx == self_idx {
                    return false;
                }
                let other = &labels[other_idx];
                (other.y - y).abs() < line_height && left < other.left + other.width + LABEL_GAP && left + self_width > other.left - LABEL_GAP
            })
        };

        if nodes.len() <= CAREFUL && overlaps_label(&labels, i, labels[i].left, labels[i].y) {
            let base_after = labels[i].after;
            let base_y = labels[i].y;
            let self_width = labels[i].width;
            'place: for dy in [0.0, -line_height, line_height] {
                for after in [base_after, !base_after] {
                    let left = if after {
                        node.x + node_width + LABEL_GAP
                    } else {
                        node.x - LABEL_GAP - self_width
                    };
                    let y = base_y + dy;
                    if overlaps_label(&labels, i, left, y) || left < min_x || left + self_width > max_x || y - small * 0.75 < min_y || y + small * 0.75 > max_y
                    {
                        continue;
                    }
                    let hits_bar = nodes.iter().enumerate().any(|(j, bar)| {
                        j != i
                            && left < bar.x + node_width + LABEL_GAP
                            && left + self_width > bar.x - LABEL_GAP
                            && y - small * 0.75 < bar.y + bar.height
                            && y + small * 0.75 > bar.y
                    });
                    if hits_bar {
                        continue;
                    }
                    let own = 0.0f64.max(node.y - y).max(y - node.y - node.height);
                    let nearer_other = nodes
                        .iter()
                        .enumerate()
                        .any(|(j, bar)| j != i && bar.x == node.x && 0.0f64.max(bar.y - y).max(y - bar.y - bar.height) <= own);
                    if nearer_other {
                        continue;
                    }
                    labels[i].left = left;
                    labels[i].y = y;
                    labels[i].after = after;
                    break 'place;
                }
            }
        }

        let after = labels[i].after;
        let y = labels[i].y;
        let value = &labels[i].value;
        let x = if after { node.x + node_width + LABEL_GAP } else { node.x - LABEL_GAP };
        let anchor = if after { "start" } else { "end" };
        let position = format!(r#" x="{}" y="{}" text-anchor="{anchor}""#, num(x), num(y + small * 0.35));
        let esc_name = esc(&name);
        let text = if value.is_empty() {
            esc_name.clone()
        } else {
            format!(
                r#"{esc_name} <tspan class="pele-sankey-value" fill="{}">{}</tspan>"#,
                ctx.theme.muted(),
                esc(value)
            )
        };
        labels_out.push_str(&format!(r#"<g class="pele-label" data-id="{}">"#, esc_text(id)));
        if outlined {
            let suffix_part = if value.is_empty() { String::new() } else { format!(" {}", esc(value)) };
            labels_out.push_str(&format!(
                r#"<text{position} fill="none" stroke="{}" stroke-width="3" stroke-linejoin="round">{esc_name}{suffix_part}</text>"#,
                ctx.theme.bg()
            ));
        }
        labels_out.push_str(&format!(r#"<text{position}>{text}</text></g>"#));
    }

    let fixed = if matches!(link_color, "gradient" | "source" | "target") {
        String::new()
    } else {
        fill_style(Some(link_color))
    };
    let id_prefix = ctx.options.id_prefix.as_deref().unwrap_or("");
    let gradient = link_color == "gradient" && is_safe_id_prefix(id_prefix);
    let mut gradients: IndexMap<String, String> = IndexMap::new();
    let mut links_out = String::new();

    for link in links {
        let end = if link_color == "target" { link.target } else { link.source };
        let half = link.thickness.max(1.0) / 2.0;
        let x0 = nodes[link.source].x + node_width;
        let x1 = nodes[link.target].x;
        let paint = if gradient {
            let src_color = node_color(link.source);
            let tgt_color = node_color(link.target);
            let stops = format!(
                r#"x1="{}" x2="{}"><stop offset="0" stop-color="{src_color}"/><stop offset="1" stop-color="{tgt_color}"/>"#,
                num(x0),
                num(x1)
            );
            let id = format!("{id_prefix}-sankey-{}", content_id(&stops));
            gradients.insert(
                id.clone(),
                format!(r#"<linearGradient id="{id}" gradientUnits="userSpaceOnUse" {stops}</linearGradient>"#),
            );
            format!(r#"fill="url(#{id}) {src_color}""#)
        } else {
            let style = if !fixed.is_empty() { fixed.as_str() } else { node_style(end) };
            format!(r#"fill="{}"{style}"#, ctx.theme.series_color(end, ctx.palette))
        };
        let mid = num((x0 + x1) / 2.0);
        let from = esc_text(&model.nodes[link.source].id);
        let to = esc_text(&model.nodes[link.target].id);
        links_out.push_str(&format!(
            r#"<path class="pele-sankey-link" data-id="{from}-&gt;{to}" d="M{},{}C{mid},{} {mid},{} {},{}L{},{}C{mid},{} {mid},{} {},{}Z" {paint}><title>{from} → {to}: {}{}{}</title></path>"#,
            num(x0),
            num(link.source_y - half),
            num(link.source_y - half),
            num(link.target_y - half),
            num(x1),
            num(link.target_y - half),
            num(x1),
            num(link.target_y + half),
            num(link.target_y + half),
            num(link.source_y + half),
            num(x0),
            num(link.source_y + half),
            esc(&prefix),
            js_number_string(rounded(link.value)),
            esc(&suffix),
        ));
    }

    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        size,
        title_room(ctx.options),
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = (max_x - min_x).max(title.width);
    let ox = pad - min_x + (inner - (max_x - min_x)) / 2.0;
    let oy = pad + title_height - min_y;
    let width = (inner + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons));
    content.push_str(&format!(r#"<g transform="translate({},{})">"#, num(ox), num(oy)));
    if !gradients.is_empty() {
        content.push_str("<defs>");
        for g in gradients.values() {
            content.push_str(g);
        }
        content.push_str("</defs>");
    }
    content.push_str(&format!(r#"<g class="pele-sankey-links" fill-opacity="0.4">{links_out}</g>"#));
    content.push_str(&format!(r#"<g class="pele-sankey-nodes">{nodes_out}</g>"#));
    content.push_str(&format!(r#"<g class="pele-labels" font-size="{}">{labels_out}</g>"#, num(small)));
    content.push_str("</g>");

    let svg = svg_document(
        "sankey",
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

    Ok(Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    })
}
