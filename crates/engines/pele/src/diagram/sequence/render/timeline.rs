use crate::diagram::RenderContext;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::theme::resolve_style;

use super::super::db::SeqDb;
use super::super::types::{LineType, Placement, SeqMessage};
use super::layout::{Column, HorizontalLayout, ViewKind};
use super::style::{
    ACT_MIN, ACT_STEP, ACT_W, CENTRAL_R, DASH, InkCache, Metrics, Numbering, SELF_H, SELF_W, TAB_H, draw_head, head_trim, is_frame_divider, line_style,
};

pub(super) struct TimelineOutput<'a> {
    pub(super) rects_out: Vec<String>,
    pub(super) activations_out: Vec<String>,
    pub(super) frames_out: String,
    pub(super) edges_out: String,
    pub(super) labels_out: String,
    pub(super) notes_out: String,
    pub(super) crosses_out: String,
    pub(super) box_ranges: Vec<(f64, f64, &'a str)>,
    pub(super) y: f64,
}

fn left_edge(col: &Column<'_>, extra: usize) -> f64 {
    if col.activations.len() + extra > 0 { col.x - ACT_W / 2.0 } else { col.x }
}

fn right_edge(col: &Column<'_>, extra: usize) -> f64 {
    let depth = col.activations.len() + extra;
    if depth > 0 {
        col.x + ACT_W / 2.0 + ((depth - 1) as f64) * ACT_STEP
    } else {
        col.x
    }
}

struct TimelinePainter<'a, 'b, 'c> {
    db: &'a SeqDb,
    ctx: &'b RenderContext<'c>,
    m: &'b Metrics,
    numbering: &'b Numbering,
    layout: &'b mut HorizontalLayout<'a>,
    inks: &'b mut InkCache,
    xs: Vec<f64>,
    box_ranges: Vec<(f64, f64, &'a str)>,
    stack: Vec<usize>,
    rounded_standalone: String,
    rects_out: Vec<String>,
    activations_out: Vec<String>,
    frames_out: String,
    edges_out: String,
    labels_out: String,
    notes_out: String,
    crosses_out: String,
    y: f64,
}

