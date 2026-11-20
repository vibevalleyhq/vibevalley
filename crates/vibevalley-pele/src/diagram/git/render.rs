use std::collections::HashMap;
use std::f64::consts::FRAC_1_SQRT_2;

use crate::Rendered;
use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{plain_label, turn_to_fit};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::SvgTheme;
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::db::{CommitType, GitCommit, GitModel};
use super::parser::GitDirection;

const DOT: f64 = 7.0;
const STEP: f64 = 44.0;
const LANE: f64 = 44.0;
const CURVE: f64 = 36.0;
const GAP: f64 = 8.0;
const LABEL_GAP: f64 = 20.0;
const TAIL: f64 = 20.0;
const NOTCH: f64 = 7.0;
const TAG_GAP: f64 = 6.0;

struct View<'a> {
    commit: &'a GitCommit,
    lane: usize,
    m: f64,
    label: Option<Label>,
    tags: Vec<Label>,
}

fn flag(config: &DiagramConfig, key: &str, fallback: bool) -> bool {
    config
        .section("gitGraph")
        .and_then(|s| s.get(key))
        .and_then(YamlValue::as_bool)
        .unwrap_or(fallback)
}

fn tag_width(tag: &Label) -> f64 {
    NOTCH + 4.0 + tag.width + 6.0
}

