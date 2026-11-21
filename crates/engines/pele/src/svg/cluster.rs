use std::collections::HashMap;

use crate::IconResolver;
use crate::layout::compound::CNode;
use crate::svg::builder::label_svg;
use crate::svg::theme::SvgTheme;
use crate::text::label::Label;

pub type Crossings = HashMap<i64, Vec<f64>>;

pub fn mark_crossings(crossings: &mut Crossings, route: &[f64]) {
    let mut k = 0;
    while k + 2 < route.len() {
        let key = route[k + 1].round() as i64;
        crossings.entry(key).or_default().push(route[k]);
        k += 3;
    }
}

pub fn cluster_title_x(c: &CNode, width: f64, crossings: &Crossings, pad: f64) -> f64 {
    if width == 0.0 {
        return c.x;
    }
    let top = c.y - c.h / 2.0;
    let left = c.x - c.w / 2.0;
    let half = width / 2.0;
    let candidates = [left + pad - 6.0 + half, c.x, left + c.w - pad + 6.0 - half];
    let Some(xs) = crossings.get(&(top.round() as i64)) else {
        return candidates[0];
    };
    let mut best = candidates[0];
    let mut best_gap = -1.0;
    for x in candidates {
        let mut gap = f64::INFINITY;
        for &cx in xs {
            if cx > left && cx < left + c.w {
                gap = gap.min((cx - x).abs() - half);
            }
        }
        if gap >= 6.0 {
            return x;
        }
        if gap > best_gap + 0.5 {
            best_gap = gap;
            best = x;
        }
    }
    best
}

pub fn title_crossed(c: &CNode, width: f64, x: f64, crossings: &Crossings) -> bool {
    if width <= 0.0 {
        return false;
    }
    let Some(xs) = crossings.get(&((c.y - c.h / 2.0).round() as i64)) else {
        return false;
    };
    let left = c.x - c.w / 2.0;
    xs.iter().any(|&cx| cx > left && cx < left + c.w && (cx - x).abs() < width / 2.0 + 4.0)
}

#[allow(clippy::too_many_arguments)]
pub fn struck_title(
    label: &Label,
    x: f64,
    y: f64,
    attrs: &str,
    id: &str,
    nodes: &[CNode],
    index: usize,
    theme: &SvgTheme,
    icons: Option<&IconResolver<'_>>,
) -> String {
    let mut depth = 1usize;
    let mut p = nodes[index].parent;
    while p >= 0 && depth < 8 {
        depth += 1;
        p = nodes[p as usize].parent;
    }
    let halo = theme.cluster_halo(depth);
    let outline_attrs = format!(r#" fill="none" stroke="{halo}" stroke-width="5" stroke-linejoin="round""#);
    format!(
        r#"<g class="pele-cluster-title" data-id="{id}">{}{}</g>"#,
        label_svg(label, x, y, &outline_attrs, theme, icons),
        label_svg(label, x, y, attrs, theme, icons)
    )
}
