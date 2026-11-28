mod cards;
mod elements;
mod overlay;
mod palette;
mod primitives;

use std::collections::{BTreeSet, HashMap};

use nsh_core::canvas::{CanvasNode, Drawing};
use nsh_core::prelude::{AccessibilityRole, Bounds, Painter, point, px, size};

use crate::engine::whiteboard::geometry::Camera;
use crate::engine::whiteboard::interaction::WhiteboardController;
use crate::engine::whiteboard::model::{BoardDoc, ElementId, ElementKind, Point2, Rect2};
use crate::engine::whiteboard::spatial::SpatialIndex;

pub use elements::{paint_board_into_painter, paint_board_into_painter_ex};
pub use overlay::{
    paint_minimap, paint_minimap_painter, paint_overlay_layer, paint_overlay_layer_painter, paint_overlay_layer_painter_filtered, paint_presences_into_painter,
};
pub use palette::{FillTone, WhiteboardPalette, parse_hex_hsla};
pub use primitives::paint_grid;

use overlay::paint_overlay_world_contents;

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

pub struct FramePaintInput<'a> {
    pub controller: &'a WhiteboardController,
    pub viewport_size: (f32, f32),
    pub editing_id: Option<&'a ElementId>,
    pub editing_milestone: Option<usize>,
    pub dark: bool,
    pub anim_hidden_ids: &'a BTreeSet<ElementId>,
    pub dismissed_notes: &'a BTreeSet<String>,
    pub fast_shadows: bool,
}

fn paint_world_backdrop(
    doc: &BoardDoc,
    index: &SpatialIndex,
    lookup: &HashMap<ElementId, Rect2>,
    camera: Camera,
    viewport_size: (f32, f32),
    pal: &WhiteboardPalette,
) -> (Painter, BTreeSet<usize>) {
    let vw = viewport_size.0.max(1.0);
    let vh = viewport_size.1.max(1.0);
    let bg = doc.meta.background.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.page);
    let painter = Painter::new()
        .begin_path()
        .fill_color(bg)
        .rect(Bounds::new(point(px(0.0), px(0.0)), size(px(vw), px(vh))))
        .fill();
    let painter = paint_grid(painter, doc.meta.grid, camera, vw, vh, pal);
    let visible = collect_visible_indices(doc, index, lookup, camera, vw, vh);
    let painter = painter
        .save()
        .translate(camera.pan_x as f32, camera.pan_y as f32)
        .scale(camera.zoom as f32, camera.zoom as f32);
    (painter, visible)
}

fn collect_visible_indices(doc: &BoardDoc, index: &SpatialIndex, lookup: &HashMap<ElementId, Rect2>, camera: Camera, vw: f32, vh: f32) -> BTreeSet<usize> {
    let world_view = camera.visible_world_rect(f64::from(vw), f64::from(vh));
    let mut visible: BTreeSet<usize> = index.query_rect(world_view.expand(120.0)).into_iter().collect();
    for (idx, el) in doc.elements.iter().enumerate() {
        if (el.is_arrow() || matches!(el.kind, ElementKind::Timeline { .. })) && el.visual_bbox(lookup).intersects(world_view.expand(180.0)) {
            visible.insert(idx);
        }
    }
    visible
}

fn emit_accessibility_nodes(
    mut painter: Painter,
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    camera: Camera,
    visible: &BTreeSet<usize>,
    selection: &[ElementId],
    anim_hidden_ids: &BTreeSet<ElementId>,
) -> Painter {
    let sel_set: BTreeSet<&ElementId> = selection.iter().collect();
    for &idx in visible {
        let Some(el) = doc.elements.get(idx) else {
            continue;
        };
        if anim_hidden_ids.contains(&el.id) {
            continue;
        }
        let world_r = el.bbox(lookup);
        let tl = camera.world_to_screen(Point2::new(world_r.x, world_r.y));
        let br = camera.world_to_screen(Point2::new(world_r.right(), world_r.bottom()));
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

/// Paints the entire whiteboard frame (background, grid, world elements, live overlays,
/// and accessibility nodes) atomically from one `Camera` snapshot.
pub fn paint_board_frame(input: &FramePaintInput<'_>) -> Drawing {
    paint_board_frame_painter(input).finish()
}

/// Builds a single atomic [`Painter`] for one whiteboard frame so shapes, selection chrome,
/// guides, and collaborator presences share the exact same camera transform.
pub fn paint_board_frame_painter(input: &FramePaintInput<'_>) -> Painter {
    let ctrl = input.controller;
    let camera = ctrl.camera;
    let pal = WhiteboardPalette::for_mode(input.dark);
    let (mut painter, visible) = paint_world_backdrop(&ctrl.doc, &ctrl.spatial, &ctrl.lookup, camera, input.viewport_size, &pal);

    painter = paint_board_into_painter_ex(
        painter,
        &ctrl.doc,
        &ctrl.lookup,
        &pal,
        Some(&visible),
        input.editing_id,
        input.editing_milestone,
        input.anim_hidden_ids,
        input.fast_shadows,
    );
    painter = paint_overlay_world_contents(painter, ctrl, &pal, camera.zoom, input.dismissed_notes, input.fast_shadows);
    painter = painter.restore();

    emit_accessibility_nodes(painter, &ctrl.doc, &ctrl.lookup, camera, &visible, &ctrl.selection, input.anim_hidden_ids)
}

pub fn paint_static_layer(input: &LayerPaintInput<'_>) -> Drawing {
    paint_static_layer_painter(input).finish()
}

pub fn paint_static_layer_painter(input: &LayerPaintInput<'_>) -> Painter {
    let pal = WhiteboardPalette::for_mode(input.dark);
    let (mut painter, visible) = paint_world_backdrop(input.doc, input.index, input.lookup, input.camera, input.viewport_size, &pal);

    painter = paint_board_into_painter(painter, input.doc, input.lookup, &pal, Some(&visible), input.editing_id, input.anim_hidden_ids);

    painter = painter.restore();

    emit_accessibility_nodes(painter, input.doc, input.lookup, input.camera, &visible, input.selection, input.anim_hidden_ids)
}
