use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ElementId(pub String);

impl ElementId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ElementId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for ElementId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for ElementId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point2 {
    pub x: f64,
    pub y: f64,
}

impl Point2 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn distance(self, other: Self) -> f64 {
        self.distance_sq(other).sqrt()
    }

    pub fn distance_sq(self, other: Self) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }

    pub fn offset(self, delta: Vec2) -> Self {
        Self {
            x: self.x + delta.x,
            y: self.y + delta.y,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    pub fn normalized(self) -> Option<Self> {
        let len = self.length();
        (len > 1e-9).then(|| Self {
            x: self.x / len,
            y: self.y / len,
        })
    }

    pub fn scale(self, factor: f64) -> Self {
        Self {
            x: self.x * factor,
            y: self.y * factor,
        }
    }

    pub fn perp(self) -> Self {
        Self { x: -self.y, y: self.x }
    }
}

impl std::ops::Sub<Point2> for Point2 {
    type Output = Vec2;

    fn sub(self, rhs: Point2) -> Vec2 {
        Vec2::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl std::ops::Add<Vec2> for Point2 {
    type Output = Point2;

    fn add(self, rhs: Vec2) -> Point2 {
        self.offset(rhs)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect2 {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect2 {
    pub const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    };

    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn from_corners(a: Point2, b: Point2) -> Self {
        let min_x = a.x.min(b.x);
        let min_y = a.y.min(b.y);
        let max_x = a.x.max(b.x);
        let max_y = a.y.max(b.y);
        Self {
            x: min_x,
            y: min_y,
            w: max_x - min_x,
            h: max_y - min_y,
        }
    }

    pub fn right(self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(self) -> f64 {
        self.y + self.h
    }

    pub fn center(self) -> Point2 {
        Point2::new(self.x + self.w * 0.5, self.y + self.h * 0.5)
    }

    pub fn expand(self, margin: f64) -> Self {
        Self {
            x: self.x - margin,
            y: self.y - margin,
            w: (self.w + margin * 2.0).max(0.0),
            h: (self.h + margin * 2.0).max(0.0),
        }
    }

    pub fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let r = self.right().max(other.right());
        let b = self.bottom().max(other.bottom());
        Self::new(x, y, (r - x).max(0.0), (b - y).max(0.0))
    }

    pub fn contains_point(self, pt: Point2) -> bool {
        pt.x >= self.x && pt.x <= self.right() && pt.y >= self.y && pt.y <= self.bottom()
    }

    pub fn contains_rect(self, other: Self) -> bool {
        other.x >= self.x && other.y >= self.y && other.right() <= self.right() && other.bottom() <= self.bottom()
    }

    pub fn intersects(self, other: Self) -> bool {
        self.x <= other.right() && self.right() >= other.x && self.y <= other.bottom() && self.bottom() >= other.y
    }
}

/// Preserves unrecognized wire fields across codec round-trips without exposing JSON inside the engine.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExtraFields(pub BTreeMap<String, Value>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridStyle {
    #[default]
    Architectural,
    Dots,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BoardMeta {
    pub title: String,
    pub grid: GridStyle,
    pub background: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextVariant {
    Title,
    Subtitle,
    Callout,
    #[default]
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeKind {
    #[default]
    Card,
    Sticky,
    Rect,
    Rounded,
    Diamond,
    Ellipse,
    Pill,
    Triangle,
    Cylinder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrokeStyle {
    #[default]
    Solid,
    Dashed,
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnchorSide {
    N,
    #[default]
    E,
    S,
    W,
}

impl AnchorSide {
    pub const ALL: [AnchorSide; 4] = [AnchorSide::N, AnchorSide::E, AnchorSide::S, AnchorSide::W];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::N => "n",
            Self::E => "e",
            Self::S => "s",
            Self::W => "w",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "n" | "top" => Some(Self::N),
            "e" | "right" => Some(Self::E),
            "s" | "bottom" => Some(Self::S),
            "w" | "left" => Some(Self::W),
            _ => None,
        }
    }

    pub fn normal(self) -> Vec2 {
        match self {
            Self::N => Vec2::new(0.0, -1.0),
            Self::E => Vec2::new(1.0, 0.0),
            Self::S => Vec2::new(0.0, 1.0),
            Self::W => Vec2::new(-1.0, 0.0),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum WbFill {
    #[default]
    Default,
    Sun,
    Peach,
    Leaf,
    Water,
    Lavender,
    Berry,
    Side,
    Custom(String),
}

impl WbFill {
    pub const PRESETS: [WbFill; 8] = [
        WbFill::Default,
        WbFill::Sun,
        WbFill::Peach,
        WbFill::Leaf,
        WbFill::Water,
        WbFill::Lavender,
        WbFill::Berry,
        WbFill::Side,
    ];

    pub fn as_str(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::Sun => "sun",
            Self::Peach => "peach",
            Self::Leaf => "leaf",
            Self::Water => "water",
            Self::Lavender => "lavender",
            Self::Berry => "berry",
            Self::Side => "side",
            Self::Custom(s) => s.as_str(),
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "default" | "page" | "white" => Self::Default,
            "sun" | "wheat" | "amber" | "yellow" => Self::Sun,
            "peach" | "orange" => Self::Peach,
            "leaf" | "green" | "ok" => Self::Leaf,
            "water" | "blue" => Self::Water,
            "lavender" | "purple" => Self::Lavender,
            "berry" | "red" | "bad" => Self::Berry,
            "side" | "muted" | "neutral" => Self::Side,
            _ => Self::Custom(raw.trim().to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ArrowEndpoint {
    Bound { id: ElementId, side: Option<AnchorSide> },
    Free(Point2),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArrowCurve {
    #[default]
    Smooth,
    Orthogonal,
    Straight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArrowHead {
    #[default]
    Arrow,
    None,
    Diamond,
    Dot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MilestoneKind {
    #[default]
    Major,
    Minor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineMilestone {
    pub t: Option<f64>,
    pub pos: Option<Point2>,
    pub label: String,
    pub kind: MilestoneKind,
    pub tone: Option<String>,
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StrokePoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f32,
}

impl StrokePoint {
    pub const fn new(x: f64, y: f64, pressure: f32) -> Self {
        Self { x, y, pressure }
    }

    pub const fn point2(self) -> Point2 {
        Point2::new(self.x, self.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InkMode {
    #[default]
    Pen,
    Highlighter,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ElementKind {
    Text {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        variant: TextVariant,
        label: String,
        highlight: Option<String>,
        icon: Option<String>,
        align: TextAlign,
        font_size: Option<f32>,
        fill: Option<WbFill>,
        color: Option<String>,
    },
    Shape {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        shape: ShapeKind,
        title: String,
        body: String,
        fill: WbFill,
        stroke: Option<String>,
        stroke_style: StrokeStyle,
        corner_radius: Option<f32>,
        sticker: Option<String>,
        sticker_svg: Option<String>,
        badge: Option<String>,
        align: TextAlign,
    },
    Container {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        title: String,
        fill: WbFill,
        stroke: Option<String>,
        collapsed: bool,
    },
    Timeline {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: WbFill,
        points: Vec<Point2>,
        milestones: Vec<TimelineMilestone>,
    },
    Arrow {
        from: ArrowEndpoint,
        to: ArrowEndpoint,
        bends: Vec<Point2>,
        curve: ArrowCurve,
        style: StrokeStyle,
        start_head: ArrowHead,
        end_head: ArrowHead,
        stroke: Option<String>,
        stroke_width: f32,
        label: Option<String>,
    },
    Path {
        points: Vec<StrokePoint>,
        stroke: String,
        stroke_width: f32,
        mode: InkMode,
    },
    Sticker {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        sticker: String,
        svg: Option<String>,
        label: Option<String>,
    },
    Svg {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        svg: String,
        label: Option<String>,
    },
    Image {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        attachment_id: Option<String>,
        uri: String,
        alt: Option<String>,
        crop: Option<Rect2>,
    },
    Table {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
        fill: WbFill,
    },
    Claim {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        label: String,
        agent_id: Option<String>,
        status: Option<String>,
    },
    HtmlEmbed {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        html: String,
        title: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElementRecord {
    pub id: ElementId,
    pub rev: i64,
    pub z: i32,
    pub locked: bool,
    pub group_id: Option<String>,
    pub parent_id: Option<ElementId>,
    pub rotation_deg: f64,
    pub opacity: f32,
    pub kind: ElementKind,
    pub extra: ExtraFields,
}

impl ElementRecord {
    pub fn new(id: impl Into<ElementId>, kind: ElementKind) -> Self {
        Self {
            id: id.into(),
            rev: 0,
            z: 0,
            locked: false,
            group_id: None,
            parent_id: None,
            rotation_deg: 0.0,
            opacity: 1.0,
            kind,
            extra: ExtraFields::default(),
        }
    }

    pub fn is_container(&self) -> bool {
        matches!(self.kind, ElementKind::Container { .. })
    }

    pub fn is_arrow(&self) -> bool {
        matches!(self.kind, ElementKind::Arrow { .. })
    }

    pub fn primary_label(&self) -> &str {
        match &self.kind {
            ElementKind::Text { label, .. } => label.as_str(),
            ElementKind::Shape { title, body, .. } => {
                if !title.is_empty() {
                    title.as_str()
                } else {
                    body.as_str()
                }
            }
            ElementKind::Container { title, .. } => title.as_str(),
            ElementKind::Timeline { milestones, .. } => milestones.first().map_or("Timeline", |m| m.label.as_str()),
            ElementKind::Arrow { label, .. } => label.as_deref().unwrap_or(""),
            ElementKind::Path { .. } => "Ink stroke",
            ElementKind::Sticker { label, sticker, .. } => label.as_deref().unwrap_or(sticker.as_str()),
            ElementKind::Svg { label, .. } => label.as_deref().unwrap_or("SVG"),
            ElementKind::Image { alt, uri, .. } => alt.as_deref().unwrap_or(uri.as_str()),
            ElementKind::Table { headers, .. } => headers.first().map_or("Table", String::as_str),
            ElementKind::Claim { label, .. } => label.as_str(),
            ElementKind::HtmlEmbed { title, .. } => title.as_deref().unwrap_or("Embed"),
        }
    }

    pub fn bbox(&self, lookup: &HashMap<ElementId, Rect2>) -> Rect2 {
        match &self.kind {
            ElementKind::Text { x, y, w, h, .. }
            | ElementKind::Shape { x, y, w, h, .. }
            | ElementKind::Container { x, y, w, h, .. }
            | ElementKind::Sticker { x, y, w, h, .. }
            | ElementKind::Svg { x, y, w, h, .. }
            | ElementKind::Image { x, y, w, h, .. }
            | ElementKind::Table { x, y, w, h, .. }
            | ElementKind::Claim { x, y, w, h, .. }
            | ElementKind::HtmlEmbed { x, y, w, h, .. } => Rect2::new(*x, *y, (*w).max(12.0), (*h).max(12.0)),
            ElementKind::Timeline { x, y, w, h, points, .. } => {
                if points.len() >= 2 {
                    let mut min_x = f64::INFINITY;
                    let mut min_y = f64::INFINITY;
                    let mut max_x = f64::NEG_INFINITY;
                    let mut max_y = f64::NEG_INFINITY;
                    for p in points {
                        min_x = min_x.min(p.x - 36.0);
                        min_y = min_y.min(p.y - 24.0);
                        max_x = max_x.max(p.x + 36.0);
                        max_y = max_y.max(p.y + 44.0);
                    }
                    Rect2::new(min_x, min_y, (max_x - min_x).max(40.0), (max_y - min_y).max(32.0))
                } else {
                    Rect2::new(*x, *y, (*w).max(80.0), (*h).max(32.0))
                }
            }
            ElementKind::Path { points, stroke_width, .. } => {
                if points.is_empty() {
                    return Rect2::ZERO;
                }
                let pad = f64::from((*stroke_width).max(2.0));
                let mut min_x = f64::INFINITY;
                let mut min_y = f64::INFINITY;
                let mut max_x = f64::NEG_INFINITY;
                let mut max_y = f64::NEG_INFINITY;
                for p in points {
                    min_x = min_x.min(p.x);
                    min_y = min_y.min(p.y);
                    max_x = max_x.max(p.x);
                    max_y = max_y.max(p.y);
                }
                Rect2::new(min_x - pad, min_y - pad, (max_x - min_x) + pad * 2.0, (max_y - min_y) + pad * 2.0)
            }
            ElementKind::Arrow { from, to, bends, .. } => {
                let mut pts = Vec::with_capacity(bends.len() + 2);
                if let Some(p) = resolve_endpoint_point(from, lookup) {
                    pts.push(p);
                }
                pts.extend(bends.iter().copied());
                if let Some(p) = resolve_endpoint_point(to, lookup) {
                    pts.push(p);
                }
                if pts.is_empty() {
                    return Rect2::ZERO;
                }
                let mut min_x = f64::INFINITY;
                let mut min_y = f64::INFINITY;
                let mut max_x = f64::NEG_INFINITY;
                let mut max_y = f64::NEG_INFINITY;
                for p in pts {
                    min_x = min_x.min(p.x);
                    min_y = min_y.min(p.y);
                    max_x = max_x.max(p.x);
                    max_y = max_y.max(p.y);
                }
                Rect2::new(min_x - 16.0, min_y - 16.0, (max_x - min_x).max(1.0) + 32.0, (max_y - min_y).max(1.0) + 32.0)
            }
        }
    }

    pub fn visual_bbox(&self, lookup: &HashMap<ElementId, Rect2>) -> Rect2 {
        let base = self.bbox(lookup);
        let mut rect = match &self.kind {
            ElementKind::Shape { sticker, sticker_svg, .. } if sticker.is_some() || sticker_svg.is_some() => {
                Rect2::new(base.x, base.y - 32.0, base.w, base.h + 32.0)
            }
            _ => base,
        };
        if self.rotation_deg.abs() > 1e-4 && !self.is_arrow() {
            rect = crate::engine::whiteboard::geometry::rotated_bbox(rect, self.rotation_deg);
        }
        rect
    }

    pub fn set_bounds(&mut self, rect: Rect2) -> bool {
        let w = rect.w.max(12.0);
        let h = rect.h.max(12.0);
        match &mut self.kind {
            ElementKind::Text { x, y, w: ew, h: eh, .. }
            | ElementKind::Shape { x, y, w: ew, h: eh, .. }
            | ElementKind::Container { x, y, w: ew, h: eh, .. }
            | ElementKind::Sticker { x, y, w: ew, h: eh, .. }
            | ElementKind::Svg { x, y, w: ew, h: eh, .. }
            | ElementKind::Image { x, y, w: ew, h: eh, .. }
            | ElementKind::Table { x, y, w: ew, h: eh, .. }
            | ElementKind::Claim { x, y, w: ew, h: eh, .. }
            | ElementKind::HtmlEmbed { x, y, w: ew, h: eh, .. } => {
                *x = rect.x;
                *y = rect.y;
                *ew = w;
                *eh = h;
                true
            }
            ElementKind::Timeline {
                x, y, w: ew, h: eh, points, ..
            } => {
                let old = if points.len() >= 2 {
                    let mut min_x = f64::INFINITY;
                    let mut min_y = f64::INFINITY;
                    let mut max_x = f64::NEG_INFINITY;
                    let mut max_y = f64::NEG_INFINITY;
                    for p in points.iter() {
                        min_x = min_x.min(p.x);
                        min_y = min_y.min(p.y);
                        max_x = max_x.max(p.x);
                        max_y = max_y.max(p.y);
                    }
                    Rect2::new(min_x, min_y, (max_x - min_x).max(1.0), (max_y - min_y).max(1.0))
                } else {
                    Rect2::new(*x, *y, (*ew).max(1.0), (*eh).max(1.0))
                };
                for p in points.iter_mut() {
                    p.x = rect.x + ((p.x - old.x) / old.w) * w;
                    p.y = rect.y + ((p.y - old.y) / old.h) * h;
                }
                *x = rect.x;
                *y = rect.y;
                *ew = w;
                *eh = h;
                true
            }
            ElementKind::Path { points, .. } => {
                if points.is_empty() {
                    return false;
                }
                let mut min_x = f64::INFINITY;
                let mut min_y = f64::INFINITY;
                let mut max_x = f64::NEG_INFINITY;
                let mut max_y = f64::NEG_INFINITY;
                for p in points.iter() {
                    min_x = min_x.min(p.x);
                    min_y = min_y.min(p.y);
                    max_x = max_x.max(p.x);
                    max_y = max_y.max(p.y);
                }
                let ow = (max_x - min_x).max(1.0);
                let oh = (max_y - min_y).max(1.0);
                for p in points.iter_mut() {
                    p.x = rect.x + ((p.x - min_x) / ow) * w;
                    p.y = rect.y + ((p.y - min_y) / oh) * h;
                }
                true
            }
            ElementKind::Arrow { .. } => false,
        }
    }

    pub fn translate(&mut self, dx: f64, dy: f64) {
        match &mut self.kind {
            ElementKind::Text { x, y, .. }
            | ElementKind::Shape { x, y, .. }
            | ElementKind::Container { x, y, .. }
            | ElementKind::Sticker { x, y, .. }
            | ElementKind::Svg { x, y, .. }
            | ElementKind::Image { x, y, .. }
            | ElementKind::Table { x, y, .. }
            | ElementKind::Claim { x, y, .. }
            | ElementKind::HtmlEmbed { x, y, .. } => {
                *x += dx;
                *y += dy;
            }
            ElementKind::Timeline { x, y, points, milestones, .. } => {
                *x += dx;
                *y += dy;
                for p in points {
                    p.x += dx;
                    p.y += dy;
                }
                for m in milestones {
                    if let Some(pos) = &mut m.pos {
                        pos.x += dx;
                        pos.y += dy;
                    }
                }
            }
            ElementKind::Path { points, .. } => {
                for p in points {
                    p.x += dx;
                    p.y += dy;
                }
            }
            ElementKind::Arrow { from, to, bends, .. } => {
                if let ArrowEndpoint::Free(p) = from {
                    p.x += dx;
                    p.y += dy;
                }
                if let ArrowEndpoint::Free(p) = to {
                    p.x += dx;
                    p.y += dy;
                }
                for p in bends {
                    p.x += dx;
                    p.y += dy;
                }
            }
        }
    }
}

fn resolve_endpoint_point(ep: &ArrowEndpoint, lookup: &HashMap<ElementId, Rect2>) -> Option<Point2> {
    match ep {
        ArrowEndpoint::Free(pt) => Some(*pt),
        ArrowEndpoint::Bound { id, side } => lookup.get(id).map(|rect| {
            let s = side.unwrap_or(AnchorSide::E);
            crate::engine::whiteboard::geometry::anchor_point(*rect, s)
        }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceColor {
    #[default]
    Coral,
    Teal,
    Blue,
    Leaf,
    Wheat,
    Lavender,
}

impl PresenceColor {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "teal" => Self::Teal,
            "blue" => Self::Blue,
            "leaf" | "green" => Self::Leaf,
            "wheat" | "amber" => Self::Wheat,
            "lavender" | "purple" => Self::Lavender,
            _ => Self::Coral,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Coral => "coral",
            Self::Teal => "teal",
            Self::Blue => "blue",
            Self::Leaf => "leaf",
            Self::Wheat => "wheat",
            Self::Lavender => "lavender",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceKind {
    #[default]
    Cursor,
    BlockCursor,
    Selection,
    Highlight,
    Claim,
    Viewport,
}

impl PresenceKind {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "block_cursor" | "blockcursor" => Self::BlockCursor,
            "selection" => Self::Selection,
            "highlight" => Self::Highlight,
            "claim" => Self::Claim,
            "viewport" => Self::Viewport,
            _ => Self::Cursor,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cursor => "cursor",
            Self::BlockCursor => "block_cursor",
            Self::Selection => "selection",
            Self::Highlight => "highlight",
            Self::Claim => "claim",
            Self::Viewport => "viewport",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceViewport {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
}

impl PresenceViewport {
    pub fn rect(self) -> Option<Rect2> {
        if self.x.is_finite() && self.y.is_finite() && self.w.is_finite() && self.h.is_finite() && self.w > 1.0 && self.h > 1.0 {
            Some(Rect2::new(self.x, self.y, self.w, self.h))
        } else {
            None
        }
    }

    pub fn center(self) -> Point2 {
        Point2::new(self.x + self.w * 0.5, self.y + self.h * 0.5)
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Presence {
    pub id: String,
    pub name: String,
    pub color: PresenceColor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_color: Option<String>,
    #[serde(default)]
    pub kind: PresenceKind,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
    pub status: Option<String>,
    pub selected_ids: Vec<ElementId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<PresenceViewport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default = "default_true")]
    pub has_cursor: bool,
    pub rev: i64,
}

impl Default for Presence {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: PresenceColor::Coral,
            custom_color: None,
            kind: PresenceKind::Cursor,
            x: 0.0,
            y: 0.0,
            w: None,
            h: None,
            status: None,
            selected_ids: Vec::new(),
            viewport: None,
            updated_at: None,
            has_cursor: true,
            rev: 0,
        }
    }
}

impl Presence {
    pub fn region_rect(&self) -> Option<Rect2> {
        let w = self.w.filter(|v| v.is_finite() && *v > 1.0)?;
        let h = self.h.filter(|v| v.is_finite() && *v > 1.0)?;
        if !self.x.is_finite() || !self.y.is_finite() || self.kind == PresenceKind::Viewport {
            return None;
        }
        Some(Rect2::new(self.x, self.y, w, h))
    }

    pub fn focus_point(&self) -> Point2 {
        if let Some(vp) = self.viewport
            && let Some(rect) = vp.rect()
        {
            return rect.center();
        }
        if let Some(rect) = self.region_rect() {
            return rect.center();
        }
        Point2::new(self.x, self.y)
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct BoardDoc {
    pub meta: BoardMeta,
    pub elements: Vec<ElementRecord>,
    pub presences: Vec<Presence>,
    pub seq: i64,
}

impl BoardDoc {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            meta: BoardMeta {
                title: title.into(),
                grid: GridStyle::Architectural,
                background: None,
            },
            elements: Vec::new(),
            presences: Vec::new(),
            seq: 0,
        }
    }

    pub fn rect_lookup(&self) -> HashMap<ElementId, Rect2> {
        let mut map = HashMap::with_capacity(self.elements.len());
        // Pass 1 collects non-arrow rects so arrows referencing elements resolve accurately.
        for el in &self.elements {
            if !el.is_arrow() {
                map.insert(el.id.clone(), el.bbox(&map));
            }
        }
        map
    }

    pub fn element(&self, id: &ElementId) -> Option<&ElementRecord> {
        self.elements.iter().find(|e| &e.id == id)
    }

    pub fn element_mut(&mut self, id: &ElementId) -> Option<&mut ElementRecord> {
        self.elements.iter_mut().find(|e| &e.id == id)
    }

    pub fn sort_by_z(&mut self) {
        self.elements.sort_by_key(|e| (e.z, e.id.0.clone()));
    }

    pub fn next_z(&self) -> i32 {
        self.elements.iter().map(|e| e.z).max().unwrap_or(0) + 1
    }

    pub fn content_bounds(&self) -> Option<Rect2> {
        if self.elements.is_empty() {
            return None;
        }
        let lookup = self.rect_lookup();
        let mut iter = self.elements.iter().map(|e| e.visual_bbox(&lookup)).filter(|r| r.w > 0.0 || r.h > 0.0);
        let mut acc = iter.next()?;
        for rect in iter {
            acc = acc.union(rect);
        }
        Some(acc)
    }
}
