use crate::engine::whiteboard::codec::WhiteboardWriteInput;
use crate::engine::whiteboard::hit::ResizeHandle8;
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ElementId, GridStyle, InkMode, Point2, Presence, PresenceKind, PresenceViewport, Rect2, ShapeKind, StrokePoint,
    StrokeStyle, WbFill,
};
use crate::engine::whiteboard::ops::ZOrderDir;
use crate::engine::whiteboard::snap::{AlignOp, DistributeAxis};
use crate::engine::whiteboard::templates::TemplateKind;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Tool {
    #[default]
    Select,
    Hand,
    Text,
    Callout,
    Container,
    Card,
    Sticky,
    Shape(ShapeKind),
    Pen,
    Highlighter,
    Eraser,
    Sticker(String),
    Arrow,
    Timeline,
    Table,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
    pub accel: bool,
    pub space: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    Primary,
    Secondary,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerInput {
    pub screen_pos: Point2,
    pub clicks: u32,
    pub button: PointerButton,
    pub modifiers: Modifiers,
    pub pressure: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Svg,
    Png,
    Json,
    JsonCanvas,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InlineEditTarget {
    pub id: ElementId,
    pub screen_rect: Rect2,
    pub title: String,
    pub body: String,
    pub milestone_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnimatedPresencePose {
    pub x: f64,
    pub y: f64,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub viewport: Option<PresenceViewport>,
}

impl AnimatedPresencePose {
    pub fn from_presence(p: &Presence) -> Self {
        Self {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            viewport: p.viewport,
        }
    }

    pub fn region_rect(self, kind: PresenceKind) -> Option<Rect2> {
        let w = self.w.filter(|v| v.is_finite() && *v > 1.0)?;
        let h = self.h.filter(|v| v.is_finite() && *v > 1.0)?;
        if !self.x.is_finite() || !self.y.is_finite() || kind == PresenceKind::Viewport {
            return None;
        }
        Some(Rect2::new(self.x, self.y, w, h))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AnimationStepResult {
    pub presence_moved: bool,
    pub camera_moved: bool,
    pub still_animating: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControllerEffect {
    FlushBatch(Vec<WhiteboardWriteInput>),
    SelectionChanged(Vec<ElementId>),
    ToolChanged(Tool),
    ViewportChanged {
        zoom: f64,
    },
    FollowChanged(Option<String>),
    OpenInlineEditor(InlineEditTarget),
    OpenContextMenu {
        screen_pos: Point2,
        world_pos: Point2,
        target_id: Option<ElementId>,
    },
    OpenChatWithSelection(Vec<ElementId>),
    RequestExport(ExportFormat),
    GridChanged(GridStyle),
    HistoryChanged {
        can_undo: bool,
        can_redo: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum BoardAction {
    Undo,
    Redo,
    DeleteSelection,
    DuplicateSelection,
    CopySelection,
    CutSelection,
    Paste,
    SelectAll,
    Align(AlignOp),
    Distribute(DistributeAxis),
    TidyGrid,
    Reorder(ZOrderDir),
    GroupSelection,
    UngroupSelection,
    ToggleLockSelection,
    WrapInContainer(String),
    FitToContent,
    ZoomToSelection,
    ResetZoom,
    ZoomBy(f64),
    SetGrid(GridStyle),
    SetFillSelection(WbFill),
    SetShapeSelection(ShapeKind),
    SetArrowCurveSelection(ArrowCurve),
    SetStrokeStyleSelection(StrokeStyle),
    SetStickerSelection(Option<String>),
    ApplyTemplate(TemplateKind, bool),
    FollowActor(Option<String>),
    AskOrchestrator,
    Export(ExportFormat),
}

#[derive(Debug, Clone, PartialEq)]
pub enum InteractionMode {
    Idle,
    Panning {
        last_screen: Point2,
    },
    Marquee {
        start_world: Point2,
        cur_world: Point2,
    },
    Dragging {
        start_world: Point2,
        prev_world: Point2,
        anchor_rect: Rect2,
        ids: Vec<ElementId>,
        moved_any: bool,
        op_key: String,
    },
    Resizing {
        id: ElementId,
        handle: ResizeHandle8,
        start_rect: Rect2,
        start_world: Point2,
        changed: bool,
        op_key: String,
    },
    Rotating {
        id: ElementId,
        center: Point2,
        start_angle_deg: f64,
        initial_rotation_deg: f64,
        changed: bool,
        op_key: String,
    },
    DrawingBox {
        start_world: Point2,
        cur_world: Point2,
    },
    DrawingInk {
        points: Vec<StrokePoint>,
        mode: InkMode,
    },
    Erasing {
        points: Vec<Point2>,
        erased_ids: Vec<ElementId>,
    },
    ConnectingArrow {
        from: ArrowEndpoint,
        cur_world: Point2,
        snap_target: Option<(ElementId, AnchorSide, Point2)>,
    },
    DraggingArrowEndpoint {
        id: ElementId,
        is_start: bool,
        snap_target: Option<(ElementId, AnchorSide, Point2)>,
        op_key: String,
    },
    DraggingTimelineControl {
        id: ElementId,
        index: usize,
        op_key: String,
    },
    DraggingTimelineMilestone {
        id: ElementId,
        index: usize,
        op_key: String,
    },
}