impl TimelinePainter<'_, '_, '_> {
    fn crosses(&self, x0: f64, x1: f64) -> bool {
        let mut lo = 0usize;
        let mut hi = self.xs.len();
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if self.xs[mid] <= x0 {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo < self.xs.len() && self.xs[lo] < x1
    }

    fn fill_under(&self, l: f64, r: f64) -> Option<String> {
        for &fidx in self.stack.iter().rev() {
            if self.layout.frames_pool[fidx].kind == "rect" {
                return Some(self.layout.frames_pool[fidx].fill.clone());
            }
        }
        for &(x0, x1, fill) in &self.box_ranges {
            if l >= x0 && r <= x1 {
                return Some(fill.to_string());
            }
        }
        None
    }

    fn end_activation(&mut self, col_idx: usize, end: f64) -> f64 {
        let col = &mut self.layout.cols[col_idx];
        let start = col.activations.pop().unwrap();
        let bottom = end.max(start + ACT_MIN);
        let x = col.x - ACT_W / 2.0 + (col.activations.len() as f64) * ACT_STEP;
        if x < self.layout.min_x {
            self.layout.min_x = x;
        }
        if x + ACT_W > self.layout.max_x {
            self.layout.max_x = x + ACT_W;
        }
        self.activations_out.push(format!(
            r#"<rect class="pele-activation" data-id="{}" x="{}" y="{}" width="{}" height="{}" rx="2"/>"#,
            esc_text(col.id),
            num(x),
            num(start),
            num(ACT_W),
            num(bottom - start),
        ));
        bottom
    }

    fn destroy_actor(&mut self, col_idx: usize, line_y: f64) -> f64 {
        let col = &mut self.layout.cols[col_idx];
        let cx = col.x;
        let cy = line_y + 16.0;
        col.life_end = cy;
        self.crosses_out.push_str(&format!(
            r#"<path class="pele-destroy" data-id="{}" d="M{},{}L{},{}M{},{}L{},{}"/>"#,
            esc_text(col.id),
            num(cx - 6.0),
            num(cy - 6.0),
            num(cx + 6.0),
            num(cy + 6.0),
            num(cx + 6.0),
            num(cy - 6.0),
            num(cx - 6.0),
            num(cy + 6.0),
        ));
        cy + 6.0
    }

    fn paint_frame_close(&mut self, fidx: usize) {
        self.stack.pop();
        let bottom = self.y + 12.0;
        let frame_x0 = self.layout.frames_pool[fidx].x0;
        let frame_x1 = self.layout.frames_pool[fidx].x1;
        let frame_top = self.layout.frames_pool[fidx].top;
        let frame_kind_s = self.layout.frames_pool[fidx].kind;
        let x = num(frame_x0);
        let w = num(frame_x1 - frame_x0);
        if frame_kind_s == "rect" {
            let fill = if self.layout.frames_pool[fidx].fill.is_empty() {
                String::new()
            } else {
                resolve_style(&[format!("fill:{}", self.layout.frames_pool[fidx].fill)]).shape
            };
            let base_attrs = if fill.is_empty() { r#" fill-opacity="0.5""#.to_string() } else { fill };
            self.rects_out.push(format!(
                r#"<rect class="pele-rect" x="{x}" y="{}" width="{w}" height="{}"{}/>"#,
                num(frame_top),
                num(bottom - frame_top),
                self.ctx.theme.rounded(&base_attrs),
            ));
        } else {
            let mut inner = format!(
                r#"<rect x="{x}" y="{}" width="{w}" height="{}" fill="none"{}/>"#,
                num(frame_top),
                num(bottom - frame_top),
                self.rounded_standalone,
            );
            let div_len = self.layout.frames_pool[fidx].divider_y.len();
            for k in 0..div_len {
                let dy = self.layout.frames_pool[fidx].divider_y[k];
                let label_w = self.layout.frames_pool[fidx].divider_labels[k].width;
                let label_h = self.layout.frames_pool[fidx].divider_labels[k].height;
                let cx = frame_x0 + 8.0 + label_w / 2.0;
                let cy = dy + 2.0 + label_h / 2.0;
                inner.push_str(&format!(r#"<path d="M{x},{}H{}"{DASH}/>"#, num(dy), num(frame_x1)));
                if label_w > 0.0 {
                    let l = cx - label_w / 2.0;
                    let plate = self.crosses(l, l + label_w);
                    if plate {
                        inner.push_str(&format!(
                            r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}" stroke="none"/>"#,
                            num(l - 3.0),
                            num(cy - label_h / 2.0 + 2.0),
                            num(label_w + 6.0),
                            num(label_h - 4.0),
                            self.ctx.theme.bg(),
                        ));
                    }
                    let fill_color = if plate {
                        None
                    } else {
                        let under_f = self.fill_under(l, l + label_w);
                        self.inks.get(under_f.as_deref(), self.ctx.theme)
                    };
                    let attrs = format!(
                        r#" class="pele-frame-label" fill="{}" stroke="none""#,
                        fill_color.as_deref().unwrap_or(self.ctx.theme.muted()),
                    );
                    let label = &self.layout.frames_pool[fidx].divider_labels[k];
                    inner.push_str(&label_svg(label, cx, cy, &attrs, self.ctx.theme, self.ctx.icons));
                }
            }
            let tab_w = self.layout.frames_pool[fidx].tab_w;
            inner.push_str(&format!(
                r#"<rect x="{x}" y="{}" width="{}" height="{}" fill="{}"{}/><text class="pele-frame-kind" x="{}" y="{}" text-anchor="middle" font-size="{}" font-weight="{}" fill="{}" stroke="none">{frame_kind_s}</text>"#,
                num(frame_top),
                num(tab_w),
                num(TAB_H),
                self.ctx.theme.surface(),
                self.rounded_standalone,
                num(frame_x0 + tab_w / 2.0),
                num(frame_top + TAB_H / 2.0 + self.m.tiny * 0.35),
                num(self.m.tiny),
                self.ctx.theme.heading_weight(),
                self.ctx.theme.muted(),
            ));
            let title_w = self.layout.frames_pool[fidx].title.width;
            let title_h = self.layout.frames_pool[fidx].title.height;
            if title_w > 0.0 {
                let cx = frame_x0 + tab_w + 8.0 + title_w / 2.0;
                let cy = frame_top + TAB_H.max(title_h) / 2.0;
                let l = cx - title_w / 2.0;
                let plate = self.crosses(l, l + title_w);
                if plate {
                    inner.push_str(&format!(
                        r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}" stroke="none"/>"#,
                        num(l - 3.0),
                        num(cy - title_h / 2.0 + 2.0),
                        num(title_w + 6.0),
                        num(title_h - 4.0),
                        self.ctx.theme.bg(),
                    ));
                }
                let fill_color = if plate {
                    None
                } else {
                    let under_f = self.fill_under(l, l + title_w);
                    self.inks.get(under_f.as_deref(), self.ctx.theme)
                };
                let attrs = format!(
                    r#" class="pele-frame-label" fill="{}" stroke="none""#,
                    fill_color.as_deref().unwrap_or(self.ctx.theme.muted()),
                );
                let title_lbl = &self.layout.frames_pool[fidx].title;
                inner.push_str(&label_svg(title_lbl, cx, cy, &attrs, self.ctx.theme, self.ctx.icons));
            }
            self.frames_out
                .push_str(&format!(r#"<g class="pele-frame pele-frame-{frame_kind_s}">{inner}</g>"#));
        }
        self.y = bottom;
    }

    fn paint_note(&mut self, i: usize, msg: &SeqMessage) {
        let view = self.layout.views[i].as_ref().unwrap();
        let a = &self.layout.cols[view.a];
        let h = view.label.height + 2.0 * 4.0f64.max(self.m.note_pad - 4.0);
        let top = self.y + 10.0;
        let mut x = view.x;
        if msg.placement == Some(Placement::RightOf) {
            x += right_edge(a, 0) - a.x;
        } else if msg.placement == Some(Placement::LeftOf) {
            x += left_edge(a, 0) - a.x;
        }
        let w = view.w;
        let lbl_attrs = format!(r#" class="pele-label" stroke="none" fill="{}""#, self.ctx.theme.fg());
        let label_out = label_svg(&view.label, x + w / 2.0, top + h / 2.0, &lbl_attrs, self.ctx.theme, self.ctx.icons);
        if x < self.layout.min_x {
            self.layout.min_x = x;
        }
        if x + w > self.layout.max_x {
            self.layout.max_x = x + w;
        }
        self.notes_out.push_str(&format!(
            r#"<g class="pele-note" data-id="i{}"><rect x="{}" y="{}" width="{}" height="{}"{}/>{label_out}</g>"#,
            esc_text(&msg.id),
            num(x),
            num(top),
            num(w),
            num(h),
            self.rounded_standalone,
        ));
        self.y = top + h;
    }

    fn paint_message(&mut self, i: usize, msg: &SeqMessage) {
        let messages = &self.db.messages;
        let count = messages.len();
        let st = line_style(msg.line_type.unwrap()).unwrap();
        let bw = self.m.badge_width(self.ctx, self.numbering, i);
        let mut starting = 0usize;
        for mk in &messages[(i + 1)..count] {
            match mk.line_type {
                Some(LineType::ActiveStart) => {
                    if mk.from == msg.to {
                        starting += 1;
                    }
                }
                Some(LineType::ActiveEnd | LineType::CentralConnection | LineType::CentralConnectionReverse) => {}
                _ => break,
            }
        }
        let up = if st.bottom { 1.0 } else { -1.0 };
        let attrs = if st.dotted { DASH } else { "" };
        let circle_to = matches!(msg.central_connection, Some(LineType::CentralConnection | LineType::CentralConnectionDual));
        let circle_from = matches!(
            msg.central_connection,
            Some(LineType::CentralConnectionReverse | LineType::CentralConnectionDual)
        );
        let tail_at_end = st.at_start && !st.at_end;
        let trim_len = head_trim(st.head);
        let bg = self.ctx.theme.bg();
        let mut inner = String::new();
        let line_y: f64;
        let line_override: Option<String>;

        let (view_kind, view_a, view_b, label_w, label_h) = {
            let v = self.layout.views[i].as_ref().unwrap();
            (v.kind, v.a, v.b, v.label.width, v.label.height)
        };

        if view_kind == ViewKind::SelfLoop {
            let ax = self.layout.cols[view_a].x;
            let top = self.y + self.m.msg_gap + ((label_h - SELF_H) / 2.0).max(0.0);
            let bottom = top + SELF_H;
            let mut x0 = if circle_from {
                ax + CENTRAL_R
            } else {
                right_edge(&self.layout.cols[view_a], 0)
            };
            let mut x1 = if circle_to {
                ax + CENTRAL_R
            } else {
                right_edge(&self.layout.cols[view_a], starting)
            };
            let out = x0.max(x1) + SELF_W + bw / 2.0;
            let uf = self.fill_under(ax, out);
            line_override = self.inks.get(uf.as_deref(), self.ctx.theme);
            let color = line_override.as_deref().unwrap_or(self.ctx.theme.line());
            if circle_from {
                inner.push_str(&format!(
                    r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                    num(ax),
                    num(top),
                    num(CENTRAL_R),
                ));
            }
            if circle_to {
                inner.push_str(&format!(
                    r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                    num(ax),
                    num(bottom),
                    num(CENTRAL_R),
                ));
            }
            if bw > 0.0 {
                let (bx, by) = if tail_at_end { (x1, bottom) } else { (x0, top) };
                inner.push_str(&self.m.badge_svg(self.ctx, self.numbering.index[i], bx, by, bw));
                if tail_at_end {
                    x1 += bw / 2.0;
                } else {
                    x0 += bw / 2.0;
                }
            }
            let mut heads = String::new();
            if st.at_start {
                heads.push_str(&draw_head(st.head, x0, top, -1.0, up, color, bg));
            }
            if st.at_end {
                heads.push_str(&draw_head(st.head, x1, bottom, -1.0, -up, color, bg));
            }
            let from_s = num(x0 + if st.at_start { trim_len } else { 0.0 });
            let to_s = num(x1 + if st.at_end { trim_len } else { 0.0 });
            let d = if self.m.right_angles {
                format!("M{from_s},{}H{}V{}H{to_s}", num(top), num(out), num(bottom))
            } else {
                format!(
                    "M{from_s},{}H{}A6,6 0 0 1 {},{}V{}A6,6 0 0 1 {},{}H{to_s}",
                    num(top),
                    num(out - 6.0),
                    num(out),
                    num(top + 6.0),
                    num(bottom - 6.0),
                    num(out - 6.0),
                    num(bottom),
                )
            };
            inner = format!(r#"<path d="{d}"{attrs}/>{heads}{inner}"#);
            if ax < self.layout.min_x {
                self.layout.min_x = ax;
            }
            if out + 8.0 + label_w > self.layout.max_x {
                self.layout.max_x = out + 8.0 + label_w;
            }
            if label_w > 0.0 {
                let uf_l = self.fill_under(out + 8.0, out + 8.0 + label_w);
                let lbl_fill = self
                    .inks
                    .get(uf_l.as_deref(), self.ctx.theme)
                    .map_or_else(String::new, |c| format!(r#" fill="{c}""#));
                let label = &self.layout.views[i].as_ref().unwrap().label;
                self.labels_out.push_str(&format!(
                    r#"<g class="pele-edge-label" data-id="i{}">{}</g>"#,
                    esc_text(&msg.id),
                    label_svg(
                        label,
                        out + 8.0 + label_w / 2.0,
                        (top + bottom) / 2.0,
                        &lbl_fill,
                        self.ctx.theme,
                        self.ctx.icons
                    ),
                ));
            }
            line_y = bottom.max((top + bottom) / 2.0 + label_h / 2.0);
        } else {
            let ax = self.layout.cols[view_a].x;
            let bx = self.layout.cols[view_b].x;
            let dir = if bx > ax { 1.0 } else { -1.0 };
            let creating = self.layout.cols[view_b].create_at == i as i32;
            let uf = self.fill_under(ax.min(bx), ax.max(bx));
            line_override = self.inks.get(uf.as_deref(), self.ctx.theme);
            let color = line_override.as_deref().unwrap_or(self.ctx.theme.line());
            let extra_h = if label_h > 0.0 { label_h + 2.0 } else { 6.0 };
            let create_h = if creating {
                self.layout.cols[view_b].size.h / 2.0 - self.m.msg_gap + 6.0
            } else {
                0.0
            };
            line_y = self.y + self.m.msg_gap + extra_h.max(create_h);
            let mut x0 = if dir > 0.0 {
                right_edge(&self.layout.cols[view_a], 0)
            } else {
                left_edge(&self.layout.cols[view_a], 0)
            };
            let mut x1 = if dir > 0.0 {
                left_edge(&self.layout.cols[view_b], starting)
            } else {
                right_edge(&self.layout.cols[view_b], starting)
            };
            if creating {
                let bh = self.layout.cols[view_b].size.h;
                let bw_col = self.layout.cols[view_b].size.w;
                let bkind = self.layout.cols[view_b].kind;
                self.layout.cols[view_b].top = line_y - bh / 2.0;
                self.layout.cols[view_b].life_start = self.layout.cols[view_b].top + bh;
                x1 = bx - dir * if bkind.is_figure() { 18.0 } else { bw_col / 2.0 + 1.0 };
            }
            if circle_from {
                inner.push_str(&format!(
                    r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                    num(ax),
                    num(line_y),
                    num(CENTRAL_R),
                ));
                x0 = ax + dir * CENTRAL_R;
            }
            if circle_to {
                inner.push_str(&format!(
                    r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                    num(bx),
                    num(line_y),
                    num(CENTRAL_R),
                ));
                x1 = bx - dir * CENTRAL_R;
            }
            if bw > 0.0 {
                if tail_at_end {
                    let cx = if circle_to { x1 - dir * (bw / 2.0 + 2.0) } else { x1 };
                    inner.push_str(&self.m.badge_svg(self.ctx, self.numbering.index[i], cx, line_y, bw));
                    x1 = cx - (dir * bw) / 2.0;
                } else {
                    let cx = if circle_from { x0 + dir * (bw / 2.0 + 2.0) } else { x0 };
                    inner.push_str(&self.m.badge_svg(self.ctx, self.numbering.index[i], cx, line_y, bw));
                    x0 = cx + (dir * bw) / 2.0;
                }
            }
            let mut heads = String::new();
            if st.at_start {
                heads.push_str(&draw_head(st.head, x0, line_y, -dir, up * dir, color, bg));
            }
            if st.at_end {
                heads.push_str(&draw_head(st.head, x1, line_y, dir, up * dir, color, bg));
            }
            let from_x = x0 + if st.at_start { dir * trim_len } else { 0.0 };
            let to_x = x1 - if st.at_end { dir * trim_len } else { 0.0 };
            inner = format!(r#"<path d="M{},{}H{}"{attrs}/>{heads}{inner}"#, num(from_x), num(line_y), num(to_x),);
            if label_w > 0.0 {
                let l = x0.min(x1);
                let r = x0.max(x1);
                let cx = if self.m.align < 0 {
                    l + self.m.msg_pad + label_w / 2.0
                } else if self.m.align > 0 {
                    r - self.m.msg_pad - label_w / 2.0
                } else {
                    (l + r) / 2.0
                };
                let cy = line_y - 4.0 - label_h / 2.0;
                if cx - label_w / 2.0 < self.layout.min_x {
                    self.layout.min_x = cx - label_w / 2.0;
                }
                if cx + label_w / 2.0 > self.layout.max_x {
                    self.layout.max_x = cx + label_w / 2.0;
                }
                let ll = cx - label_w / 2.0;
                let plate = self.crosses(ll, ll + label_w);
                let back = if plate {
                    format!(
                        r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}" stroke="none"/>"#,
                        num(ll - 3.0),
                        num(cy - label_h / 2.0 + 2.0),
                        num(label_w + 6.0),
                        num(label_h - 4.0),
                        self.ctx.theme.bg(),
                    )
                } else {
                    String::new()
                };
                let lbl_fill = if plate {
                    String::new()
                } else {
                    let uf_l = self.fill_under(ll, ll + label_w);
                    self.inks
                        .get(uf_l.as_deref(), self.ctx.theme)
                        .map_or_else(String::new, |c| format!(r#" fill="{c}""#))
                };
                let label = &self.layout.views[i].as_ref().unwrap().label;
                self.labels_out.push_str(&format!(
                    r#"<g class="pele-edge-label" data-id="i{}">{back}{}</g>"#,
                    esc_text(&msg.id),
                    label_svg(label, cx, cy, &lbl_fill, self.ctx.theme, self.ctx.icons),
                ));
            }
            if creating {
                self.y = line_y + self.layout.cols[view_b].size.h / 2.0 - 6.0;
            }
        }

        let stroke_attr = line_override.as_deref().map_or_else(String::new, |c| format!(r#" stroke="{c}""#));
        self.edges_out.push_str(&format!(
            r#"<g class="pele-edge pele-message" data-id="i{}"{stroke_attr}>{inner}</g>"#,
            esc_text(&msg.id),
        ));
        self.y = self.y.max(line_y);
        if self.layout.cols[view_a].destroy_at == i as i32 {
            let dy = self.destroy_actor(view_a, line_y);
            self.y = self.y.max(dy);
        }
        if view_b != view_a && self.layout.cols[view_b].destroy_at == i as i32 {
            let dy = self.destroy_actor(view_b, line_y);
            self.y = self.y.max(dy);
        }
    }
}

pub(super) fn paint_timeline<'a>(
    db: &'a SeqDb,
    ctx: &RenderContext<'_>,
    m: &Metrics,
    numbering: &Numbering,
    layout: &mut HorizontalLayout<'a>,
    inks: &mut InkCache,
) -> TimelineOutput<'a> {
    let mut box_title_h = 0.0f64;
    for run in &layout.runs {
        box_title_h = box_title_h.max(run.title.height);
    }
    let box_top = if layout.runs.is_empty() {
        0.0
    } else {
        m.box_pad + if box_title_h > 0.0 { box_title_h + 4.0 } else { 0.0 }
    };
    let mut row_h = 0.0f64;
    for col in &layout.cols {
        if col.create_at < 0 {
            row_h = row_h.max(col.size.h);
        }
    }
    let head_bottom = box_top + row_h;
    for col in &mut layout.cols {
        col.top = head_bottom - col.size.h;
        col.life_start = head_bottom;
    }

    let xs: Vec<f64> = layout.cols.iter().map(|c| c.x).collect();
    let box_ranges: Vec<(f64, f64, &'a str)> = layout
        .runs
        .iter()
        .map(|run| {
            let x0 = layout.cols[run.first].x - layout.cols[run.first].size.w / 2.0 - m.box_pad - run.grow;
            let x1 = layout.cols[run.last].x + layout.cols[run.last].size.w / 2.0 + m.box_pad + run.grow;
            (x0, x1, run.box_ref.fill.as_str())
        })
        .collect();

    let mut painter = TimelinePainter {
        db,
        ctx,
        m,
        numbering,
        layout,
        inks,
        xs,
        box_ranges,
        stack: Vec::new(),
        rounded_standalone: ctx.theme.rounded_standalone(),
        rects_out: Vec::new(),
        activations_out: Vec::new(),
        frames_out: String::new(),
        edges_out: String::new(),
        labels_out: String::new(),
        notes_out: String::new(),
        crosses_out: String::new(),
        y: head_bottom + 6.0,
    };

    for (i, msg) in db.messages.iter().enumerate() {
        let lt = msg.line_type;
        if lt == Some(LineType::ActiveStart) {
            if let Some(col_idx) = msg.from.as_deref().and_then(|s| painter.layout.col_of.get(s).copied()) {
                painter.layout.cols[col_idx].activations.push(painter.y);
            }
        } else if lt == Some(LineType::ActiveEnd) {
            if let Some(col_idx) = msg.from.as_deref().and_then(|s| painter.layout.col_of.get(s).copied())
                && !painter.layout.cols[col_idx].activations.is_empty()
            {
                let bot = painter.end_activation(col_idx, painter.y);
                painter.y = painter.y.max(bot);
            }
        } else if let Some(fidx) = painter.layout.frame_at[i]
            && painter.layout.frames_pool[fidx].dividers[0] == i
        {
            painter.stack.push(fidx);
            if painter.layout.frames_pool[fidx].kind == "rect" {
                painter.layout.frames_pool[fidx].top = painter.y + 8.0;
                painter.y = painter.layout.frames_pool[fidx].top;
            } else {
                painter.layout.frames_pool[fidx].top = painter.y + 12.0;
                painter.y = painter.layout.frames_pool[fidx].top + TAB_H.max(painter.layout.frames_pool[fidx].title.height + 2.0);
            }
        } else if let Some(fidx) = painter.layout.frame_at[i] {
            painter.paint_frame_close(fidx);
        } else if lt.is_some_and(is_frame_divider) {
            if let Some(&fidx) = painter.stack.last() {
                let div_idx = painter.layout.frames_pool[fidx].divider_y.len();
                let lh = painter.layout.frames_pool[fidx].divider_labels.get(div_idx).map_or(0.0, |l| l.height);
                painter.layout.frames_pool[fidx].divider_y.push(painter.y + 12.0);
                painter.y += 12.0 + if lh > 0.0 { lh } else { 0.0 };
            }
        } else if let Some(view_kind) = painter.layout.views[i].as_ref().map(|v| v.kind) {
            if view_kind == ViewKind::Note {
                painter.paint_note(i, msg);
            } else {
                painter.paint_message(i, msg);
            }
        }
    }

    painter.y += 20.0;
    for col_idx in 0..painter.layout.cols.len() {
        while !painter.layout.cols[col_idx].activations.is_empty() {
            painter.end_activation(col_idx, painter.y);
        }
    }

    TimelineOutput {
        rects_out: painter.rects_out,
        activations_out: painter.activations_out,
        frames_out: painter.frames_out,
        edges_out: painter.edges_out,
        labels_out: painter.labels_out,
        notes_out: painter.notes_out,
        crosses_out: painter.crosses_out,
        box_ranges: painter.box_ranges,
        y: painter.y,
    }
}
