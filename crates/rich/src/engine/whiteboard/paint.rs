use std::collections::{BTreeSet, HashMap};

use nsh_core::canvas::{CanvasGradient, CanvasNode, CanvasTextAlign, CanvasTextBaseline, Drawing, LineCap, LineJoin};
use nsh_core::prelude::{AccessibilityRole, Bounds, Hsla, Painter, Percentage, Size, point, px, radians, rgb, rgba, size};
use nsh_core::{Color, PaintStyle};

use crate::engine::whiteboard::geometry::{
    Camera, CubicSegment, HeadShape, RouteShape, anchor_point, arrowhead_geometry, catmull_rom_cubics, route_arrow, sample_polyline,
};
use crate::engine::whiteboard::hit::{ResizeHandle8, anchor_port_pos, can_host_anchor_port, container_header_rect, rotate_handle_pos};
use crate::engine::whiteboard::ink::build_ink_outline;
use crate::engine::whiteboard::interaction::{AnimatedPresencePose, InteractionMode, WhiteboardController, live_anchor_point};
use crate::engine::whiteboard::layout::{layout_card, layout_table, locate_highlight_span, measure_text_span, wrap_text};
use crate::engine::whiteboard::model::{
    BoardDoc, ElementId, ElementKind, ElementRecord, GridStyle, InkMode, MilestoneKind, Point2, Presence, PresenceColor, PresenceKind, Rect2, ShapeKind,
    StrokeStyle, TextAlign, TextVariant, WbFill,
};
use crate::engine::whiteboard::snap::{SnapAxis, SnapGuide};
use crate::engine::whiteboard::spatial::SpatialIndex;
use crate::engine::whiteboard::stickers::{cached_svg_drawing, resolve_sticker_svg};
use crate::theme::UiPalette;

#[derive(Debug, Clone, Copy)]
pub struct FillTone {
    pub fill: Hsla,
    pub border: Hsla,
    pub ink: Hsla,
}

#[derive(Debug, Clone, Copy)]
pub struct WhiteboardPalette {
    pub page: Hsla,
    pub side: Hsla,
    pub ink: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub line: Hsla,
    pub accent: Hsla,
    pub grid_minor: Hsla,
    pub grid_major: Hsla,
    pub grid_dot: Hsla,
    pub timeline_start: Hsla,
    pub timeline_mid: Hsla,
    pub timeline_end: Hsla,
    pub timeline_halo: Hsla,
    pub pill_bg: Hsla,
    pub pill_ink: Hsla,
    pub minor_node_bg: Hsla,
    pub minor_node_border: Hsla,
    pub highlight_bg: Hsla,
    pub highlight_ink: Hsla,
    pub arrow_default: Hsla,
    pub arrow_label_bg: Hsla,
    pub container_bg: Hsla,
    pub container_border: Hsla,
    pub container_header_bg: Hsla,
    pub table_header_bg: Hsla,
    pub selection: Hsla,
    pub selection_soft: Hsla,
    pub snap_guide: Hsla,
    pub card_shadow: Hsla,
    pub tone_default: FillTone,
    pub tone_sun: FillTone,
    pub tone_peach: FillTone,
    pub tone_leaf: FillTone,
    pub tone_water: FillTone,
    pub tone_lavender: FillTone,
    pub tone_berry: FillTone,
    pub tone_side: FillTone,
    pub sticky_sun: FillTone,
    pub sticky_peach: FillTone,
    pub sticky_leaf: FillTone,
    pub sticky_water: FillTone,
    pub sticky_lavender: FillTone,
    pub sticky_berry: FillTone,
    pub sticky_side: FillTone,
    pub pill_side: FillTone,
    pub pill_lavender: FillTone,
    pub presence_coral: Hsla,
    pub presence_teal: Hsla,
    pub presence_blue: Hsla,
    pub presence_leaf: Hsla,
    pub presence_wheat: Hsla,
    pub presence_lavender: Hsla,
}

impl WhiteboardPalette {
    pub fn for_mode(dark: bool) -> Self {
        if dark { Self::dark() } else { Self::light() }
    }