fn symbol_svg(commit_type: CommitType, x: f64, y: f64, color: &str, theme: &SvgTheme) -> String {
    let at = format!(r#"cx="{}" cy="{}""#, num(x), num(y));
    match commit_type {
        CommitType::Highlight => format!(
            r#"<rect x="{}" y="{}" width="{}" height="{}" rx="2" fill="{color}"/>"#,
            num(x - DOT - 1.0),
            num(y - DOT - 1.0),
            num(2.0 * DOT + 2.0),
            num(2.0 * DOT + 2.0),
        ),
        CommitType::Merge => format!(
            r#"<circle {at} r="{}" fill="{}" stroke="{color}" stroke-width="2"/><circle {at} r="2.5" fill="{color}"/>"#,
            num(DOT - 1.0),
            theme.bg(),
        ),
        CommitType::Normal => format!(r#"<circle {at} r="{}" fill="{color}"/>"#, num(DOT)),
        CommitType::Reverse => format!(
            r#"<circle {at} r="{}" fill="{color}"/><path d="M{},{}l6,6M{},{}l6,-6" fill="none" stroke="{}" stroke-width="1.5" stroke-linecap="round"/>"#,
            num(DOT),
            num(x - 3.0),
            num(y - 3.0),
            num(x - 3.0),
            num(y + 3.0),
            theme.bg(),
        ),
        CommitType::CherryPick => format!(
            r#"<circle {at} r="{}" fill="{color}"/><path d="M{},{}L{},{}L{},{}" fill="none" stroke="{}" stroke-linejoin="round"/><circle cx="{}" cy="{}" r="1.8" fill="{}"/><circle cx="{}" cy="{}" r="1.8" fill="{}"/>"#,
            num(DOT),
            num(x - 2.6),
            num(y + 1.0),
            num(x + 0.8),
            num(y - 4.2),
            num(x + 2.6),
            num(y + 1.0),
            theme.bg(),
            num(x - 2.6),
            num(y + 2.2),
            theme.bg(),
            num(x + 2.6),
            num(y + 2.2),
            theme.bg(),
        ),
    }
}

pub fn render_git(model: &GitModel, ctx: &RenderContext<'_>) -> Rendered {
    match model.direction {
        GitDirection::Lr => turn_to_fit(ctx.options, |down| draw(model, ctx, if down { GitDirection::Tb } else { GitDirection::Lr })),
        GitDirection::Tb | GitDirection::Bt => draw(model, ctx, model.direction),
    }
}

fn draw(model: &GitModel, ctx: &RenderContext<'_>, direction: GitDirection) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.75).round();
    let medium = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let rounded = ctx.theme.rounded_standalone();

    let show_branches = flag(ctx.config, "showBranches", true);
    let show_commit_label = flag(ctx.config, "showCommitLabel", true);
    let rotate = flag(ctx.config, "rotateCommitLabel", true);
    let parallel = flag(ctx.config, "parallelCommits", false);
    let vertical = direction != GitDirection::Lr;
    let flip = direction == GitDirection::Bt;

    let lane_of: HashMap<&str, usize> = model.lanes.iter().enumerate().map(|(i, name)| (name.as_str(), i)).collect();
    let lane_count = model.lanes.len();
    let names: Vec<Label> = model
        .lanes
        .iter()
        .map(|name| {
            plain_label(
                Some(if show_branches { name.as_str() } else { "" }),
                ctx.measurer,
                medium,
                4000.0,
                TextStyle::NONE,
            )
        })
        .collect();

    let mut ordered_commits: Vec<&GitCommit> = model.commits.values().collect();
    ordered_commits.sort_by_key(|c| c.seq);

    let mut views: Vec<View<'_>> = Vec::with_capacity(ordered_commits.len());
    let mut by_id: HashMap<&str, usize> = HashMap::with_capacity(ordered_commits.len());
    for commit in ordered_commits {
        let labelled = show_commit_label && commit.commit_type != CommitType::CherryPick && (commit.commit_type != CommitType::Merge || commit.custom_id);
        let mut tags = Vec::new();
        for tag in &commit.tags {
            let label = plain_label(Some(tag), ctx.measurer, small, 4000.0, TextStyle::NONE);
            if !label.lines.is_empty() {
                tags.push(label);
            }
        }
        let idx = views.len();
        by_id.insert(commit.id.as_str(), idx);
        views.push(View {
            commit,
            lane: lane_of.get(commit.branch.as_str()).copied().unwrap_or(0),
            m: 0.0,
            label: labelled.then(|| plain_label(Some(&commit.id), ctx.measurer, small, 4000.0, TextStyle::NONE)),
            tags,
        });
    }

    let mut half = vec![0.0f64; views.len()];
    let mut tag_half = vec![0.0f64; views.len()];
    let mut lo = vec![DOT; lane_count];
    let mut hi = vec![DOT; lane_count];

    for (k, view) in views.iter().enumerate() {
        let mut tags_main = 0.0f64;
        let mut tags_cross = 0.0f64;
        for tag in &view.tags {
            let w = tag_width(tag);
            if vertical {
                tags_main = tags_main.max(tag.height);
                tags_cross += w + 4.0;
            } else {
                tags_main = tags_main.max(w);
                tags_cross += tag.height + 3.0;
            }
        }
        let mut label_main = 0.0f64;
        let mut label_cross = 0.0f64;
        if let Some(label) = &view.label
            && !label.lines.is_empty()
        {
            if rotate {
                label_cross = 3.0 + FRAC_1_SQRT_2 * (label.width + label.height);
            } else {
                label_main = if vertical { label.height } else { label.width };
                label_cross = 6.0 + if vertical { label.width } else { label.height };
            }
        }
        half[k] = DOT.max(tags_main / 2.0).max(label_main / 2.0);
        tag_half[k] = tags_main / 2.0;
        let tag_side = DOT + if view.tags.is_empty() { 0.0 } else { TAG_GAP + tags_cross };
        let label_side = DOT + label_cross;
        let lane = view.lane;
        if lane < lane_count {
            lo[lane] = lo[lane].max(if vertical { label_side } else { tag_side });
            hi[lane] = hi[lane].max(if vertical { tag_side } else { label_side });
        }
    }

    let mut lead = vec![0.0f64; views.len()];
    if !vertical {
        for (k, view) in views.iter().enumerate() {
            if tag_half[k] == 0.0 {
                continue;
            }
            for id in &view.commit.parents {
                if let Some(&pidx) = by_id.get(id.as_str())
                    && views[pidx].lane < view.lane
                {
                    lead[k] = tag_half[k] + 4.0;
                }
            }
        }
    }

    let space = |p: usize, k: usize| -> f64 {
        STEP.max(half[p] + half[k] + GAP)
            .max(if lead[k] > 0.0 { half[p] + CURVE + lead[k] } else { 0.0 })
    };

    for k in 0..views.len() {
        if !parallel {
            views[k].m = if k == 0 { 0.0 } else { views[k - 1].m + space(k - 1, k) };
            continue;
        }
        let mut m = 0.0f64;
        for id in &views[k].commit.parents {
            if let Some(&pidx) = by_id.get(id.as_str())
                && pidx < k
            {
                m = m.max(views[pidx].m + space(pidx, k));
            }
        }
        views[k].m = m;
    }
    let end = views.iter().map(|v| v.m).fold(0.0f64, f64::max);

    let mut cross = vec![0.0f64; lane_count];
    for i in 0..lane_count {
        let name = &names[i];
        let reach = if name.lines.is_empty() {
            0.0
        } else if vertical {
            name.width / 2.0 + 8.0
        } else {
            name.height / 2.0 + 2.0
        };
        lo[i] = lo[i].max(reach);
        hi[i] = hi[i].max(reach);
        if i > 0 {
            cross[i] = cross[i - 1] + LANE.max(hi[i - 1] + lo[i] + GAP);
        }
    }

    let px = |m: f64, c: f64| if vertical { c } else { m };
    let py = |m: f64, c: f64| {
        if vertical { if flip { -m } else { m } } else { c }
    };
    let point = |m: f64, c: f64| format!("{},{}", num(px(m, c)), num(py(m, c)));

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut grow = |x0: f64, y0: f64, x1: f64, y1: f64| {
        if x0 < min_x {
            min_x = x0;
        }
        if y0 < min_y {
            min_y = y0;
        }
        if x1 > max_x {
            max_x = x1;
        }
        if y1 > max_y {
            max_y = y1;
        }
    };

    let mut branches_svg = String::new();
    if show_branches {
        let default_on_color = format!(r#" fill="{}""#, ctx.theme.bg());
        for i in 0..lane_count {
            let name = &names[i];
            let color = ctx.theme.series_color(i, ctx.palette);
            let c = cross[i];
            let w = name.width + 16.0;
            let h = name.height + 4.0;
            let from = if name.lines.is_empty() {
                -LABEL_GAP
            } else {
                -LABEL_GAP - if vertical { h } else { w }
            };
            let span = if vertical { h } else { w };
            let cx = px(from + span / 2.0, c);
            let cy = py(from + span / 2.0, c);
            grow(px(-LABEL_GAP, c), py(-LABEL_GAP, c), px(-LABEL_GAP, c), py(-LABEL_GAP, c));
            grow(px(end + TAIL, c), py(end + TAIL, c), px(end + TAIL, c), py(end + TAIL, c));
            branches_svg.push_str(&format!(
                r#"<g class="pele-branch" data-id="{}"><path class="pele-lane" d="M{}L{}" stroke="{color}" stroke-dasharray="2 4"/>"#,
                esc_text(&model.lanes[i]),
                point(-LABEL_GAP, c),
                point(end + TAIL, c),
            ));
            if !name.lines.is_empty() {
                grow(cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0);
                let ink = ctx.palette.series_ink_fill(i, ctx.theme);
                let label_attrs = format!(r#" class="pele-label"{}"#, if ink.is_empty() { &default_on_color } else { &ink });
                branches_svg.push_str(&format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{color}"{rounded}/>{}"#,
                    num(cx - w / 2.0),
                    num(cy - h / 2.0),
                    num(w),
                    num(h),
                    label_svg(name, cx, cy, &label_attrs, ctx.theme, None),
                ));
            }
            branches_svg.push_str("</g>");
        }
    }

    let mut taken: Vec<Vec<f64>> = vec![Vec::new(); lane_count];
    for view in &views {
        if view.lane < lane_count {
            taken[view.lane].push(view.m);
        }
    }
    if parallel {
        for list in &mut taken {
            list.sort_by(f64::total_cmp);
        }
    }
    let busy = |lane: usize, from: f64, to: f64| -> bool {
        let list = &taken[lane];
        let mut low = 0usize;
        let mut high = list.len();
        while low < high {
            let mid = (low + high) >> 1;
            if list[mid] <= from {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low < list.len() && list[low] < to
    };

    let mut curves = String::new();
    let mut lines = String::new();
    for (view_idx, view) in views.iter().enumerate() {
        let c2 = cross[view.lane];
        let m2 = view.m;
        for (j, pid) in view.commit.parents.iter().enumerate() {
            let Some(&pidx) = by_id.get(pid.as_str()) else {
                continue;
            };
            if pidx == view_idx {
                continue;
            }
            let parent = &views[pidx];
            let c1 = cross[parent.lane];
            let m1 = parent.m;
            if parent.lane == view.lane {
                lines.push_str(&format!(
                    r#"<path class="pele-edge" d="M{}L{}" stroke="{}"/>"#,
                    point(m1, c1),
                    point(m2, c2),
                    ctx.theme.series_color(view.lane, ctx.palette),
                ));
                continue;
            }
            let merged = j > 0 && view.commit.commit_type == CommitType::Merge;
            let picked = j > 0 && !merged;
            let mut d = format!("M{}", point(m1, c1));
            if m2 <= m1 {
                let mid = (m1 + m2) / 2.0;
                d.push_str(&format!("C{} {} {}", point(mid, c1), point(mid, c2), point(m2, c2)));
            } else if !merged && !busy(view.lane, m1, m2) {
                let s = CURVE.min(m2 - m1);
                d.push_str(&format!(
                    "C{} {} {}L{}",
                    point(m1 + s / 2.0, c1),
                    point(m1 + s / 2.0, c2),
                    point(m1 + s, c2),
                    point(m2, c2),
                ));
            } else {
                let to = if parent.lane < view.lane && m2 - lead[view_idx] > m1 {
                    m2 - lead[view_idx]
                } else {
                    m2
                };
                let mut s = CURVE.min(to - m1);
                let mut along = c1;
                if !merged || busy(parent.lane, m1, m2) {
                    along = if c1 > c2 {
                        c2 + hi[view.lane] + GAP / 2.0
                    } else {
                        c2 - lo[view.lane] - GAP / 2.0
                    };
                    s = CURVE.min((to - m1) / 2.0);
                    d.push_str(&format!("C{} {} {}", point(m1 + s / 2.0, c1), point(m1 + s / 2.0, along), point(m1 + s, along),));
                }
                d.push_str(&format!(
                    "L{}C{} {} {}",
                    point(to - s, along),
                    point(to - s / 2.0, along),
                    point(to - s / 2.0, c2),
                    point(to, c2),
                ));
                if to < m2 {
                    d.push_str(&format!("L{}", point(m2, c2)));
                }
            }
            let edge_cls = if merged {
                " pele-edge-merge"
            } else if picked {
                " pele-edge-cherry-pick"
            } else {
                ""
            };
            let stroke_lane = if merged { parent.lane } else { view.lane };
            let dash = if picked { r#" stroke-dasharray="4 3""# } else { "" };
            curves.push_str(&format!(
                r#"<path class="pele-edge{edge_cls}" d="{d}" stroke="{}"{dash}/>"#,
                ctx.theme.series_color(stroke_lane, ctx.palette),
            ));
        }
    }

    let mut commits_svg = String::new();
    let tag_text_attrs = format!(r#" fill="{}""#, ctx.theme.fg());
    for view in &views {
        let commit = view.commit;
        let x = px(view.m, cross[view.lane]);
        let y = py(view.m, cross[view.lane]);
        let effective_type = commit.custom_type.unwrap_or(commit.commit_type);
        grow(x - DOT - 1.0, y - DOT - 1.0, x + DOT + 1.0, y + DOT + 1.0);
        let written = commit.commit_type.is_user_written_message() && !commit.message.is_empty();
        let mut body = if written {
            format!("<title>{}</title>", esc_text(&commit.message))
        } else {
            String::new()
        };
        let color = ctx.theme.series_color(view.lane, ctx.palette);
        body.push_str(&symbol_svg(effective_type, x, y, &color, ctx.theme));

        if let Some(label) = &view.label
            && !label.lines.is_empty()
        {
            let w = label.width;
            let h = label.height;
            let back = |cx: f64, cy: f64| -> String {
                format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}"/>"#,
                    num(cx - w / 2.0 - 2.0),
                    num(cy - h / 2.0 + 2.0),
                    num(w + 4.0),
                    num(h - 4.0),
                    ctx.theme.bg(),
                )
            };
            if rotate {
                let k = (FRAC_1_SQRT_2 * h) / 2.0;
                let ax = if vertical { x - DOT - 3.0 - k } else { x + 3.0 };
                let ay = if vertical { y } else { y + DOT + 3.0 + k };
                let reach = FRAC_1_SQRT_2 * w + k;
                grow(
                    ax - reach,
                    if flip { ay - reach } else { ay - k },
                    ax + k,
                    if flip { ay + k } else { ay + reach },
                );
                body.push_str(&format!(
                    r#"<g class="pele-commit-label" transform="rotate({} {} {})">{}{}</g>"#,
                    if flip { 45 } else { -45 },
                    num(ax),
                    num(ay),
                    back(ax - w / 2.0, ay),
                    label_svg(label, ax - w / 2.0, ay, "", ctx.theme, None),
                ));
            } else {
                let cx = if vertical { x - DOT - 6.0 - w / 2.0 } else { x };
                let cy = if vertical { y } else { y + DOT + 6.0 + h / 2.0 };
                grow(cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0);
                body.push_str(&format!(
                    r#"<g class="pele-commit-label">{}{}</g>"#,
                    back(cx, cy),
                    label_svg(label, cx, cy, "", ctx.theme, None),
                ));
            }
        }

        let mut offset = DOT + TAG_GAP;
        let tag_indices: Vec<usize> = if vertical {
            (0..view.tags.len()).collect()
        } else {
            (0..view.tags.len()).rev().collect()
        };
        for t_idx in tag_indices {
            let tag = &view.tags[t_idx];
            let w = tag_width(tag);
            let h = tag.height;
            let left = if vertical { x + offset } else { x - w / 2.0 };
            let cy = if vertical { y } else { y - offset - h / 2.0 };
            offset += if vertical { w + 4.0 } else { h + 3.0 };
            grow(left, cy - h / 2.0, left + w, cy + h / 2.0);
            body.push_str(&format!(
                r#"<g class="pele-tag"><path d="M{},{}L{},{}H{}V{}H{}Z" fill="{}" stroke="{}" stroke-linejoin="round"/><circle cx="{}" cy="{}" r="1.5" fill="{}"/>{}</g>"#,
                num(left),
                num(cy),
                num(left + NOTCH),
                num(cy - h / 2.0),
                num(left + w),
                num(cy + h / 2.0),
                num(left + NOTCH),
                ctx.theme.surface(),
                ctx.theme.border(),
                num(left + NOTCH),
                num(cy),
                ctx.theme.border(),
                label_svg(tag, left + NOTCH + 4.0 + tag.width / 2.0, cy, &tag_text_attrs, ctx.theme, None),
            ));
        }

        let merge_cls = if commit.commit_type == CommitType::Merge && effective_type != CommitType::Merge {
            " pele-commit-merge"
        } else {
            ""
        };
        commits_svg.push_str(&format!(
            r#"<g class="pele-commit pele-commit-{}{merge_cls}" data-id="{}">{body}</g>"#,
            effective_type.class_name(),
            esc_text(&commit.id),
        ));
    }

    drop(grow);
    if min_x > max_x {
        min_x = 0.0;
        min_y = 0.0;
        max_x = 0.0;
        max_y = 0.0;
    }
    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, None, None);
    let title_height = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let inner = (max_x - min_x).max(title.width);
    let width = (inner + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();
    let dx = pad - min_x + (inner - (max_x - min_x)) / 2.0;
    let dy = pad + title_height - min_y;

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut inner_groups = String::new();
    if !branches_svg.is_empty() {
        inner_groups.push_str(&format!(
            r#"<g class="pele-branches" fill="none" font-size="{}">{branches_svg}</g>"#,
            num(medium),
        ));
    }
    if !curves.is_empty() || !lines.is_empty() {
        inner_groups.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke-width="2" stroke-linecap="round">{curves}{lines}</g>"#,
        ));
    }
    if !commits_svg.is_empty() {
        inner_groups.push_str(&format!(
            r#"<g class="pele-commits" font-size="{}" fill="{}">{commits_svg}</g>"#,
            num(small),
            ctx.theme.muted(),
        ));
    }

    let content = format!(
        r#"{}<g transform="translate({},{})">{inner_groups}</g>"#,
        label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
        num(dx),
        num(dy),
    );
    let svg = svg_document(
        "gitGraph",
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
