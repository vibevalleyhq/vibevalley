//! Pure-Rust JSON Canvas 1.0 codec, specification validator, interactive
//! infinite-canvas engine (camera, hit-testing, group containment, snapping,
//! command/op history), and `resvg`-safe SVG renderer.

pub mod extensions;
pub mod geometry;
pub mod hit;
pub mod model;
pub mod ops;
pub mod svg;
pub mod validate;

pub use extensions::{ExtensionError, ExtensionFields};
pub use geometry::{
    AlignKind, ArrowConfig, Arrowhead, CubicBezier, DistributeAxis, EdgeGeometry, Point, Rect, ResizeHandle, ResizeSnapResult, Size, SnapConfig, SnapGuide,
    SnapMoveResult, Vec2, Viewport, anchor_point, compute_alignment, compute_distribution, compute_edge_geometry, compute_edge_geometry_between,
    resolve_edge_sides, snap_node_move, snap_node_resize, snap_point_to_grid, snap_scalar_to_grid,
};
pub use hit::{
    GROUP_LABEL_GAP, GROUP_LABEL_HEIGHT, HitConfig, HitTarget, MarqueeMode, MarqueeSelection, anchor_port_position, enclosing_groups,
    expand_with_group_contents, group_contains_node, group_label_rect, hit_test, hit_test_anchor_port, hit_test_anchor_port_with_offset, hit_test_edge,
    hit_test_node, hit_test_resize_handle, hit_test_world, marquee_select, nodes_in_group,
};
pub use model::{
    BackgroundStyle, Canvas, CanvasColor, CanvasError, ColorError, Edge, EdgeId, End, FileNode, GroupNode, LinkNode, Node, NodeBounds, NodeId, NodeKind,
    PresetColor, Rgba8, Side, TextNode, parse_hex_rgba,
};
pub use ops::{CanvasDocument, CanvasOp, DEFAULT_HISTORY_LIMIT, EdgePatch, FieldPatch, NodeContentPatch, NodePatch, OpError, SelectionState, ZOrderTarget};
pub use svg::{EdgeStrokeStyle, PresetSwatch, SvgRenderOptions, SvgTheme, ThemePalette, render_svg, render_svg_default};
pub use validate::{ValidationIssue, ValidationReport, is_valid_subpath, is_valid_url, validate, validate_edge, validate_node};