    pub fn light() -> Self {
        let ui = UiPalette::LIGHT;
        Self {
            page: ui.page,
            side: ui.side,
            ink: ui.ink,
            muted: ui.muted,
            faint: ui.faint,
            line: ui.line,
            accent: ui.accent,
            grid_minor: rgba(0x1c19_170b).to_hsla(),
            grid_major: rgba(0x1c19_1716).to_hsla(),
            grid_dot: rgba(0x1c19_1726).to_hsla(),
            timeline_start: rgb(0xdd6f57).to_hsla(),
            timeline_mid: rgb(0xec9658).to_hsla(),
            timeline_end: rgb(0xe5864c).to_hsla(),
            timeline_halo: rgba(0xfcfc_fbcc).to_hsla(),
            pill_bg: rgb(0xd86c51).to_hsla(),
            pill_ink: rgb(0xfefefe).to_hsla(),
            minor_node_bg: rgb(0xfcfcfb).to_hsla(),
            minor_node_border: rgb(0xd4cdc3).to_hsla(),
            highlight_bg: rgb(0xe0ebf9).to_hsla(),
            highlight_ink: rgb(0x2c5ea8).to_hsla(),
            arrow_default: rgb(0x8a8178).to_hsla(),
            arrow_label_bg: rgba(0xfcfc_fbe8).to_hsla(),
            container_bg: rgba(0xffff_ffb8).to_hsla(),
            container_border: rgb(0xe5e1db).to_hsla(),
            container_header_bg: rgb(0xebe6de).to_hsla(),
            table_header_bg: rgb(0xf3f0eb).to_hsla(),
            selection: rgb(0x2c6aa3).to_hsla(),
            selection_soft: rgba(0x2c6a_a320).to_hsla(),
            snap_guide: rgb(0xdd6f57).to_hsla(),
            card_shadow: rgba(0x1c19_171a).to_hsla(),
            tone_default: FillTone {
                fill: rgb(0xfffdf9).to_hsla(),
                border: rgb(0xded8ce).to_hsla(),
                ink: ui.ink,
            },
            tone_sun: FillTone {
                fill: rgb(0xffe57f).to_hsla(),
                border: rgb(0xe8c456).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_peach: FillTone {
                fill: rgb(0xf9ba7b).to_hsla(),
                border: rgb(0xe29a57).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_leaf: FillTone {
                fill: rgb(0xcce6b6).to_hsla(),
                border: rgb(0x9ac17a).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_water: FillTone {
                fill: rgb(0xcde2f8).to_hsla(),
                border: rgb(0x94bae2).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_lavender: FillTone {
                fill: rgb(0xdfd4f8).to_hsla(),
                border: rgb(0xb39de4).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_berry: FillTone {
                fill: rgb(0xf8d0ca).to_hsla(),
                border: rgb(0xde9a90).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_side: FillTone {
                fill: rgb(0xf6f5f3).to_hsla(),
                border: rgb(0xd8d2c7).to_hsla(),
                ink: ui.ink,
            },
            sticky_sun: FillTone {
                fill: rgb(0xf7d02c).to_hsla(),
                border: rgb(0xe0b918).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            sticky_peach: FillTone {
                fill: rgb(0xf8b16e).to_hsla(),
                border: rgb(0xde9450).to_hsla(),
                ink: rgb(0x241911).to_hsla(),
            },
            sticky_leaf: FillTone {
                fill: rgb(0x6ed16f).to_hsla(),
                border: rgb(0x55b856).to_hsla(),
                ink: rgb(0x152015).to_hsla(),
            },
            sticky_water: FillTone {
                fill: rgb(0x69aef4).to_hsla(),
                border: rgb(0x4f95dc).to_hsla(),
                ink: rgb(0x141d26).to_hsla(),
            },
            sticky_lavender: FillTone {
                fill: rgb(0xb39bf2).to_hsla(),
                border: rgb(0x957bd9).to_hsla(),
                ink: rgb(0x1d172c).to_hsla(),
            },
            sticky_berry: FillTone {
                fill: rgb(0xf080ae).to_hsla(),
                border: rgb(0xd76594).to_hsla(),
                ink: rgb(0x23141c).to_hsla(),
            },
            sticky_side: FillTone {
                fill: rgb(0xd8d6d2).to_hsla(),
                border: rgb(0xc5c2bc).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            pill_side: FillTone {
                fill: rgb(0xd6d5d2).to_hsla(),
                border: rgb(0xc4c2be).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            pill_lavender: FillTone {
                fill: rgb(0xb5a2f2).to_hsla(),
                border: rgb(0x947de0).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            presence_coral: rgb(0xc8561f).to_hsla(),
            presence_teal: rgb(0x1a7f74).to_hsla(),
            presence_blue: rgb(0x2c6aa3).to_hsla(),
            presence_leaf: rgb(0x4d7a2a).to_hsla(),
            presence_wheat: rgb(0xc48b20).to_hsla(),
            presence_lavender: rgb(0x7c52a8).to_hsla(),
        }
    }

    pub fn dark() -> Self {
        let ui = UiPalette::DARK;
        Self {
            page: ui.page,
            side: ui.side,
            ink: ui.ink,
            muted: ui.muted,
            faint: ui.faint,
            line: ui.line,
            accent: ui.accent,
            grid_minor: rgba(0xeceb_e80a).to_hsla(),
            grid_major: rgba(0xeceb_e814).to_hsla(),
            grid_dot: rgba(0xeceb_e824).to_hsla(),
            timeline_start: rgb(0xe48369).to_hsla(),
            timeline_mid: rgb(0xef9f64).to_hsla(),
            timeline_end: rgb(0xe8925c).to_hsla(),
            timeline_halo: rgba(0x1514_13aa).to_hsla(),
            pill_bg: rgb(0xd87158).to_hsla(),
            pill_ink: rgb(0xfcfcfb).to_hsla(),
            minor_node_bg: rgb(0x262421).to_hsla(),
            minor_node_border: rgb(0x524d47).to_hsla(),
            highlight_bg: rgb(0x263952).to_hsla(),
            highlight_ink: rgb(0x8ec1f2).to_hsla(),
            arrow_default: rgb(0x9e978f).to_hsla(),
            arrow_label_bg: rgba(0x1b1a_18e8).to_hsla(),
            container_bg: rgba(0x1d1c_19cc).to_hsla(),
            container_border: rgb(0x3a3732).to_hsla(),
            container_header_bg: rgb(0x262420).to_hsla(),
            table_header_bg: rgb(0x23211e).to_hsla(),
            selection: rgb(0x6aa6dc).to_hsla(),
            selection_soft: rgba(0x6aa6_dc28).to_hsla(),
            snap_guide: rgb(0xe48369).to_hsla(),
            card_shadow: rgba(0x0000_0048).to_hsla(),
            tone_default: FillTone {
                fill: rgb(0x23211e).to_hsla(),
                border: rgb(0x3e3a35).to_hsla(),
                ink: ui.ink,
            },
            tone_sun: FillTone {
                fill: rgb(0x4a3d1f).to_hsla(),
                border: rgb(0x8a6f2e).to_hsla(),
                ink: rgb(0xf9ecc2).to_hsla(),
            },
            tone_peach: FillTone {
                fill: rgb(0x4d3121).to_hsla(),
                border: rgb(0x9e633f).to_hsla(),
                ink: rgb(0xfadbc4).to_hsla(),
            },
            tone_leaf: FillTone {
                fill: rgb(0x253b25).to_hsla(),
                border: rgb(0x4d7a44).to_hsla(),
                ink: rgb(0xd7eec7).to_hsla(),
            },
            tone_water: FillTone {
                fill: rgb(0x1f344b).to_hsla(),
                border: rgb(0x4a7bad).to_hsla(),
                ink: rgb(0xd2e7fc).to_hsla(),
            },
            tone_lavender: FillTone {
                fill: rgb(0x322848).to_hsla(),
                border: rgb(0x7861aa).to_hsla(),
                ink: rgb(0xe7defc).to_hsla(),
            },
            tone_berry: FillTone {
                fill: rgb(0x492825).to_hsla(),
                border: rgb(0xa85b52).to_hsla(),
                ink: rgb(0xfad8d2).to_hsla(),
            },
            tone_side: FillTone {
                fill: rgb(0x1b1a18).to_hsla(),
                border: rgb(0x383530).to_hsla(),
                ink: ui.ink,
            },
            sticky_sun: FillTone {
                fill: rgb(0x5b4814).to_hsla(),
                border: rgb(0x9d7b22).to_hsla(),
                ink: rgb(0xfceeae).to_hsla(),
            },
            sticky_peach: FillTone {
                fill: rgb(0x59351a).to_hsla(),
                border: rgb(0xab6b39).to_hsla(),
                ink: rgb(0xffe2c7).to_hsla(),
            },
            sticky_leaf: FillTone {
                fill: rgb(0x1f4a24).to_hsla(),
                border: rgb(0x458c4d).to_hsla(),
                ink: rgb(0xd7f6d9).to_hsla(),
            },
            sticky_water: FillTone {
                fill: rgb(0x1b3b5c).to_hsla(),
                border: rgb(0x4482bf).to_hsla(),
                ink: rgb(0xd8ecff).to_hsla(),
            },
            sticky_lavender: FillTone {
                fill: rgb(0x382b59).to_hsla(),
                border: rgb(0x7c63bd).to_hsla(),
                ink: rgb(0xe9e0ff).to_hsla(),
            },
            sticky_berry: FillTone {
                fill: rgb(0x542239).to_hsla(),
                border: rgb(0xa64d75).to_hsla(),
                ink: rgb(0xffdce9).to_hsla(),
            },
            sticky_side: FillTone {
                fill: rgb(0x2d2c28).to_hsla(),
                border: rgb(0x47453f).to_hsla(),
                ink: ui.ink,
            },
            pill_side: FillTone {
                fill: rgb(0x2c2b28).to_hsla(),
                border: rgb(0x45423d).to_hsla(),
                ink: ui.ink,
            },
            pill_lavender: FillTone {
                fill: rgb(0x3d2e66).to_hsla(),
                border: rgb(0x7d64c2).to_hsla(),
                ink: rgb(0xefeaff).to_hsla(),
            },
            presence_coral: rgb(0xd96d3d).to_hsla(),
            presence_teal: rgb(0x3ab2a4).to_hsla(),
            presence_blue: rgb(0x6aa6dc).to_hsla(),
            presence_leaf: rgb(0x8dbb5c).to_hsla(),
            presence_wheat: rgb(0xe5a93c).to_hsla(),
            presence_lavender: rgb(0xb48ef5).to_hsla(),
        }
    }

    pub fn tone(&self, fill: &WbFill) -> FillTone {
        match fill {
            WbFill::Default => self.tone_default,
            WbFill::Sun => self.tone_sun,
            WbFill::Peach => self.tone_peach,
            WbFill::Leaf => self.tone_leaf,
            WbFill::Water => self.tone_water,
            WbFill::Lavender => self.tone_lavender,
            WbFill::Berry => self.tone_berry,
            WbFill::Side => self.tone_side,
            WbFill::Custom(hex) => {
                if let Some(c) = parse_hex_hsla(hex) {
                    FillTone {
                        fill: c,
                        border: self.tone_default.border,
                        ink: self.ink,
                    }
                } else {
                    self.tone_default
                }
            }
        }
    }

    pub fn shape_tone(&self, shape: ShapeKind, fill: &WbFill) -> FillTone {
        if shape == ShapeKind::Sticky {
            match fill {
                WbFill::Sun => self.sticky_sun,
                WbFill::Peach => self.sticky_peach,
                WbFill::Leaf => self.sticky_leaf,
                WbFill::Water => self.sticky_water,
                WbFill::Lavender => self.sticky_lavender,
                WbFill::Berry => self.sticky_berry,
                WbFill::Side => self.sticky_side,
                WbFill::Default | WbFill::Custom(_) => self.tone(fill),
            }
        } else if matches!(shape, ShapeKind::Pill | ShapeKind::Rounded) {
            match fill {
                WbFill::Side => self.pill_side,
                WbFill::Lavender => self.pill_lavender,
                _ => self.tone(fill),
            }
        } else {
            self.tone(fill)
        }
    }

    pub fn presence_color(&self, color: PresenceColor) -> Hsla {
        match color {
            PresenceColor::Coral => self.presence_coral,
            PresenceColor::Teal => self.presence_teal,
            PresenceColor::Blue => self.presence_blue,
            PresenceColor::Leaf => self.presence_leaf,
            PresenceColor::Wheat => self.presence_wheat,
            PresenceColor::Lavender => self.presence_lavender,
        }
    }

    pub fn resolve_presence_color(&self, p: &Presence) -> Hsla {
        p.custom_color
            .as_deref()
            .and_then(parse_hex_hsla)
            .unwrap_or_else(|| self.presence_color(p.color))
    }
}

pub fn parse_hex_hsla(raw: &str) -> Option<Hsla> {
    let hex = raw.trim().strip_prefix('#')?;
    match hex.len() {
        6 => {
            let v = u32::from_str_radix(hex, 16).ok()?;
            Some(rgb(v).to_hsla())
        }
        8 => {
            let v = u32::from_str_radix(hex, 16).ok()?;
            Some(rgba(v).to_hsla())
        }
        3 => {
            let mut chars = hex.chars();
            let r = chars.next()?.to_digit(16)?;
            let g = chars.next()?.to_digit(16)?;
            let b = chars.next()?.to_digit(16)?;
            let v = ((r * 17) << 16) | ((g * 17) << 8) | (b * 17);
            Some(rgb(v).to_hsla())
        }
        _ => None,
    }
}

pub struct LayerPaintInput<'a> {
    pub doc: &'a BoardDoc,
    pub index: &'a SpatialIndex,
    pub lookup: &'a HashMap<ElementId, Rect2>,
    pub camera: Camera,
    pub viewport_size: (f32, f32),
    pub selection: &'a [ElementId],
    pub editing_id: Option<&'a ElementId>,
    pub dark: bool,
    pub anim_hidden_ids: &'a BTreeSet<ElementId>,
}

pub fn paint_static_layer(input: &LayerPaintInput<'_>) -> Drawing {
    paint_static_layer_painter(input).finish()
}

pub fn paint_static_layer_painter(input: &LayerPaintInput<'_>) -> Painter {
    let pal = WhiteboardPalette::for_mode(input.dark);
    let vw = input.viewport_size.0.max(1.0);
    let vh = input.viewport_size.1.max(1.0);

    let bg = input.doc.meta.background.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.page);

    let mut painter = Painter::new()
        .begin_path()
        .fill_color(bg)
        .rect(Bounds::new(point(px(0.0), px(0.0)), size(px(vw), px(vh))))
        .fill();

    painter = paint_grid(painter, input.doc.meta.grid, input.camera, vw, vh, &pal);

    let world_view = input.camera.visible_world_rect(f64::from(vw), f64::from(vh));
    let mut visible: BTreeSet<usize> = input.index.query_rect(world_view.expand(120.0)).into_iter().collect();
    for (idx, el) in input.doc.elements.iter().enumerate() {
        if (el.is_arrow() || matches!(el.kind, ElementKind::Timeline { .. })) && el.visual_bbox(input.lookup).intersects(world_view.expand(180.0)) {
            visible.insert(idx);
        }
    }

    painter = painter
        .save()
        .translate(input.camera.pan_x as f32, input.camera.pan_y as f32)
        .scale(input.camera.zoom as f32, input.camera.zoom as f32);

    painter = paint_board_into_painter(painter, input.doc, input.lookup, &pal, Some(&visible), input.editing_id, input.anim_hidden_ids);

    painter = painter.restore();

    // Emit accessibility/hit-testing nodes in viewport coordinates.
    let sel_set: BTreeSet<&ElementId> = input.selection.iter().collect();
    for &idx in &visible {
        let Some(el) = input.doc.elements.get(idx) else {
            continue;
        };
        if input.anim_hidden_ids.contains(&el.id) {
            continue;
        }
        let world_r = el.bbox(input.lookup);
        let tl = input.camera.world_to_screen(Point2::new(world_r.x, world_r.y));
        let br = input.camera.world_to_screen(Point2::new(world_r.right(), world_r.bottom()));
        let sw = (br.x - tl.x).max(8.0) as f32;
        let sh = (br.y - tl.y).max(8.0) as f32;
        let bounds = Bounds::new(point(px(tl.x as f32), px(tl.y as f32)), size(px(sw), px(sh)));
        painter = painter.node(
            CanvasNode::new(bounds, AccessibilityRole::Button, el.primary_label())
                .test_id(format!("wb-el-{}", el.id))
                .selected(sel_set.contains(&el.id)),
        );
    }

    painter
}

pub fn paint_grid(mut painter: Painter, style: GridStyle, camera: Camera, vw: f32, vh: f32, pal: &WhiteboardPalette) -> Painter {
    if style == GridStyle::None {
        return painter;
    }
    let zoom = camera.zoom.max(0.1);
    let step_world = if zoom < 0.45 { 96.0 } else { 24.0 };
    let step_px = step_world * zoom;
    if step_px < 6.0 {
        return painter;
    }

    let world_view = camera.visible_world_rect(f64::from(vw), f64::from(vh));
    let start_wx = (world_view.x / step_world).floor() * step_world;
    let start_wy = (world_view.y / step_world).floor() * step_world;

    match style {
        GridStyle::Architectural => {
            let major = step_world * 5.0;
            // Minor grid lines.
            painter = painter.stroke_color(pal.grid_minor).line_width(1.0);
            let mut wx = start_wx;
            while wx <= world_view.right() {
                if (wx / major).fract().abs() > 0.05 {
                    let sx = (wx * zoom + camera.pan_x) as f32;
                    painter = painter.begin_path().move_to(sx, 0.0).line_to(sx, vh).stroke();
                }
                wx += step_world;
            }
            let mut wy = start_wy;
            while wy <= world_view.bottom() {
                if (wy / major).fract().abs() > 0.05 {
                    let sy = (wy * zoom + camera.pan_y) as f32;
                    painter = painter.begin_path().move_to(0.0, sy).line_to(vw, sy).stroke();
                }
                wy += step_world;
            }
            // Major grid lines.
            painter = painter.stroke_color(pal.grid_major).line_width(1.0);
            let mut mwx = (world_view.x / major).floor() * major;
            while mwx <= world_view.right() {
                let sx = (mwx * zoom + camera.pan_x) as f32;
                painter = painter.begin_path().move_to(sx, 0.0).line_to(sx, vh).stroke();
                mwx += major;
            }
            let mut mwy = (world_view.y / major).floor() * major;
            while mwy <= world_view.bottom() {
                let sy = (mwy * zoom + camera.pan_y) as f32;
                painter = painter.begin_path().move_to(0.0, sy).line_to(vw, sy).stroke();
                mwy += major;
            }
        }
        GridStyle::Dots => {
            let dot_r = (1.15 * zoom.sqrt()).clamp(0.8, 2.0) as f32;
            painter = painter.fill_color(pal.grid_dot);
            let mut wx = start_wx;
            while wx <= world_view.right() {
                let sx = (wx * zoom + camera.pan_x) as f32;
                let mut wy = start_wy;
                while wy <= world_view.bottom() {
                    let sy = (wy * zoom + camera.pan_y) as f32;
                    painter = painter
                        .begin_path()
                        .ellipse(
                            point(px(sx), px(sy)),
                            size(px(dot_r), px(dot_r)),
                            radians(0.0),
                            radians(0.0),
                            radians(std::f32::consts::TAU),
                            false,
                        )
                        .fill();
                    wy += step_world;
                }
                wx += step_world;
            }
        }
        GridStyle::None => {}
    }

    painter
}

pub fn paint_board_into_painter(
    mut painter: Painter,
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    pal: &WhiteboardPalette,
    visible_indices: Option<&BTreeSet<usize>>,
    editing_id: Option<&ElementId>,
    anim_hidden_ids: &BTreeSet<ElementId>,
) -> Painter {
    let should_draw = |idx: usize, el: &ElementRecord| -> bool {
        if anim_hidden_ids.contains(&el.id) {
            return false;
        }
        visible_indices.is_none_or(|vis| vis.contains(&idx))
    };

    // Pass 1: Containers & Claims
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Container { .. } | ElementKind::Claim { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text);
        }
    }

    // Pass 2: Arrows (strictly BEFORE Timelines so stems tuck under milestone pills cleanly)
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Arrow { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text);
        }
    }

    // Pass 3: Timelines
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Timeline { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text);
        }
    }

    // Pass 4: Shapes, Tables, Images, HtmlEmbeds
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(
            el.kind,
            ElementKind::Shape { .. } | ElementKind::Table { .. } | ElementKind::Image { .. } | ElementKind::HtmlEmbed { .. }
        ) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text);
        }
    }

    // Pass 5: Text (Title, Subtitle, Callout, Body)
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Text { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text);
        }
    }

    // Pass 6: Standalone Stickers & Custom SVGs
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Sticker { .. } | ElementKind::Svg { .. }) {
            painter = paint_element(painter, el, lookup, pal, false);
        }
    }

    // Pass 7: Pressure Ink Paths
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Path { .. }) {
            painter = paint_element(painter, el, lookup, pal, false);
        }
    }

    painter
}

