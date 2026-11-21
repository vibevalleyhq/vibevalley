use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::ink::ink;
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{ResolvedStyle, resolve_style};
use crate::text::label::{Label, layout_label};

use super::db::normalize_text;
use super::layout::{Circle, Spot, find_spot, layout_circles, region_path};
use super::types::{VennModel, VennSubset};

const RADIUS: f64 = 100.0;
const MAX_GROWTH: f64 = 1.6;

struct RegionLine {
    id: Option<String>,
    raw: String,
    size: f64,
    base: TextStyle,
    label: Label,
}

struct Region {
    sets: Vec<String>,
    inside: Vec<usize>,
    spot: Spot,
    lines: Vec<RegionLine>,
    style: ResolvedStyle,
    across: bool,
}

pub fn render_venn(model: &VennModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.8125).round();
    let pad = ctx.options.padding.unwrap_or(8.0);

    let circles = layout_circles(&model.subsets);
    let mut index: HashMap<String, usize> = HashMap::new();
    for (i, c) in circles.iter().enumerate() {
        index.insert(c.id.clone(), i);
    }

    let mut styles: IndexMap<Vec<String>, IndexMap<String, String>> = IndexMap::new();
    for entry in &model.styles {
        let merged = styles.entry(entry.targets.clone()).or_default();
        for (prop, val) in &entry.styles {
            merged.insert(prop.clone(), val.clone());
        }
    }
    let style_of = |key: &[String]| -> ResolvedStyle {
        let Some(declared) = styles.get(key) else {
            return ResolvedStyle::default();
        };
        let list: Vec<String> = declared.iter().map(|(p, v)| format!("{p}:{v}")).collect();
        resolve_style(&list)
    };

    let mut neighbors: Vec<Vec<usize>> = vec![Vec::new(); circles.len()];
    for a in 0..circles.len() {
        for b in a + 1..circles.len() {
            if (circles[a].x - circles[b].x).hypot(circles[a].y - circles[b].y) < circles[a].r + circles[b].r {
                neighbors[a].push(b);
                neighbors[b].push(a);
            }
        }
    }

    let mut stated: IndexMap<Vec<String>, &VennSubset> = IndexMap::new();
    for subset in &model.subsets {
        stated.insert(subset.sets.clone(), subset);
    }

    let mut regions: IndexMap<Vec<String>, Region> = IndexMap::new();
    for (key, subset) in stated {
        let mut seen = HashSet::new();
        let sets: Vec<String> = subset.sets.iter().filter(|id| seen.insert((*id).clone())).cloned().collect();
        let inside: Vec<usize> = sets.iter().map(|id| index[id]).collect();
        let within: HashSet<usize> = inside.iter().copied().collect();
        let mut smallest = inside[0];
        for &i in &inside {
            if circles[i].r < circles[smallest].r {
                smallest = i;
            }
        }
        let style = style_of(&key);
        let text = subset.label.as_deref().or_else(|| (subset.sets.len() == 1).then_some(subset.sets[0].as_str()));
        let mut base = TextStyle::NONE;
        if style.bold {
            base |= TextStyle::BOLD;
        }
        if style.italic {
            base |= TextStyle::ITALIC;
        }
        let others: Vec<usize> = neighbors[smallest].iter().copied().filter(|i| !within.contains(i)).collect();
        let mut spot = find_spot(&circles, &inside, &others);
        let across = !others.is_empty() && spot.margin < circles[smallest].r * 0.2;
        if across {
            spot = find_spot(&circles, &inside, &[]);
        }
        let mut lines = Vec::new();
        if let Some(raw) = text
            && !raw.is_empty()
        {
            let font_size = if sets.len() == 1 { size } else { small };
            let label = layout_label(Some(raw), false, ctx.measurer, font_size, 4000.0, base, ctx.icons, None);
            lines.push(RegionLine {
                id: None,
                raw: raw.to_string(),
                size: font_size,
                base,
                label,
            });
        }
        regions.insert(
            key,
            Region {
                sets,
                inside,
                spot,
                lines,
                style,
                across,
            },
        );
    }

    for node in &model.text_nodes {
        if let Some(region) = regions.get_mut(&node.sets) {
            let raw = node.label.as_deref().unwrap_or(&node.id);
            let label = layout_label(Some(raw), false, ctx.measurer, tiny, 4000.0, TextStyle::NONE, ctx.icons, None);
            region.lines.push(RegionLine {
                id: Some(node.id.clone()),
                raw: raw.to_string(),
                size: tiny,
                base: TextStyle::NONE,
                label,
            });
        }
    }

    let largest = circles.iter().map(|c| c.r).fold(0.0f64, f64::max);
    let mut scale = if largest > 0.0 { RADIUS / largest } else { 1.0 };
    let mut growth = 1.0f64;
    for region in regions.values() {
        if region.spot.margin <= 0.0 {
            continue;
        }
        let mut width = 0.0f64;
        let mut height = 0.0f64;
        for line in &region.lines {
            width = width.max(line.label.width);
            height += line.label.height;
        }
        let need = width.hypot(height) / 2.0 + 4.0;
        growth = growth.max((need / (region.spot.margin * scale)).min(MAX_GROWTH));
    }
    scale *= growth;

    for region in regions.values_mut() {
        let room = (region.spot.margin * scale * 1.8).max(72.0);
        for line in &mut region.lines {
            if line.label.width > room {
                line.label = layout_label(Some(&line.raw), false, ctx.measurer, line.size, room, line.base, ctx.icons, None);
            }
        }
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for c in &circles {
        min_x = min_x.min((c.x - c.r) * scale);
        min_y = min_y.min((c.y - c.r) * scale);
        max_x = max_x.max((c.x + c.r) * scale);
        max_y = max_y.max((c.y + c.r) * scale);
    }
    for region in regions.values() {
        let mut wide = 0.0f64;
        let mut tall = 0.0f64;
        for line in &region.lines {
            wide = wide.max(line.label.width);
            tall += line.label.height;
        }
        min_x = min_x.min(region.spot.x * scale - wide / 2.0);
        max_x = max_x.max(region.spot.x * scale + wide / 2.0);
        min_y = min_y.min(region.spot.y * scale - tall / 2.0);
        max_y = max_y.max(region.spot.y * scale + tall / 2.0);
    }
    if circles.is_empty() {
        min_x = 0.0;
        min_y = 0.0;
        max_x = 0.0;
        max_y = 0.0;
    }

    let title_norm = model.title.as_deref().map(normalize_text);
    let title = layout_label(title_norm.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, ctx.icons, None);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = (max_x - min_x).max(title.width);
    let ox = pad + (inner - (max_x - min_x)) / 2.0 - min_x;
    let oy = pad + title_height - min_y;
    let width = (inner + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();

    let placed: Vec<Circle> = circles
        .iter()
        .map(|c| Circle {
            id: c.id.clone(),
            x: c.x * scale + ox,
            y: c.y * scale + oy,
            r: c.r * scale,
        })
        .collect();

    let mut sets_out = String::new();
    for (i, c) in placed.iter().enumerate() {
        let color = ctx.theme.series_color(i, ctx.palette);
        let key = vec![c.id.clone()];
        let shape_style = regions.get(&key).map_or("", |r| r.style.shape.as_str());
        sets_out.push_str(&format!(
            r#"<circle class="pele-venn-set" data-id="{}" cx="{}" cy="{}" r="{}" fill="{color}" fill-opacity="0.2" stroke="{color}"{shape_style}/>"#,
            esc_text(&c.id),
            num(c.x),
            num(c.y),
            num(c.r),
        ));
    }

    let painted: Vec<&Region> = regions.values().filter(|r| r.sets.len() > 1 && !r.style.shape.is_empty()).collect();

    let mut overlaps = String::new();
    let mut labels = String::new();
    for region in regions.values() {
        let id = esc_text(&region.sets.join("|"));
        if region.sets.len() > 1 && !region.style.shape.is_empty() {
            let region_circles: Vec<Circle> = region.inside.iter().map(|&i| placed[i].clone()).collect();
            let d = region_path(&region_circles, num);
            if !d.is_empty() {
                overlaps.push_str(&format!(
                    r#"<path class="pele-venn-overlap" data-id="{id}" d="{d}" fill="none"{}/>"#,
                    region.style.shape
                ));
            }
        }
        let total: f64 = region.lines.iter().map(|l| l.label.height).sum();
        if total == 0.0 {
            continue;
        }
        let x = region.spot.x * scale + ox;
        let mut y = region.spot.y * scale + oy - total / 2.0;
        let fill = if region.across {
            ""
        } else {
            let mut f = if region.sets.len() == 1 && (region.style.shape.contains(r#""fill-opacity:"#) || region.style.shape.contains(";fill-opacity:")) {
                region.style.shape.as_str()
            } else {
                ""
            };
            for other in &painted {
                if other.sets.iter().all(|id| region.sets.contains(id)) {
                    f = other.style.shape.as_str();
                }
            }
            f
        };
        let mut content = String::new();
        for line in &region.lines {
            let own_style = match &line.id {
                None => region.style.text.clone(),
                Some(line_id) => style_of(std::slice::from_ref(line_id)).text,
            };
            let color = ink(fill, &own_style, ctx.theme);
            let attrs = match &line.id {
                None => {
                    let sz = if line.size == size {
                        String::new()
                    } else {
                        format!(r#" font-size="{}""#, num(line.size))
                    };
                    let fill_attr = match color {
                        Some(c) => format!(r#" fill="{c}""#),
                        None => String::new(),
                    };
                    format!(r#" class="pele-label"{sz}{fill_attr}{own_style}"#)
                }
                Some(line_id) => {
                    let fill_color = color.unwrap_or_else(|| ctx.theme.muted());
                    format!(
                        r#" class="pele-venn-text" data-id="{}" font-size="{}" fill="{fill_color}"{own_style}"#,
                        esc_text(line_id),
                        num(tiny)
                    )
                }
            };
            content.push_str(&label_svg(&line.label, x, y + line.label.height / 2.0, &attrs, ctx.theme, ctx.icons));
            y += line.label.height;
        }
        labels.push_str(&format!(r#"<g class="pele-venn-region" data-id="{id}">{content}</g>"#));
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons));
    content.push_str(&format!(r#"<g class="pele-venn-sets">{sets_out}</g>"#));
    if !overlaps.is_empty() {
        content.push_str(&format!(r#"<g class="pele-venn-overlaps">{overlaps}</g>"#));
    }
    if !labels.is_empty() {
        content.push_str(&format!(r#"<g class="pele-venn-labels">{labels}</g>"#));
    }

    let svg = svg_document(
        "venn",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible::default(),
        &content,
    );
    Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    }
}
