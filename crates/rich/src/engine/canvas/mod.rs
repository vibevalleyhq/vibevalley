//! Pure-Rust JSON Canvas 1.0 codec, specification validator, and `resvg`-safe
//! static SVG renderer.

pub mod extensions;
pub mod model;
pub mod svg;
pub mod validate;

pub use extensions::{ExtensionError, ExtensionFields};
pub use model::{
    BackgroundStyle, Canvas, CanvasColor, CanvasError, ColorError, Edge, EdgeId, End, FileNode, GroupNode, LinkNode, Node, NodeBounds, NodeId, PresetColor,
    Rect, Rgba8, Side, TextNode, parse_hex_rgba,
};
pub use svg::{ArrowConfig, EdgeStrokeStyle, PresetSwatch, SvgRenderOptions, SvgTheme, ThemePalette, render_svg, render_svg_default};
pub use validate::{ValidationIssue, ValidationReport, is_valid_subpath, is_valid_url, validate, validate_edge, validate_node};