fn paint_element(mut painter: Painter, el: &ElementRecord, lookup: &HashMap<ElementId, Rect2>, pal: &WhiteboardPalette, hide_text: bool) -> Painter {
    let has_rot = el.rotation_deg.abs() > 1e-4 && !el.is_arrow();
    let has_alpha = el.opacity < 0.995;
    let center = el.bbox(lookup).center();

    if has_rot || has_alpha {
        painter = painter.save();
        if has_alpha {
            painter = painter.global_alpha(el.opacity.clamp(0.05, 1.0));
        }
        if has_rot {
            painter = painter
                .translate(center.x as f32, center.y as f32)
                .rotate(radians(el.rotation_deg.to_radians() as f32))
                .translate(-center.x as f32, -center.y as f32);
        }
    }

    painter = match &el.kind {
        ElementKind::Container {
            x,
            y,
            w,
            h,
            title,
            fill,
            stroke,
            collapsed,
        } => paint_container(
            painter,
            Rect2::new(*x, *y, *w, *h),
            (!hide_text).then_some(title.as_str()),
            fill,
            stroke.as_deref(),
            *collapsed,
            pal,
        ),
        ElementKind::Claim {
            x,
            y,
            w,
            h,
            label,
            agent_id,
            status,
        } => paint_claim(painter, Rect2::new(*x, *y, *w, *h), label, agent_id.as_deref(), status.as_deref(), pal),
        ElementKind::Arrow {
            from,
            to,
            bends,
            curve,
            style,
            start_head,
            end_head,
            stroke,
            stroke_width,
            label,
        } => {
            if let Some(geom) = route_arrow(from, to, bends, *curve, lookup) {
                let color = stroke.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.arrow_default);
                paint_arrow_geom(
                    painter,
                    &geom,
                    *style,
                    *start_head,
                    *end_head,
                    color,
                    *stroke_width,
                    if hide_text { None } else { label.as_deref() },
                    pal,
                )
            } else {
                painter
            }
        }
        ElementKind::Timeline {
            x,
            y,
            w,
            h,
            fill: _,
            points,
            milestones,
        } => paint_timeline(painter, Rect2::new(*x, *y, *w, *h), points, milestones, pal, hide_text),
        ElementKind::Shape {
            x,
            y,
            w,
            h,
            shape,
            title,
            body,
            fill,
            stroke,
            stroke_style,
            corner_radius,
            sticker,
            sticker_svg,
            badge,
            align,
        } => paint_shape(
            painter,
            Rect2::new(*x, *y, *w, *h),
            *shape,
            title,
            body,
            fill,
            stroke.as_deref(),
            *stroke_style,
            *corner_radius,
            sticker.as_deref(),
            sticker_svg.as_deref(),
            badge.as_deref(),
            *align,
            pal,
            hide_text,
        ),
        ElementKind::Table {
            x,
            y,
            w,
            h,
            headers,
            rows,
            fill,
        } => paint_table(painter, Rect2::new(*x, *y, *w, *h), headers, rows, fill, pal),
        ElementKind::Image { x, y, w, h, alt, uri, .. } => paint_image_card(painter, Rect2::new(*x, *y, *w, *h), alt.as_deref(), uri, pal),
        ElementKind::HtmlEmbed { x, y, w, h, title, .. } => paint_html_card(painter, Rect2::new(*x, *y, *w, *h), title.as_deref(), pal),
        ElementKind::Text {
            x,
            y,
            w,
            h,
            variant,
            label,
            highlight,
            icon,
            align,
            font_size,
            fill,
            color,
        } => {
            if hide_text {
                painter
            } else {
                paint_text(
                    painter,
                    Rect2::new(*x, *y, *w, *h),
                    *variant,
                    label,
                    highlight.as_deref(),
                    icon.as_deref(),
                    *align,
                    *font_size,
                    fill.as_ref(),
                    color.as_deref(),
                    pal,
                )
            }
        }
        ElementKind::Sticker { x, y, w, h, sticker, svg, .. } => {
            if let Some(svg_src) = resolve_sticker_svg(Some(sticker.as_str()), svg.as_deref()) {
                paint_embedded_svg(painter, *x, *y, *w, *h, svg_src, pal.ink)
            } else {
                painter
            }
        }
        ElementKind::Svg { x, y, w, h, svg, .. } => paint_embedded_svg(painter, *x, *y, *w, *h, svg, pal.ink),
        ElementKind::Path {
            points,
            stroke,
            stroke_width,
            mode,
        } => paint_ink_stroke(painter, points, stroke, *stroke_width, *mode, pal),
    };

    if has_rot || has_alpha {
        painter = painter.restore();
    }
    painter
}

fn paint_container(
    mut painter: Painter,
    rect: Rect2,
    title: Option<&str>,
    fill: &WbFill,
    stroke: Option<&str>,
    collapsed: bool,
    pal: &WhiteboardPalette,
) -> Painter {
    let tone = pal.tone(fill);
    let box_bg = if matches!(fill, WbFill::Side | WbFill::Default) {
        pal.container_bg
    } else {
        Hsla { a: 0.22, ..tone.fill }
    };
    let box_border = stroke.and_then(parse_hex_hsla).unwrap_or(pal.container_border);
    let draw_h = if collapsed { 36.0 } else { rect.h };
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(draw_h as f32)));

    painter = painter.begin_path().fill_color(box_bg).round_rect(bounds, px(12.0)).fill();

    painter = painter.save().stroke_color(box_border).line_width(1.2);
    if collapsed {
        painter = painter.line_dash(&[px(5.0), px(4.0)]);
    }
    painter = painter.begin_path().round_rect(bounds, px(12.0)).stroke().restore();

    if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
        painter = painter
            .fill_color(pal.muted)
            .font("500 12.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Left)
            .text_baseline(CanvasTextBaseline::Bottom)
            .fill_text(title, (rect.x + 2.0) as f32, (rect.y - 9.0) as f32);
    }

    painter
}

fn paint_claim(mut painter: Painter, rect: Rect2, label: &str, agent_id: Option<&str>, status: Option<&str>, pal: &WhiteboardPalette) -> Painter {
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let tint = Hsla { a: 0.08, ..pal.presence_coral };
    painter = painter
        .save()
        .begin_path()
        .fill_color(tint)
        .round_rect(bounds, px(12.0))
        .fill()
        .stroke_color(pal.presence_coral)
        .line_width(1.6)
        .line_dash(&[px(6.0), px(4.0)])
        .begin_path()
        .round_rect(bounds, px(12.0))
        .stroke()
        .restore();

    let badge_text = match (agent_id, status) {
        (Some(a), Some(s)) => format!("{a} · {s} · {label}"),
        (Some(a), None) => format!("{a} · {label}"),
        (None, _) => label.to_owned(),
    };
    let bw = (measure_text_span(&badge_text, 11.0, true) + 18.0).min(rect.w.max(80.0));
    let chip = Bounds::new(point(px((rect.x + 10.0) as f32), px((rect.y - 11.0) as f32)), size(px(bw as f32), px(22.0)));
    painter
        .begin_path()
        .fill_color(pal.presence_coral)
        .round_rect(chip, px(11.0))
        .fill()
        .fill_color(pal.pill_ink)
        .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Left)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&badge_text, (rect.x + 19.0) as f32, rect.y as f32)
}

