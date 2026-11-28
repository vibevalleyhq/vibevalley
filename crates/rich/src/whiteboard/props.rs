use nsh_core::prelude::*;

/// Props of [`super::VvWhiteboard`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvWhiteboardProps {
    /// Serialized JSON array of whiteboard entry records stored on the artifact.
    pub entries_json: Prop<SharedString>,
    /// Optional serialized JSON array of extra live [`crate::engine::whiteboard::Presence`] objects (e.g. working agents).
    #[prop(default)]
    pub presences_json: Prop<SharedString>,
    /// Optional base64-encoded Loro CRDT update or snapshot bytes for incremental replica sync.
    #[prop(default)]
    pub collab_update_b64: Prop<SharedString>,
    /// Monotonic artifact store sequence number reported by the server.
    #[prop(default)]
    pub seq: Prop<i64>,
    /// Board title used in default export filenames and accessibility labels.
    #[prop(default)]
    pub title: Prop<SharedString>,
    /// Disables local element mutations when `true` while preserving navigation, inspect, and export.
    #[prop(default)]
    pub read_only: Prop<bool>,
    /// UI locale code (`"zh"` or `"en"`) driving labels and template starter copy.
    #[prop(default)]
    pub locale: Prop<SharedString>,
}

/// Payload emitted when local whiteboard edits need persistence via `artifact.file.write` or `artifact.collab.import`.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardBatchEvent {
    /// Serialized JSON array of whiteboard write operations for directory persistence.
    pub writes_json: SharedString,
    /// Base64-encoded incremental Loro CRDT update exported from the in-process replica.
    pub collab_update_b64: SharedString,
    /// Base64-encoded Loro `VersionVector` after the local replica commit.
    pub version_vector_b64: SharedString,
}

/// Payload emitted when the whiteboard selection changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardSelectionEvent {
    /// Serialized JSON array of selected element ID strings.
    pub ids_json: SharedString,
    /// Number of currently selected elements.
    pub count: u32,
}

/// Payload emitted when the user asks the orchestrator about the current selection.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardChatEvent {
    /// Serialized JSON array of selected element IDs passed as view context.
    pub selected_ids_json: SharedString,
}

/// Payload emitted when the user exports the whiteboard (`svg`, `png`, `json`, or `json-canvas`).
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardExportEvent {
    /// Export format identifier (`"svg"`, `"png"`, `"json"`, or `"json-canvas"`).
    pub format: SharedString,
    /// Suggested file name including extension.
    pub filename: SharedString,
    /// MIME type of `content` (`"image/svg+xml"`, `"image/png"`, `"application/json"`).
    pub mime: SharedString,
    /// Exported payload text (UTF-8 for SVG/JSON, base64-encoded binary for PNG).
    pub content: SharedString,
}

/// Payload emitted (throttled) when the local pointer moves in whiteboard world coordinates.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct VvWhiteboardCursorEvent {
    /// Local pointer X coordinate in world space.
    pub x: f64,
    /// Local pointer Y coordinate in world space.
    pub y: f64,
    /// Visible world viewport left X coordinate.
    pub viewport_x: f64,
    /// Visible world viewport top Y coordinate.
    pub viewport_y: f64,
    /// Visible world viewport width.
    pub viewport_w: f64,
    /// Visible world viewport height.
    pub viewport_h: f64,
    /// Current camera zoom factor (`1.0` = 100%).
    pub zoom: f64,
}

/// Payload emitted (throttled) when the local whiteboard camera viewport changes.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct VvWhiteboardViewportEvent {
    /// Visible world viewport left X coordinate.
    pub x: f64,
    /// Visible world viewport top Y coordinate.
    pub y: f64,
    /// Visible world viewport width.
    pub w: f64,
    /// Visible world viewport height.
    pub h: f64,
    /// Current camera zoom factor (`1.0` = 100%).
    pub zoom: f64,
}

/// Events emitted by [`super::VvWhiteboard`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvWhiteboardEvent {
    /// Local edits produced store writes and an incremental Loro replica delta for persistence.
    #[args(event)]
    Batch(VvWhiteboardBatchEvent),
    /// Active selection changed on the board.
    #[args(event)]
    SelectionChange(VvWhiteboardSelectionEvent),
    /// User clicked the native chat CTA to discuss or co-edit the board with the orchestrator.
    #[args(event)]
    OpenChat(VvWhiteboardChatEvent),
    /// User triggered SVG, 2x retina PNG, structured JSON, or JSON Canvas export.
    #[args(event)]
    Export(VvWhiteboardExportEvent),
    /// Local pointer moved over the canvas (throttled for live presence reporting).
    #[args(event)]
    CursorMove(VvWhiteboardCursorEvent),
    /// Local whiteboard camera viewport changed (throttled during pan/zoom, immediate on settle).
    #[args(event)]
    ViewportChange(VvWhiteboardViewportEvent),
}
