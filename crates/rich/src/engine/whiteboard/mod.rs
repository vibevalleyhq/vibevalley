//! Pure-Rust collaborative infinite whiteboard engine (`VvWhiteboard` backend).

pub mod codec;
pub mod export;
pub mod geometry;
pub mod hit;
pub mod ink;
pub mod interaction;
pub mod layout;
pub mod model;
pub mod ops;
pub mod paint;
pub mod snap;
pub mod spatial;
pub mod stickers;
pub mod templates;

pub use codec::{
    CodecError, decode_board_entries, decode_element, decode_meta, decode_presence, encode_element_delete, encode_element_json, encode_element_patch,
    encode_element_write, encode_meta_write, encode_presence_write, import_json_canvas,
};
pub use export::{build_export_painter, export_json, export_json_canvas, export_svg};
pub use geometry::{
    ArrowGeometry, Camera, CubicSegment, HeadShape, MAX_ZOOM, MIN_ZOOM, RouteShape, anchor_point, arrowhead_geometry, auto_anchor_sides, catmull_rom_cubics,
    cubics_to_svg_path, dist_sq_point_segment, distance_to_polyline, project_point_to_polyline, resolve_arrow_endpoints, rotate_point, rotated_bbox,
    route_arrow, sample_polyline, unrotate_point,
};
pub use hit::{
    HitConfig, HitTarget, MarqueeMode, ResizeHandle8, anchor_port_pos, can_host_anchor_port, container_at_point, container_header_rect, expand_with_children,
    hit_test, marquee_select, point_near_polyline_segment, rotate_handle_pos, snap_anchor_endpoint,
};
pub use ink::{build_ink_outline, simplify_stroke_points, strokes_hit_by_eraser};
pub use interaction::{
    BoardAction, ControllerEffect, ExportFormat, InlineEditTarget, InteractionMode, Modifiers, PointerButton, PointerInput, Tool, WhiteboardController,
    live_anchor_point,
};
pub use layout::{CardTextLayout, HighlightSpan, TableLayout, layout_card, layout_table, locate_highlight_span, measure_text_span, wrap_text};
pub use model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardDoc, BoardMeta, ElementId, ElementKind, ElementRecord, ExtraFields, GridStyle, InkMode,
    MilestoneKind, Point2, Presence, PresenceColor, Rect2, ShapeKind, StrokePoint, StrokeStyle, TextAlign, TextVariant, TimelineMilestone, Vec2, WbFill,
};
pub use ops::{
    ApplyResult, BoardCommand, DEFAULT_HISTORY_LIMIT, ElementDelta, HistoryEntry, UndoHistory, ZOrderDir, apply_command, apply_history_step,
    apply_remote_entries, make_sticky_or_shape,
};
pub use paint::{
    FillTone, LayerPaintInput, WhiteboardPalette, paint_board_into_painter, paint_grid, paint_minimap, paint_minimap_painter, paint_overlay_layer,
    paint_overlay_layer_painter, paint_overlay_layer_painter_filtered, paint_presences_into_painter, paint_static_layer, paint_static_layer_painter,
};
pub use snap::{
    AlignOp, DistributeAxis, SnapAxis, SnapConfig, SnapGuide, compute_align_deltas, compute_distribute_deltas, compute_move_snap, compute_resize_snap,
    compute_tidy_grid_deltas, nudge_step, round_point, snap_scalar,
};
pub use spatial::SpatialIndex;
pub use stickers::{
    STICKERS, StickerCategory, StickerSpec, cached_svg_drawing, clear_sticker_cache, resolve_sticker_svg, sticker_cache_stats, sticker_drawing, sticker_svg,
};
pub use templates::{TemplateCopy, TemplateKind, build_template_doc, build_template_writes};