#[allow(clippy::too_many_arguments)]
fn paint_arrow_geom(
    mut painter: Painter,
    geom: &crate::engine::whiteboard::geometry::ArrowGeometry,
    style: StrokeStyle,
    start_head: crate::engine::whiteboard::model::ArrowHead,
    end_head: crate::engine::whiteboard::model::ArrowHead,
    color: Hsla,
    width: f32,
    label: Option<&str>,
    pal: &WhiteboardPalette,
) -> Painter {
    painter = painter
        .save()
        .stroke_color(color)
        .line_width(width.max(1.2))
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);

    match style {
        StrokeStyle::Solid => {}
        StrokeStyle::Dashed => painter = painter.line_dash(&[px(7.0), px(5.0)]),
        StrokeStyle::Dotted => painter = painter.line_dash(&[px(2.0), px(5.0)]),
    }

    painter = trace_route_shape(painter.begin_path(), &geom.shape).stroke().restore();

    let head_scale = (f64::from(width) / 1.75).clamp(0.85, 1.45);
    if let Some(shape) = arrowhead_geometry(geom.start, vec2_neg(geom.start_dir), start_head, head_scale) {
        painter = paint_head_shape(painter, shape, color);
    }
    if let Some(shape) = arrowhead_geometry(geom.end, geom.end_dir, end_head, head_scale) {
        painter = paint_head_shape(painter, shape, color);
    }

    if let Some(text) = label
        && !text.trim().is_empty()
    {
        let lw = measure_text_span(text, 11.5, true) + 16.0;
        let lb = Bounds::new(
            point(px((geom.label_pos.x - lw * 0.5) as f32), px((geom.label_pos.y - 11.0) as f32)),
            size(px(lw as f32), px(22.0)),
        );
        painter = painter
            .begin_path()
            .fill_color(pal.arrow_label_bg)
            .round_rect(lb, px(6.0))
            .fill()
            .stroke_color(pal.line)
            .line_width(1.0)
            .begin_path()
            .round_rect(lb, px(6.0))
            .stroke()
            .fill_color(pal.ink)
            .font("600 11px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(text, geom.label_pos.x as f32, geom.label_pos.y as f32);
    }

    painter
}

fn vec2_neg(v: crate::engine::whiteboard::model::Vec2) -> crate::engine::whiteboard::model::Vec2 {
    crate::engine::whiteboard::model::Vec2::new(-v.x, -v.y)
}

fn trace_route_shape(mut painter: Painter, shape: &RouteShape) -> Painter {
    match shape {
        RouteShape::Polyline(pts) => {
            if let Some(first) = pts.first() {
                painter = painter.move_to(first.x as f32, first.y as f32);
                for p in &pts[1..] {
                    painter = painter.line_to(p.x as f32, p.y as f32);
                }
            }
        }
        RouteShape::Cubics(segs) => {
            if let Some(first) = segs.first() {
                painter = painter.move_to(first.p0.x as f32, first.p0.y as f32);
                for seg in segs {
                    painter = painter.bezier_curve_to(
                        point(px(seg.c1.x as f32), px(seg.c1.y as f32)),
                        point(px(seg.c2.x as f32), px(seg.c2.y as f32)),
                        point(px(seg.p3.x as f32), px(seg.p3.y as f32)),
                    );
                }
            }
        }
    }
    painter
}

fn paint_head_shape(mut painter: Painter, shape: HeadShape, color: Hsla) -> Painter {
    painter = painter.fill_color(color).begin_path();
    match shape {
        HeadShape::Triangle([a, b, c]) => {
            painter = painter
                .move_to(a.x as f32, a.y as f32)
                .line_to(b.x as f32, b.y as f32)
                .line_to(c.x as f32, c.y as f32)
                .close_path();
        }
        HeadShape::Diamond([a, b, c, d]) => {
            painter = painter
                .move_to(a.x as f32, a.y as f32)
                .line_to(b.x as f32, b.y as f32)
                .line_to(c.x as f32, c.y as f32)
                .line_to(d.x as f32, d.y as f32)
                .close_path();
        }
        HeadShape::Circle { center, radius } => {
            painter = painter.ellipse(
                point(px(center.x as f32), px(center.y as f32)),
                size(px(radius as f32), px(radius as f32)),
                radians(0.0),
                radians(0.0),
                radians(std::f32::consts::TAU),
                false,
            );
        }
    }
    painter.fill()
}

fn paint_timeline(
    mut painter: Painter,
    rect: Rect2,
    points: &[Point2],
    milestones: &[crate::engine::whiteboard::model::TimelineMilestone],
    pal: &WhiteboardPalette,
    hide_text: bool,
) -> Painter {
    let ribbon_pts: Vec<Point2> = if points.len() >= 2 {
        points.to_vec()
    } else {
        vec![
            Point2::new(rect.x, rect.center().y + 10.0),
            Point2::new(rect.center().x, rect.center().y - 4.0),
            Point2::new(rect.right(), rect.center().y - 16.0),
        ]
    };

    let segs: Vec<CubicSegment> = catmull_rom_cubics(&ribbon_pts, 0.55);
    let first_pt = ribbon_pts[0];
    let last_pt = *ribbon_pts.last().unwrap_or(&first_pt);
    let grad = CanvasGradient::linear(
        point(px(first_pt.x as f32), px(first_pt.y as f32)),
        point(px(last_pt.x as f32), px(last_pt.y as f32)),
    )
    .add_color_stop(Percentage(0.0), pal.timeline_start)
    .add_color_stop(Percentage(0.55), pal.timeline_mid)
    .add_color_stop(Percentage(1.0), pal.timeline_end);

    // Subtle halo underneath so grid lines do not distract behind the ribbon.
    painter = painter
        .save()
        .stroke_color(pal.timeline_halo)
        .line_width(16.0)
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);
    painter = trace_route_shape(painter.begin_path(), &RouteShape::Cubics(segs.clone())).stroke().restore();

    // Primary terracotta -> warm amber gradient ribbon.
    painter = painter
        .save()
        .stroke_style(grad)
        .line_width(11.5)
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);
    painter = trace_route_shape(painter.begin_path(), &RouteShape::Cubics(segs)).stroke().restore();

    // Milestone badges drawn strictly on top of ribbon (and arrows).
    let total = milestones.len().max(1);
    for (idx, m) in milestones.iter().enumerate() {
        let pt = m
            .pos
            .unwrap_or_else(|| sample_polyline(&ribbon_pts, m.t.unwrap_or((idx + 1) as f64 / (total + 1) as f64)));

        match m.kind {
            MilestoneKind::Minor => {
                let r = 10.5_f32;
                painter = painter
                    .begin_path()
                    .fill_color(pal.minor_node_bg)
                    .ellipse(
                        point(px(pt.x as f32), px(pt.y as f32)),
                        size(px(r), px(r)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    )
                    .fill()
                    .stroke_color(pal.minor_node_border)
                    .line_width(1.6)
                    .begin_path()
                    .ellipse(
                        point(px(pt.x as f32), px(pt.y as f32)),
                        size(px(r), px(r)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    )
                    .stroke();

                if !hide_text && !m.label.is_empty() {
                    painter = painter
                        .fill_color(pal.muted)
                        .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
                        .text_align(CanvasTextAlign::Center)
                        .text_baseline(CanvasTextBaseline::Middle)
                        .fill_text(&m.label, pt.x as f32, pt.y as f32);
                }
            }
            MilestoneKind::Major => {
                let text_w = measure_text_span(&m.label, 12.0, true);
                let pw = (text_w + 22.0).max(52.0);
                let ph = 26.0;
                let pill = Bounds::new(
                    point(px((pt.x - pw * 0.5) as f32), px((pt.y - ph * 0.5) as f32)),
                    size(px(pw as f32), px(ph as f32)),
                );
                let fill_color = m.tone.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.pill_bg);
                painter = painter
                    .save()
                    .shadow(pal.card_shadow, px(6.0), point(px(0.0), px(2.0)))
                    .begin_path()
                    .fill_color(fill_color)
                    .round_rect(pill, px(13.0))
                    .fill()
                    .restore();

                if !hide_text && !m.label.is_empty() {
                    painter = painter
                        .fill_color(pal.pill_ink)
                        .font("600 12px 'PingFang SC', system-ui, sans-serif")
                        .text_align(CanvasTextAlign::Center)
                        .text_baseline(CanvasTextBaseline::Middle)
                        .fill_text(&m.label, pt.x as f32, pt.y as f32);
                }
            }
        }

        if !hide_text
            && let Some(caption) = &m.caption
            && !caption.trim().is_empty()
        {
            painter = painter
                .fill_color(pal.ink)
                .font("600 12px 'PingFang SC', system-ui, sans-serif")
                .text_align(CanvasTextAlign::Center)
                .text_baseline(CanvasTextBaseline::Top)
                .fill_text(caption, pt.x as f32, (pt.y + 18.0) as f32);
        }
    }

    painter
}

#[allow(clippy::too_many_arguments)]
fn paint_shape(
    mut painter: Painter,
    rect: Rect2,
    shape: ShapeKind,
    title: &str,
    body: &str,
    fill: &WbFill,
    stroke: Option<&str>,
    stroke_style: StrokeStyle,
    corner_radius: Option<f32>,
    sticker: Option<&str>,
    sticker_svg_custom: Option<&str>,
    badge: Option<&str>,
    align: TextAlign,
    pal: &WhiteboardPalette,
    hide_text: bool,
) -> Painter {
    let tone = pal.shape_tone(shape, fill);
    let border = stroke.and_then(parse_hex_hsla).unwrap_or(tone.border);
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let r = corner_radius.unwrap_or(match shape {
        ShapeKind::Card | ShapeKind::Sticky | ShapeKind::Rounded => 10.0,
        ShapeKind::Rect => 2.0,
        ShapeKind::Pill => (rect.h.min(rect.w) * 0.5) as f32,
        _ => 10.0,
    });

    // 1. Fill shape (with soft warm drop shadow on Cards & Stickies).
    let use_shadow = matches!(shape, ShapeKind::Card | ShapeKind::Sticky);
    painter = painter.save().fill_color(tone.fill);
    if use_shadow {
        painter = painter.shadow(pal.card_shadow, px(12.0), point(px(0.0), px(3.0)));
    }
    painter = trace_shape_path(painter.begin_path(), rect, bounds, shape, r).fill().restore();

    // 2. Stroke outline.
    painter = painter.save().stroke_color(border).line_width(1.2);
    match stroke_style {
        StrokeStyle::Solid => {}
        StrokeStyle::Dashed => painter = painter.line_dash(&[px(6.0), px(4.0)]),
        StrokeStyle::Dotted => painter = painter.line_dash(&[px(2.0), px(4.0)]),
    }
    painter = trace_shape_path(painter.begin_path(), rect, bounds, shape, r).stroke().restore();

    // Extra visual detail for Cylinder top ellipse.
    if shape == ShapeKind::Cylinder {
        let rx = (rect.w * 0.5) as f32;
        let ry = (rect.h * 0.16).clamp(8.0, 18.0) as f32;
        let cx = rect.center().x as f32;
        let top_cy = rect.y as f32 + ry;
        painter = painter
            .begin_path()
            .stroke_color(border)
            .line_width(1.25)
            .ellipse(
                point(px(cx), px(top_cy)),
                size(px(rx), px(ry)),
                radians(0.0),
                radians(0.0),
                radians(std::f32::consts::TAU),
                false,
            )
            .stroke();
    }

    // 3. Perched editorial sticker overhanging top edge (matching reference aesthetic).
    let has_sticker = resolve_sticker_svg(sticker, sticker_svg_custom);
    if let Some(svg_src) = has_sticker {
        let sw = 58.0;
        let sh = 58.0;
        let sx = rect.x + (rect.w - sw) * 0.5;
        let sy = rect.y - 24.0;
        painter = paint_embedded_svg(painter, sx, sy, sw, sh, svg_src, tone.ink);
    }

    // 4. Optional top-right badge pill.
    if let Some(b) = badge
        && !b.trim().is_empty()
    {
        let bw = (measure_text_span(b, 9.5, true) + 12.0).max(28.0);
        let bb = Bounds::new(
            point(px((rect.right() - bw - 8.0) as f32), px((rect.y + 8.0) as f32)),
            size(px(bw as f32), px(18.0)),
        );
        painter = painter
            .begin_path()
            .fill_color(pal.pill_bg)
            .round_rect(bb, px(9.0))
            .fill()
            .fill_color(pal.pill_ink)
            .font("600 9.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(b, (rect.right() - bw * 0.5 - 8.0) as f32, (rect.y + 17.0) as f32);
    }

    // 5. Card / Shape typography.
    if !hide_text && (!title.trim().is_empty() || !body.trim().is_empty()) {
        let layout = layout_card(rect, title, body, has_sticker.is_some());
        let (text_x, canvas_align) = match align {
            TextAlign::Left => ((rect.x + 12.0) as f32, CanvasTextAlign::Left),
            TextAlign::Center => (rect.center().x as f32, CanvasTextAlign::Center),
            TextAlign::Right => ((rect.right() - 12.0) as f32, CanvasTextAlign::Right),
        };
        let compact = rect.h <= 44.0;
        let title_font = if compact {
            "400 12.5px 'PingFang SC', system-ui, sans-serif"
        } else if body.trim().is_empty() {
            "500 13px 'PingFang SC', system-ui, sans-serif"
        } else {
            "600 13px 'PingFang SC', system-ui, sans-serif"
        };
        painter = painter
            .fill_color(tone.ink)
            .font(title_font)
            .text_align(canvas_align)
            .text_baseline(CanvasTextBaseline::Top);
        for (i, line) in layout.title_lines.iter().enumerate() {
            let y = (layout.title_y + i as f64 * layout.line_height_title) as f32;
            painter = painter.fill_text(line, text_x, y);
        }

        let body_color = Hsla { a: 0.84, ..tone.ink };
        painter = painter.fill_color(body_color).font("400 11.5px 'PingFang SC', system-ui, sans-serif");
        for (i, line) in layout.body_lines.iter().enumerate() {
            let y = (layout.body_y + i as f64 * layout.line_height_body) as f32;
            painter = painter.fill_text(line, text_x, y);
        }
    }

    painter
}

fn trace_shape_path(mut painter: Painter, rect: Rect2, bounds: Bounds<nsh_core::prelude::Points>, shape: ShapeKind, r: f32) -> Painter {
    match shape {
        ShapeKind::Card | ShapeKind::Sticky | ShapeKind::Rect | ShapeKind::Rounded | ShapeKind::Pill => {
            painter = painter.round_rect(bounds, px(r));
        }
        ShapeKind::Ellipse => {
            let c = rect.center();
            painter = painter.ellipse(
                point(px(c.x as f32), px(c.y as f32)),
                size(px((rect.w * 0.5) as f32), px((rect.h * 0.5) as f32)),
                radians(0.0),
                radians(0.0),
                radians(std::f32::consts::TAU),
                false,
            );
        }
        ShapeKind::Diamond => {
            let c = rect.center();
            painter = painter
                .move_to(c.x as f32, rect.y as f32)
                .line_to(rect.right() as f32, c.y as f32)
                .line_to(c.x as f32, rect.bottom() as f32)
                .line_to(rect.x as f32, c.y as f32)
                .close_path();
        }
        ShapeKind::Triangle => {
            let c = rect.center();
            painter = painter
                .move_to(c.x as f32, rect.y as f32)
                .line_to(rect.right() as f32, rect.bottom() as f32)
                .line_to(rect.x as f32, rect.bottom() as f32)
                .close_path();
        }
        ShapeKind::Cylinder => {
            let ry = (rect.h * 0.16).clamp(8.0, 18.0);
            let x0 = rect.x as f32;
            let x1 = rect.right() as f32;
            let y0 = (rect.y + ry) as f32;
            let y1 = (rect.bottom() - ry) as f32;
            let cx = rect.center().x as f32;
            painter = painter
                .move_to(x0, y0)
                .bezier_curve_to(point(px(x0), px(rect.y as f32)), point(px(x1), px(rect.y as f32)), point(px(x1), px(y0)))
                .line_to(x1, y1)
                .bezier_curve_to(
                    point(px(x1), px(rect.bottom() as f32)),
                    point(px(x0), px(rect.bottom() as f32)),
                    point(px(x0), px(y1)),
                )
                .close_path();
            let _ = cx;
        }
    }
    painter
}

#[allow(clippy::too_many_arguments)]
fn paint_text(
    mut painter: Painter,
    rect: Rect2,
    variant: TextVariant,
    label: &str,
    highlight: Option<&str>,
    _icon: Option<&str>,
    align: TextAlign,
    font_size: Option<f32>,
    fill: Option<&WbFill>,
    color: Option<&str>,
    pal: &WhiteboardPalette,
) -> Painter {
    if let Some(bg_fill) = fill {
        let tone = pal.tone(bg_fill);
        let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
        painter = painter
            .begin_path()
            .fill_color(tone.fill)
            .round_rect(b, px(8.0))
            .fill()
            .stroke_color(tone.border)
            .line_width(1.0)
            .begin_path()
            .round_rect(b, px(8.0))
            .stroke();
    }

    let ink = color.and_then(parse_hex_hsla).unwrap_or(match variant {
        TextVariant::Subtitle => pal.muted,
        _ => pal.ink,
    });

    match variant {
        TextVariant::Title => {
            let fs = font_size.unwrap_or(30.0);
            let font_str = format!("400 {fs}px Georgia, Songti SC, STSong, Times New Roman, serif");
            let x = match align {
                TextAlign::Left => rect.x as f32,
                TextAlign::Center => rect.center().x as f32,
                TextAlign::Right => rect.right() as f32,
            };
            let ta = match align {
                TextAlign::Left => CanvasTextAlign::Left,
                TextAlign::Center => CanvasTextAlign::Center,
                TextAlign::Right => CanvasTextAlign::Right,
            };
            painter
                .fill_color(ink)
                .font(&font_str)
                .text_align(ta)
                .text_baseline(CanvasTextBaseline::Top)
                .fill_text(label, x, (rect.y + 4.0) as f32)
        }
        TextVariant::Subtitle => {
            let fs = font_size.unwrap_or(13.5);
            let font_str = format!("400 {fs}px 'PingFang SC', system-ui, sans-serif");
            if let Some(hl) = highlight
                && let Some(span) = locate_highlight_span(label, hl, f64::from(fs), rect.w, align)
            {
                let pill_x = (rect.x + span.box_offset_x) as f32;
                let pill_y = rect.y as f32;
                let pill_b = Bounds::new(point(px(pill_x), px(pill_y)), size(px(span.box_width as f32), px(21.0)));
                painter = painter.begin_path().fill_color(pal.highlight_bg).round_rect(pill_b, px(4.0)).fill();

                let before_x = match align {
                    TextAlign::Left => rect.x as f32,
                    TextAlign::Center => (rect.x + span.box_offset_x + 5.0 - measure_text_span(&span.before, f64::from(fs), false)) as f32,
                    TextAlign::Right => (rect.x + span.box_offset_x + 5.0 - measure_text_span(&span.before, f64::from(fs), false)) as f32,
                };
                let text_y = (rect.y + 3.0) as f32;
                if !span.before.is_empty() {
                    painter = painter
                        .fill_color(ink)
                        .font(&font_str)
                        .text_align(CanvasTextAlign::Left)
                        .text_baseline(CanvasTextBaseline::Top)
                        .fill_text(&span.before, before_x, text_y);
                }
                painter = painter
                    .fill_color(pal.highlight_ink)
                    .font(&format!("500 {fs}px 'PingFang SC', system-ui, sans-serif"))
                    .text_align(CanvasTextAlign::Left)
                    .text_baseline(CanvasTextBaseline::Top)
                    .fill_text(&span.highlighted, pill_x + 5.0, text_y);
                if !span.after.is_empty() {
                    painter = painter
                        .fill_color(ink)
                        .font(&font_str)
                        .text_align(CanvasTextAlign::Left)
                        .text_baseline(CanvasTextBaseline::Top)
                        .fill_text(&span.after, pill_x + span.box_width as f32 - 5.0, text_y);
                }
                painter
            } else {
                painter
                    .fill_color(ink)
                    .font(&font_str)
                    .text_align(CanvasTextAlign::Left)
                    .text_baseline(CanvasTextBaseline::Top)
                    .fill_text(label, rect.x as f32, (rect.y + 3.0) as f32)
            }
        }
        TextVariant::Callout => {
            // Crisp warning triangle badge + wrapped two-line text beside it.
            let ix = (rect.x + 12.0) as f32;
            let iy = (rect.y + 15.0) as f32;
            painter = painter
                .begin_path()
                .fill_color(rgb(0xffe380).to_hsla())
                .move_to(ix, iy - 9.0)
                .line_to(ix + 9.0, iy + 7.0)
                .line_to(ix - 9.0, iy + 7.0)
                .close_path()
                .fill()
                .stroke_color(pal.ink)
                .line_width(1.5)
                .begin_path()
                .move_to(ix, iy - 9.0)
                .line_to(ix + 9.0, iy + 7.0)
                .line_to(ix - 9.0, iy + 7.0)
                .close_path()
                .stroke()
                .fill_color(rgb(0x1c1917).to_hsla())
                .font("700 10px 'PingFang SC', system-ui, sans-serif")
                .text_align(CanvasTextAlign::Center)
                .text_baseline(CanvasTextBaseline::Middle)
                .fill_text("!", ix, iy + 1.5);

            let lines = wrap_text(label, (rect.w - 34.0).max(60.0), 12.0, false, 3);
            painter = painter
                .fill_color(pal.ink)
                .font("500 12px 'PingFang SC', system-ui, sans-serif")
                .text_align(CanvasTextAlign::Left)
                .text_baseline(CanvasTextBaseline::Top);
            for (i, line) in lines.iter().enumerate() {
                painter = painter.fill_text(line, (rect.x + 28.0) as f32, (rect.y + 6.0 + i as f64 * 16.0) as f32);
            }
            painter
        }
        TextVariant::Body => {
            let fs = font_size.unwrap_or(13.0);
            let lines = wrap_text(label, (rect.w - 16.0).max(48.0), f64::from(fs), false, 6);
            let font_str = format!("400 {fs}px 'PingFang SC', system-ui, sans-serif");
            let (tx, ca) = match align {
                TextAlign::Left => ((rect.x + 8.0) as f32, CanvasTextAlign::Left),
                TextAlign::Center => (rect.center().x as f32, CanvasTextAlign::Center),
                TextAlign::Right => ((rect.right() - 8.0) as f32, CanvasTextAlign::Right),
            };
            painter = painter.fill_color(ink).font(&font_str).text_align(ca).text_baseline(CanvasTextBaseline::Top);
            for (i, line) in lines.iter().enumerate() {
                painter = painter.fill_text(line, tx, (rect.y + 6.0 + i as f64 * (f64::from(fs) + 5.0)) as f32);
            }
            painter
        }
    }
}

fn paint_table(mut painter: Painter, rect: Rect2, headers: &[String], rows: &[Vec<String>], fill: &WbFill, pal: &WhiteboardPalette) -> Painter {
    let tone = pal.tone(fill);
    let layout = layout_table(rect, headers, rows);
    let table_bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));

    painter = painter
        .save()
        .shadow(pal.card_shadow, px(8.0), point(px(0.0), px(2.0)))
        .begin_path()
        .fill_color(tone.fill)
        .round_rect(table_bounds, px(8.0))
        .fill()
        .restore();

    if layout.header_height > 0.0 {
        let hb = Bounds::new(
            point(px(rect.x as f32), px(rect.y as f32)),
            size(px(rect.w as f32), px(layout.header_height as f32)),
        );
        painter = painter.begin_path().fill_color(pal.table_header_bg).round_rect(hb, px(8.0)).fill();
    }

    painter = painter
        .begin_path()
        .stroke_color(tone.border)
        .line_width(1.2)
        .round_rect(table_bounds, px(8.0))
        .stroke();

    // Grid dividers.
    for c in 1..layout.col_count {
        let cx = (rect.x + c as f64 * layout.col_width) as f32;
        painter = painter
            .begin_path()
            .stroke_color(pal.line)
            .line_width(1.0)
            .move_to(cx, rect.y as f32)
            .line_to(cx, rect.bottom() as f32)
            .stroke();
    }
    if layout.header_height > 0.0 {
        let hy = (rect.y + layout.header_height) as f32;
        painter = painter
            .begin_path()
            .stroke_color(tone.border)
            .line_width(1.1)
            .move_to(rect.x as f32, hy)
            .line_to(rect.right() as f32, hy)
            .stroke();
    }
    for r_idx in 1..rows.len() {
        let ry = (rect.y + layout.header_height + r_idx as f64 * layout.row_height) as f32;
        if ry < rect.bottom() as f32 {
            painter = painter
                .begin_path()
                .stroke_color(pal.line)
                .line_width(1.0)
                .move_to(rect.x as f32, ry)
                .line_to(rect.right() as f32, ry)
                .stroke();
        }
    }

    // Header text.
    if layout.header_height > 0.0 {
        painter = painter
            .fill_color(pal.ink)
            .font("600 12px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Left)
            .text_baseline(CanvasTextBaseline::Middle);
        for (c, h) in headers.iter().take(layout.col_count).enumerate() {
            let x = (rect.x + c as f64 * layout.col_width + 10.0) as f32;
            let y = (rect.y + layout.header_height * 0.5) as f32;
            painter = painter.fill_text(h, x, y);
        }
    }

    // Row cell text.
    painter = painter
        .fill_color(pal.muted)
        .font("400 11.5px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Left)
        .text_baseline(CanvasTextBaseline::Middle);
    for (r_idx, row) in rows.iter().enumerate() {
        let cy = rect.y + layout.header_height + (r_idx as f64 + 0.5) * layout.row_height;
        if cy > rect.bottom() - 4.0 {
            break;
        }
        for (c, cell) in row.iter().take(layout.col_count).enumerate() {
            let cx = (rect.x + c as f64 * layout.col_width + 10.0) as f32;
            painter = painter.fill_text(cell, cx, cy as f32);
        }
    }

    painter
}

fn paint_image_card(mut painter: Painter, rect: Rect2, alt: Option<&str>, uri: &str, pal: &WhiteboardPalette) -> Painter {
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    painter = painter
        .begin_path()
        .fill_color(pal.tone_side.fill)
        .round_rect(bounds, px(10.0))
        .fill()
        .stroke_color(pal.tone_side.border)
        .line_width(1.25)
        .begin_path()
        .round_rect(bounds, px(10.0))
        .stroke();

    // Landscape mountain glyph in center when bitmap is async/external.
    let cx = rect.center().x as f32;
    let cy = (rect.center().y - 6.0) as f32;
    painter = painter
        .begin_path()
        .fill_color(pal.faint)
        .move_to(cx - 22.0, cy + 14.0)
        .line_to(cx - 7.0, cy - 6.0)
        .line_to(cx + 6.0, cy + 8.0)
        .line_to(cx + 14.0, cy - 1.0)
        .line_to(cx + 24.0, cy + 14.0)
        .close_path()
        .fill();

    let caption = alt.filter(|s| !s.is_empty()).unwrap_or(uri);
    if !caption.is_empty() {
        painter = painter
            .fill_color(pal.muted)
            .font("500 11px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Bottom)
            .fill_text(caption, rect.center().x as f32, (rect.bottom() - 8.0) as f32);
    }
    painter
}

fn paint_html_card(mut painter: Painter, rect: Rect2, title: Option<&str>, pal: &WhiteboardPalette) -> Painter {
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    painter = painter
        .begin_path()
        .fill_color(pal.tone_default.fill)
        .round_rect(bounds, px(10.0))
        .fill()
        .stroke_color(pal.tone_default.border)
        .line_width(1.25)
        .begin_path()
        .round_rect(bounds, px(10.0))
        .stroke();

    let bar = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(26.0)));
    painter = painter
        .begin_path()
        .fill_color(pal.container_header_bg)
        .round_rect(bar, px(10.0))
        .fill()
        .fill_color(pal.ink)
        .font("600 11px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Left)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(title.unwrap_or("Embed"), (rect.x + 10.0) as f32, (rect.y + 13.0) as f32);
    painter
}

fn paint_embedded_svg(mut painter: Painter, x: f64, y: f64, w: f64, h: f64, svg_src: &str, ink: Hsla) -> Painter {
    let Some(drawing) = cached_svg_drawing(svg_src) else {
        return painter;
    };
    let resolved = drawing.painted(
        &PaintStyle::default(),
        Color::from(ink),
        Color::TRANSPARENT,
        &[],
        size(px(w as f32), px(h as f32)),
    );
    painter = painter.save().translate(x as f32, y as f32);
    for op in resolved.ops {
        painter = painter.op(op);
    }
    painter.restore()
}

fn paint_ink_stroke(
    mut painter: Painter,
    points: &[crate::engine::whiteboard::model::StrokePoint],
    stroke: &str,
    stroke_width: f32,
    mode: InkMode,
    pal: &WhiteboardPalette,
) -> Painter {
    let contour = build_ink_outline(points, stroke_width, mode);
    let Some(first) = contour.first() else {
        return painter;
    };
    let color = parse_hex_hsla(stroke).unwrap_or(pal.ink);
    let alpha = if mode == InkMode::Highlighter { 0.34 } else { 0.95 };

    painter = painter
        .save()
        .global_alpha(alpha)
        .fill_color(color)
        .begin_path()
        .move_to(first.x as f32, first.y as f32);
    for pt in &contour[1..] {
        painter = painter.line_to(pt.x as f32, pt.y as f32);
    }
    painter.close_path().fill().restore()
}

pub fn paint_overlay_layer(controller: &WhiteboardController, viewport_size: (f32, f32), dark: bool) -> Drawing {
    paint_overlay_layer_painter(controller, viewport_size, dark).finish()
}

pub fn paint_overlay_layer_painter(controller: &WhiteboardController, viewport_size: (f32, f32), dark: bool) -> Painter {
    paint_overlay_layer_painter_filtered(controller, viewport_size, dark, &BTreeSet::new())
}

pub fn paint_overlay_layer_painter_filtered(
    controller: &WhiteboardController,
    viewport_size: (f32, f32),
    dark: bool,
    dismissed_notes: &BTreeSet<String>,
) -> Painter {
    let pal = WhiteboardPalette::for_mode(dark);
    let mut painter = Painter::new();
    let zoom = controller.camera.zoom;

    // 1. Live world-space interactive overlays & previews.
    painter = painter
        .save()
        .translate(controller.camera.pan_x as f32, controller.camera.pan_y as f32)
        .scale(zoom as f32, zoom as f32);

    // Remote collaborator viewport outlines, highlight/claim boxes, and element claim outlines.
    for p in &controller.doc.presences {
        let p_color = pal.resolve_presence_color(p);
        let pose = controller.displayed_pose(p);
        let is_followed = controller.follow_actor.as_deref() == Some(p.id.as_str());

        if let Some(vp) = pose.viewport
            && let Some(r) = vp.rect()
        {
            painter = paint_presence_viewport(painter, r, p, p_color, zoom as f32, is_followed, &pal);
        }

        if let Some(r) = pose.region_rect(p.kind) {
            painter = paint_presence_region(painter, r, p, p_color, zoom as f32, &pal);
        }

        for sel_id in &p.selected_ids {
            if let Some(r) = controller.lookup.get(sel_id) {
                let b = Bounds::new(point(px(r.x as f32), px(r.y as f32)), size(px(r.w as f32), px(r.h as f32)));
                painter = painter
                    .save()
                    .stroke_color(p_color)
                    .line_width(2.0 / zoom as f32)
                    .line_dash(&[px(4.0 / zoom as f32), px(3.0 / zoom as f32)])
                    .begin_path()
                    .round_rect(b, px(10.0))
                    .stroke()
                    .restore();
            }
        }
    }

    // Active drag / create / draw previews.
    match &controller.mode {
        InteractionMode::DrawingBox { start_world, cur_world } => {
            let r = Rect2::from_corners(*start_world, *cur_world);
            let b = Bounds::new(point(px(r.x as f32), px(r.y as f32)), size(px(r.w as f32), px(r.h as f32)));
            painter = painter
                .begin_path()
                .fill_color(pal.selection_soft)
                .round_rect(b, px(8.0))
                .fill()
                .stroke_color(pal.selection)
                .line_width(1.6 / zoom as f32)
                .begin_path()
                .round_rect(b, px(8.0))
                .stroke();
        }
        InteractionMode::DrawingInk { points, mode } => {
            let width = if *mode == InkMode::Highlighter {
                (controller.active_stroke_width * 4.5).max(14.0)
            } else {
                controller.active_stroke_width
            };
            let stroke = if *mode == InkMode::Highlighter {
                "#e5a93c"
            } else {
                controller.active_ink_color.as_str()
            };
            painter = paint_ink_stroke(painter, points, stroke, width, *mode, &pal);
        }
        InteractionMode::ConnectingArrow { from, cur_world, snap_target } => {
            if let Some(start) = live_anchor_point(from, &controller.lookup) {
                let end = snap_target.as_ref().map_or(*cur_world, |(_, _, p)| *p);
                painter = painter
                    .save()
                    .stroke_color(pal.selection)
                    .line_width(2.0 / zoom as f32)
                    .line_dash(&[px(5.0 / zoom as f32), px(4.0 / zoom as f32)])
                    .begin_path()
                    .move_to(start.x as f32, start.y as f32)
                    .line_to(end.x as f32, end.y as f32)
                    .stroke()
                    .restore();
            }
            if let Some((_, _, snap_pt)) = snap_target {
                let pr = (7.0 / zoom) as f32;
                painter = painter
                    .begin_path()
                    .fill_color(pal.selection)
                    .ellipse(
                        point(px(snap_pt.x as f32), px(snap_pt.y as f32)),
                        size(px(pr), px(pr)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    )
                    .fill();
            }
        }
        InteractionMode::Marquee { start_world, cur_world } => {
            let r = Rect2::from_corners(*start_world, *cur_world);
            let intersect_mode = cur_world.x < start_world.x;
            let b = Bounds::new(point(px(r.x as f32), px(r.y as f32)), size(px(r.w as f32), px(r.h as f32)));
            painter = painter
                .save()
                .begin_path()
                .fill_color(pal.selection_soft)
                .rect(b)
                .fill()
                .stroke_color(pal.selection)
                .line_width(1.3 / zoom as f32);
            if intersect_mode {
                painter = painter.line_dash(&[px(5.0 / zoom as f32), px(4.0 / zoom as f32)]);
            }
            painter = painter.begin_path().rect(b).stroke().restore();
        }
        InteractionMode::Erasing { points, .. } => {
            if let Some(last) = points.last() {
                let r = (14.0 / zoom) as f32;
                painter = painter
                    .begin_path()
                    .stroke_color(pal.snap_guide)
                    .line_width(1.5 / zoom as f32)
                    .ellipse(
                        point(px(last.x as f32), px(last.y as f32)),
                        size(px(r), px(r)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    )
                    .stroke();
            }
        }
        InteractionMode::Idle
        | InteractionMode::Panning { .. }
        | InteractionMode::Dragging { .. }
        | InteractionMode::Resizing { .. }
        | InteractionMode::Rotating { .. }
        | InteractionMode::DraggingArrowEndpoint { .. }
        | InteractionMode::DraggingTimelineControl { .. }
        | InteractionMode::DraggingTimelineMilestone { .. } => {}
    }

    // Hovered / Selected N/E/S/W anchor connection ports.
    for cand_id in controller.selection.iter().chain(controller.hovered.as_ref()) {
        let Some(el) = controller.doc.element(cand_id) else {
            continue;
        };
        if !can_host_anchor_port(&el.kind) {
            continue;
        }
        let Some(&rect) = controller.lookup.get(&el.id) else {
            continue;
        };
        let port_offset = 14.0 / zoom;
        let port_r = (4.2 / zoom) as f32;
        for side in crate::engine::whiteboard::model::AnchorSide::ALL {
            let p = crate::engine::whiteboard::geometry::rotate_point(anchor_port_pos(rect, side, port_offset), rect.center(), el.rotation_deg);
            painter = painter
                .begin_path()
                .fill_color(pal.page)
                .ellipse(
                    point(px(p.x as f32), px(p.y as f32)),
                    size(px(port_r), px(port_r)),
                    radians(0.0),
                    radians(0.0),
                    radians(std::f32::consts::TAU),
                    false,
                )
                .fill()
                .stroke_color(pal.selection)
                .line_width(1.4 / zoom as f32)
                .begin_path()
                .ellipse(
                    point(px(p.x as f32), px(p.y as f32)),
                    size(px(port_r), px(port_r)),
                    radians(0.0),
                    radians(0.0),
                    radians(std::f32::consts::TAU),
                    false,
                )
                .stroke();
        }
    }

    // Selection frame + 8 resize handles + top rotation handle.
    if controller.selection.len() == 1
        && let Some(id) = controller.selection.first()
        && let Some(el) = controller.doc.element(id)
    {
        if let ElementKind::Arrow { from, to, bends, curve, .. } = &el.kind {
            if let Some(geom) = route_arrow(from, to, bends, *curve, &controller.lookup) {
                let hr = (5.0 / zoom) as f32;
                for pt in [geom.start, geom.end].into_iter().chain(bends.iter().copied()) {
                    painter = painter
                        .begin_path()
                        .fill_color(pal.page)
                        .ellipse(
                            point(px(pt.x as f32), px(pt.y as f32)),
                            size(px(hr), px(hr)),
                            radians(0.0),
                            radians(0.0),
                            radians(std::f32::consts::TAU),
                            false,
                        )
                        .fill()
                        .stroke_color(pal.selection)
                        .line_width(1.6 / zoom as f32)
                        .begin_path()
                        .ellipse(
                            point(px(pt.x as f32), px(pt.y as f32)),
                            size(px(hr), px(hr)),
                            radians(0.0),
                            radians(0.0),
                            radians(std::f32::consts::TAU),
                            false,
                        )
                        .stroke();
                }
            }
        } else if let Some(&rect) = controller.lookup.get(id) {
            let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
            painter = painter
                .save()
                .translate(rect.center().x as f32, rect.center().y as f32)
                .rotate(radians(el.rotation_deg.to_radians() as f32))
                .translate(-rect.center().x as f32, -rect.center().y as f32)
                .stroke_color(pal.selection)
                .line_width(1.5 / zoom as f32)
                .begin_path()
                .rect(b)
                .stroke();

            let hs = (7.0 / zoom) as f32;
            for h in ResizeHandle8::ALL {
                let hp = h.position_on(rect);
                let hb = Bounds::new(point(px(hp.x as f32 - hs * 0.5), px(hp.y as f32 - hs * 0.5)), size(px(hs), px(hs)));
                painter = painter
                    .begin_path()
                    .fill_color(pal.page)
                    .rect(hb)
                    .fill()
                    .stroke_color(pal.selection)
                    .line_width(1.4 / zoom as f32)
                    .begin_path()
                    .rect(hb)
                    .stroke();
            }

            let top_mid = Point2::new(rect.x + rect.w * 0.5, rect.y);
            let rot_pt = rotate_handle_pos(rect, 0.0, 26.0 / zoom);
            let rr = (4.5 / zoom) as f32;
            painter = painter
                .begin_path()
                .stroke_color(pal.selection)
                .line_width(1.3 / zoom as f32)
                .move_to(top_mid.x as f32, top_mid.y as f32)
                .line_to(rot_pt.x as f32, rot_pt.y as f32)
                .stroke()
                .begin_path()
                .fill_color(pal.page)
                .ellipse(
                    point(px(rot_pt.x as f32), px(rot_pt.y as f32)),
                    size(px(rr), px(rr)),
                    radians(0.0),
                    radians(0.0),
                    radians(std::f32::consts::TAU),
                    false,
                )
                .fill()
                .begin_path()
                .ellipse(
                    point(px(rot_pt.x as f32), px(rot_pt.y as f32)),
                    size(px(rr), px(rr)),
                    radians(0.0),
                    radians(0.0),
                    radians(std::f32::consts::TAU),
                    false,
                )
                .stroke()
                .restore();
        }
    } else if controller.selection.len() > 1
        && let Some(group_rect) = controller.selection_bbox(&controller.selection)
    {
        let gb = Bounds::new(
            point(px(group_rect.x as f32), px(group_rect.y as f32)),
            size(px(group_rect.w as f32), px(group_rect.h as f32)),
        );
        painter = painter.stroke_color(pal.selection).line_width(1.5 / zoom as f32).begin_path().rect(gb).stroke();
    }

    // Active snap alignment & equal-spacing guides.
    for guide in &controller.active_guides {
        match guide {
            SnapGuide::Align {
                axis,
                coord,
                span_min,
                span_max,
            } => {
                painter = painter.stroke_color(pal.snap_guide).line_width(1.2 / zoom as f32).begin_path();
                match axis {
                    SnapAxis::X => {
                        painter = painter.move_to(*coord as f32, *span_min as f32).line_to(*coord as f32, *span_max as f32);
                    }
                    SnapAxis::Y => {
                        painter = painter.move_to(*span_min as f32, *coord as f32).line_to(*span_max as f32, *coord as f32);
                    }
                }
                painter = painter.stroke();
            }
            SnapGuide::Spacing {
                axis,
                cross_coord,
                start,
                end,
                gap,
            } => {
                painter = painter.stroke_color(pal.snap_guide).line_width(1.3 / zoom as f32).begin_path();
                let (lx, ly) = match axis {
                    SnapAxis::X => {
                        painter = painter.move_to(*start as f32, *cross_coord as f32).line_to(*end as f32, *cross_coord as f32);
                        ((start + end) * 0.5, *cross_coord)
                    }
                    SnapAxis::Y => {
                        painter = painter.move_to(*cross_coord as f32, *start as f32).line_to(*cross_coord as f32, *end as f32);
                        (*cross_coord, (start + end) * 0.5)
                    }
                };
                painter = painter.stroke();
                let txt = format!("{:.0}", gap);
                painter = painter
                    .fill_color(pal.snap_guide)
                    .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
                    .text_align(CanvasTextAlign::Center)
                    .text_baseline(CanvasTextBaseline::Bottom)
                    .fill_text(&txt, lx as f32, (ly - 3.0) as f32);
            }
        }
    }

    // Collaborator cursors (using smoothly interpolated poses).
    painter = paint_presences_for_controller(painter, controller, &pal, zoom as f32, dismissed_notes);

    painter = painter.restore();

    let _ = container_header_rect;
    let _ = Size::<nsh_core::prelude::Points>::default();
    let _ = anchor_point;
    let _ = viewport_size;
    painter
}

fn paint_presence_viewport(mut painter: Painter, rect: Rect2, p: &Presence, color: Hsla, zoom: f32, is_followed: bool, pal: &WhiteboardPalette) -> Painter {
    let inv = 1.0 / zoom.max(0.25);
    let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let fill_alpha = if is_followed { 0.045 } else { 0.018 };
    let stroke_alpha = if is_followed { 0.56 } else { 0.28 };
    let stroke_w = (if is_followed { 1.8 } else { 1.25 }) * inv;
    let radius = 8.0 * inv;
    painter = painter
        .save()
        .begin_path()
        .fill_color(Hsla { a: fill_alpha, ..color })
        .round_rect(b, px(radius))
        .fill()
        .stroke_color(Hsla { a: stroke_alpha, ..color })
        .line_width(stroke_w)
        .line_dash(&[px(8.0 * inv), px(6.0 * inv)])
        .begin_path()
        .round_rect(b, px(radius))
        .stroke()
        .restore();

    let tag_text = match (p.kind == PresenceKind::Viewport, p.status.as_deref().map(str::trim).filter(|s| !s.is_empty())) {
        (true, Some(st)) => format!("{} · {st}", p.name),
        _ => p.name.clone(),
    };
    let pill_w = (measure_text_span(&tag_text, 10.5, true) + 14.0).max(36.0) as f32;
    let pill_h = 18.0_f32;
    let chip = Bounds::new(point(px(6.0), px(-pill_h - 4.0)), size(px(pill_w), px(pill_h)));
    painter
        .save()
        .translate(rect.x as f32, rect.y as f32)
        .scale(inv, inv)
        .global_alpha(if is_followed { 0.92 } else { 0.68 })
        .begin_path()
        .fill_color(color)
        .round_rect(chip, px(9.0))
        .fill()
        .fill_color(pal.pill_ink)
        .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Center)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&tag_text, 6.0 + pill_w * 0.5, -pill_h * 0.5 - 4.0)
        .restore()
}

fn paint_presence_region(mut painter: Painter, rect: Rect2, p: &Presence, color: Hsla, zoom: f32, pal: &WhiteboardPalette) -> Painter {
    let inv = 1.0 / zoom.max(0.25);
    let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let tint = Hsla { a: 0.09, ..color };
    painter = painter
        .save()
        .begin_path()
        .fill_color(tint)
        .round_rect(b, px(12.0))
        .fill()
        .stroke_color(color)
        .line_width(1.8 * inv)
        .line_dash(&[px(6.0 * inv), px(4.0 * inv)])
        .begin_path()
        .round_rect(b, px(12.0))
        .stroke()
        .restore();

    let status_opt = p.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let badge = match status_opt {
        Some(st) => format!("{} · {st}", p.name),
        None => p.name.clone(),
    };
    let bw = (measure_text_span(&badge, 11.0, true) + 18.0).max(48.0) as f32;
    let bh = 22.0_f32;
    let chip = Bounds::new(point(px(10.0), px(-bh * 0.5)), size(px(bw), px(bh)));
    painter
        .save()
        .translate(rect.x as f32, rect.y as f32)
        .scale(inv, inv)
        .shadow(pal.card_shadow, px(4.0), point(px(0.0), px(1.5)))
        .begin_path()
        .fill_color(color)
        .round_rect(chip, px(11.0))
        .fill()
        .fill_color(pal.pill_ink)
        .font("600 11px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Center)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&badge, 10.0 + bw * 0.5, 0.0)
        .restore()
}

fn paint_presences_for_controller(
    mut painter: Painter,
    controller: &WhiteboardController,
    pal: &WhiteboardPalette,
    zoom: f32,
    dismissed_notes: &BTreeSet<String>,
) -> Painter {
    for p in &controller.doc.presences {
        let pose = controller.displayed_pose(p);
        painter = paint_presence_cursor(painter, p, pose, pal, zoom, dismissed_notes);
    }
    painter
}

pub fn paint_presences_into_painter(mut painter: Painter, doc: &BoardDoc, pal: &WhiteboardPalette, zoom: f32, dismissed_notes: &BTreeSet<String>) -> Painter {
    for p in &doc.presences {
        let color = pal.resolve_presence_color(p);
        let pose = AnimatedPresencePose::from_presence(p);
        if let Some(vp) = pose.viewport
            && let Some(r) = vp.rect()
        {
            painter = paint_presence_viewport(painter, r, p, color, zoom, false, pal);
        }
        if let Some(r) = pose.region_rect(p.kind) {
            painter = paint_presence_region(painter, r, p, color, zoom, pal);
        }
        painter = paint_presence_cursor(painter, p, pose, pal, zoom, dismissed_notes);
    }
    painter
}

fn paint_presence_cursor(
    mut painter: Painter,
    p: &Presence,
    pose: AnimatedPresencePose,
    pal: &WhiteboardPalette,
    zoom: f32,
    dismissed_notes: &BTreeSet<String>,
) -> Painter {
    // Viewport-only presences or highlight/claim regions with an explicit box already render their own badge.
    if !p.has_cursor || (matches!(p.kind, PresenceKind::Highlight | PresenceKind::Claim) && pose.region_rect(p.kind).is_some()) {
        return painter;
    }

    let inv_scale = 1.0 / zoom.max(0.25);
    let color = pal.resolve_presence_color(p);
    let px_x = pose.x as f32;
    let px_y = pose.y as f32;
    let s = inv_scale;

    // Crisp vector cursor pointer.
    painter = painter
        .save()
        .translate(px_x, px_y)
        .scale(s, s)
        .begin_path()
        .fill_color(color)
        .move_to(0.0, 0.0)
        .line_to(11.0, 5.5)
        .line_to(6.0, 7.2)
        .line_to(4.2, 12.2)
        .close_path()
        .fill()
        .stroke_color(pal.page)
        .line_width(1.2)
        .begin_path()
        .move_to(0.0, 0.0)
        .line_to(11.0, 5.5)
        .line_to(6.0, 7.2)
        .line_to(4.2, 12.2)
        .close_path()
        .stroke();

    let status_opt = (!dismissed_notes.contains(&p.id))
        .then_some(p.status.as_deref())
        .flatten()
        .map(str::trim)
        .filter(|t| !t.is_empty());

    if let Some(msg) = status_opt
        && msg.chars().count() > 14
    {
        // Full conversational proposal speech bubble with inline dismiss × mark.
        let pill_w = (measure_text_span(msg, 12.5, false) + 52.0).clamp(160.0, 580.0) as f32;
        let pill_h = 32.0_f32;
        let pb = Bounds::new(point(px(10.0), px(10.0)), size(px(pill_w), px(pill_h)));
        let close_cx = 10.0 + pill_w - 17.0;
        let close_cy = 10.0 + pill_h * 0.5;
        painter = painter
            .save()
            .shadow(pal.card_shadow, px(7.0), point(px(0.0), px(2.0)))
            .begin_path()
            .fill_color(color)
            .round_rect(pb, px(10.0))
            .fill()
            .restore()
            .fill_color(pal.pill_ink)
            .font("500 12.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Left)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(msg, 24.0, close_cy)
            .stroke_color(Hsla { a: 0.85, ..pal.pill_ink })
            .line_width(1.4)
            .begin_path()
            .move_to(close_cx - 3.5, close_cy - 3.5)
            .line_to(close_cx + 3.5, close_cy + 3.5)
            .move_to(close_cx + 3.5, close_cy - 3.5)
            .line_to(close_cx - 3.5, close_cy + 3.5)
            .stroke()
            .restore();
    } else {
        let label = match status_opt {
            Some(st) => format!("{} · {st}", p.name),
            None => p.name.clone(),
        };
        let pill_w = (measure_text_span(&label, 11.5, true) + 18.0).max(40.0) as f32;
        let pill_h = 22.0_f32;
        let pb = Bounds::new(point(px(10.0), px(10.0)), size(px(pill_w), px(pill_h)));
        painter = painter
            .save()
            .shadow(pal.card_shadow, px(5.0), point(px(0.0), px(2.0)))
            .begin_path()
            .fill_color(color)
            .round_rect(pb, px(11.0))
            .fill()
            .restore()
            .fill_color(pal.pill_ink)
            .font("600 11.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(&label, 10.0 + pill_w * 0.5, 10.0 + pill_h * 0.5)
            .restore();
    }
    painter
}

pub fn paint_minimap(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    camera: Camera,
    viewport_size: (f32, f32),
    minimap_size: (f32, f32),
    dark: bool,
) -> Drawing {
    paint_minimap_painter(doc, lookup, camera, viewport_size, minimap_size, dark).finish()
}

pub fn paint_minimap_painter(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    camera: Camera,
    viewport_size: (f32, f32),
    minimap_size: (f32, f32),
    dark: bool,
) -> Painter {
    let pal = WhiteboardPalette::for_mode(dark);
    let mw = minimap_size.0.max(60.0);
    let mh = minimap_size.1.max(40.0);

    let mut painter = Painter::new()
        .begin_path()
        .fill_color(pal.side)
        .round_rect(Bounds::new(point(px(0.0), px(0.0)), size(px(mw), px(mh))), px(8.0))
        .fill()
        .stroke_color(pal.line)
        .line_width(1.0)
        .begin_path()
        .round_rect(Bounds::new(point(px(0.0), px(0.0)), size(px(mw), px(mh))), px(8.0))
        .stroke();

    let world_view = camera.visible_world_rect(f64::from(viewport_size.0.max(1.0)), f64::from(viewport_size.1.max(1.0)));
    let world_bounds = doc.content_bounds().map_or(world_view, |c| c.union(world_view)).expand(60.0);

    let sx = f64::from(mw - 12.0) / world_bounds.w.max(1.0);
    let sy = f64::from(mh - 12.0) / world_bounds.h.max(1.0);
    let s = sx.min(sy);
    let ox = 6.0 + (f64::from(mw - 12.0) - world_bounds.w * s) * 0.5 - world_bounds.x * s;
    let oy = 6.0 + (f64::from(mh - 12.0) - world_bounds.h * s) * 0.5 - world_bounds.y * s;

    for el in &doc.elements {
        if el.is_arrow() {
            continue;
        }
        let r = el.bbox(lookup);
        let fill = match &el.kind {
            ElementKind::Shape { shape, fill, .. } => pal.shape_tone(*shape, fill).fill,
            ElementKind::Timeline { .. } => pal.timeline_start,
            ElementKind::Container { .. } => pal.container_header_bg,
            _ => pal.muted,
        };
        let mb = Bounds::new(
            point(px((r.x * s + ox) as f32), px((r.y * s + oy) as f32)),
            size(px((r.w * s).max(3.0) as f32), px((r.h * s).max(2.0) as f32)),
        );
        painter = painter.begin_path().fill_color(fill).round_rect(mb, px(1.5)).fill();
    }

    let vx = (world_view.x * s + ox).clamp(2.0, f64::from(mw - 6.0)) as f32;
    let vy = (world_view.y * s + oy).clamp(2.0, f64::from(mh - 6.0)) as f32;
    let vw = (world_view.w * s).clamp(8.0, f64::from(mw) - f64::from(vx) - 2.0) as f32;
    let vh = (world_view.h * s).clamp(8.0, f64::from(mh) - f64::from(vy) - 2.0) as f32;
    let vb = Bounds::new(point(px(vx), px(vy)), size(px(vw), px(vh)));

    painter
        .begin_path()
        .fill_color(pal.selection_soft)
        .rect(vb)
        .fill()
        .stroke_color(pal.selection)
        .line_width(1.2)
        .begin_path()
        .rect(vb)
        .stroke()
}
