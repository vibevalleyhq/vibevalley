use std::borrow::Borrow;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::engine::canvas::extensions::ExtensionFields;
use crate::engine::canvas::geometry::{Rect, Vec2};
use crate::engine::canvas::validate::{ValidationReport, validate};

#[derive(Debug, thiserror::Error)]
pub enum ColorError {
    #[error("invalid canvas color {0:?}: expected preset \"1\"..\"6\" or hex \"#RGB\"/\"#RGBA\"/\"#RRGGBB\"/\"#RRGGBBAA\"")]
    Invalid(String),
}

#[derive(Debug, thiserror::Error)]
pub enum CanvasError {
    #[error("json codec error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("canvas spec validation failed: {0}")]
    Validation(#[from] ValidationReport),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(String);

impl NodeId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for NodeId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Borrow<str> for NodeId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl From<&str> for NodeId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for NodeId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl PartialEq<str> for NodeId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<&str> for NodeId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EdgeId(String);

impl EdgeId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for EdgeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for EdgeId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Borrow<str> for EdgeId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl From<&str> for EdgeId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for EdgeId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl PartialEq<str> for EdgeId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<&str> for EdgeId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

/// Integer pixel bounds mandated by JSON Canvas 1.0 (`x`, `y`, `width`, `height`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeBounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl NodeBounds {
    pub const fn new(x: i64, y: i64, width: i64, height: i64) -> Self {
        Self { x, y, width, height }
    }

    pub const fn is_positive(self) -> bool {
        self.width > 0 && self.height > 0
    }

    pub const fn right(self) -> i64 {
        self.x.saturating_add(self.width)
    }

    pub const fn bottom(self) -> i64 {
        self.y.saturating_add(self.height)
    }

    pub fn center_x(self) -> i64 {
        self.x.saturating_add(self.width / 2)
    }

    pub fn center_y(self) -> i64 {
        self.y.saturating_add(self.height / 2)
    }

    pub fn to_rect(self) -> Rect {
        Rect {
            x: self.x as f64,
            y: self.y as f64,
            width: self.width as f64,
            height: self.height as f64,
        }
    }

    pub fn contains_bounds(self, other: NodeBounds) -> bool {
        let self_right = i128::from(self.x) + i128::from(self.width);
        let self_bottom = i128::from(self.y) + i128::from(self.height);
        let other_right = i128::from(other.x) + i128::from(other.width);
        let other_bottom = i128::from(other.y) + i128::from(other.height);
        i128::from(other.x) >= i128::from(self.x) && i128::from(other.y) >= i128::from(self.y) && other_right <= self_right && other_bottom <= self_bottom
    }

    pub fn intersects_bounds(self, other: NodeBounds) -> bool {
        let self_right = i128::from(self.x) + i128::from(self.width);
        let self_bottom = i128::from(self.y) + i128::from(self.height);
        let other_right = i128::from(other.x) + i128::from(other.width);
        let other_bottom = i128::from(other.y) + i128::from(other.height);
        i128::from(self.x) < other_right && self_right > i128::from(other.x) && i128::from(self.y) < other_bottom && self_bottom > i128::from(other.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba8 {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    pub const fn from_hex_u32(rgb: u32) -> Self {
        Self::rgb(((rgb >> 16) & 0xff) as u8, ((rgb >> 8) & 0xff) as u8, (rgb & 0xff) as u8)
    }

    pub fn to_hex_rgb(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    pub fn opacity(self) -> f64 {
        f64::from(self.a) / 255.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PresetColor {
    Red,
    Orange,
    Yellow,
    Green,
    Cyan,
    Purple,
}

impl PresetColor {
    pub const ALL: [PresetColor; 6] = [
        PresetColor::Red,
        PresetColor::Orange,
        PresetColor::Yellow,
        PresetColor::Green,
        PresetColor::Cyan,
        PresetColor::Purple,
    ];

    pub const fn as_code(self) -> &'static str {
        match self {
            PresetColor::Red => "1",
            PresetColor::Orange => "2",
            PresetColor::Yellow => "3",
            PresetColor::Green => "4",
            PresetColor::Cyan => "5",
            PresetColor::Purple => "6",
        }
    }

    pub const fn index(self) -> usize {
        match self {
            PresetColor::Red => 0,
            PresetColor::Orange => 1,
            PresetColor::Yellow => 2,
            PresetColor::Green => 3,
            PresetColor::Cyan => 4,
            PresetColor::Purple => 5,
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "1" => Some(PresetColor::Red),
            "2" => Some(PresetColor::Orange),
            "3" => Some(PresetColor::Yellow),
            "4" => Some(PresetColor::Green),
            "5" => Some(PresetColor::Cyan),
            "6" => Some(PresetColor::Purple),
            _ => None,
        }
    }
}

impl fmt::Display for PresetColor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_code())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CanvasColor {
    Preset(PresetColor),
    Hex(String),
}

impl CanvasColor {
    pub const fn preset(color: PresetColor) -> Self {
        CanvasColor::Preset(color)
    }

    pub fn hex(value: impl Into<String>) -> Result<Self, ColorError> {
        let value = value.into();
        if parse_hex_rgba(&value).is_some() {
            Ok(CanvasColor::Hex(value))
        } else {
            Err(ColorError::Invalid(value))
        }
    }

    pub fn is_valid(&self) -> bool {
        match self {
            CanvasColor::Preset(_) => true,
            CanvasColor::Hex(s) => parse_hex_rgba(s).is_some(),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            CanvasColor::Preset(preset) => preset.as_code(),
            CanvasColor::Hex(hex) => hex.as_str(),
        }
    }

    pub fn to_hex_rgba(&self) -> Option<Rgba8> {
        match self {
            CanvasColor::Preset(_) => None,
            CanvasColor::Hex(hex) => parse_hex_rgba(hex),
        }
    }
}

impl FromStr for CanvasColor {
    type Err = ColorError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if let Some(preset) = PresetColor::from_code(s) {
            return Ok(CanvasColor::Preset(preset));
        }
        if parse_hex_rgba(s).is_some() {
            return Ok(CanvasColor::Hex(s.to_owned()));
        }
        Err(ColorError::Invalid(s.to_owned()))
    }
}

impl fmt::Display for CanvasColor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for CanvasColor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CanvasColor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        CanvasColor::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

pub fn parse_hex_rgba(input: &str) -> Option<Rgba8> {
    let hex = input.strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let hex_nibble = |b: u8| -> u8 {
        match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => unreachable!("verified ascii hex digit"),
        }
    };
    let bytes = hex.as_bytes();
    match bytes.len() {
        3 => {
            let r = hex_nibble(bytes[0]) * 17;
            let g = hex_nibble(bytes[1]) * 17;
            let b = hex_nibble(bytes[2]) * 17;
            Some(Rgba8::rgb(r, g, b))
        }
        4 => {
            let r = hex_nibble(bytes[0]) * 17;
            let g = hex_nibble(bytes[1]) * 17;
            let b = hex_nibble(bytes[2]) * 17;
            let a = hex_nibble(bytes[3]) * 17;
            Some(Rgba8::rgba(r, g, b, a))
        }
        6 => {
            let r = (hex_nibble(bytes[0]) << 4) | hex_nibble(bytes[1]);
            let g = (hex_nibble(bytes[2]) << 4) | hex_nibble(bytes[3]);
            let b = (hex_nibble(bytes[4]) << 4) | hex_nibble(bytes[5]);
            Some(Rgba8::rgb(r, g, b))
        }
        8 => {
            let r = (hex_nibble(bytes[0]) << 4) | hex_nibble(bytes[1]);
            let g = (hex_nibble(bytes[2]) << 4) | hex_nibble(bytes[3]);
            let b = (hex_nibble(bytes[4]) << 4) | hex_nibble(bytes[5]);
            let a = (hex_nibble(bytes[6]) << 4) | hex_nibble(bytes[7]);
            Some(Rgba8::rgba(r, g, b, a))
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    pub const ALL: [Side; 4] = [Side::Top, Side::Right, Side::Bottom, Side::Left];

    pub const fn opposite(self) -> Side {
        match self {
            Side::Top => Side::Bottom,
            Side::Right => Side::Left,
            Side::Bottom => Side::Top,
            Side::Left => Side::Right,
        }
    }

    pub const fn clockwise(self) -> Side {
        match self {
            Side::Top => Side::Right,
            Side::Right => Side::Bottom,
            Side::Bottom => Side::Left,
            Side::Left => Side::Top,
        }
    }

    pub const fn normal(self) -> Vec2 {
        match self {
            Side::Top => Vec2 { x: 0.0, y: -1.0 },
            Side::Right => Vec2 { x: 1.0, y: 0.0 },
            Side::Bottom => Vec2 { x: 0.0, y: 1.0 },
            Side::Left => Vec2 { x: -1.0, y: 0.0 },
        }
    }

    pub const fn is_horizontal(self) -> bool {
        match self {
            Side::Left | Side::Right => true,
            Side::Top | Side::Bottom => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum End {
    None,
    Arrow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundStyle {
    Cover,
    Ratio,
    Repeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeKind {
    Text,
    File,
    Link,
    Group,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextNode {
    pub id: NodeId,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CanvasColor>,
    pub text: String,
    #[serde(flatten, default)]
    pub extensions: ExtensionFields,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub id: NodeId,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CanvasColor>,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
    #[serde(flatten, default)]
    pub extensions: ExtensionFields,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkNode {
    pub id: NodeId,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CanvasColor>,
    pub url: String,
    #[serde(flatten, default)]
    pub extensions: ExtensionFields,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupNode {
    pub id: NodeId,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CanvasColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(rename = "backgroundStyle", default, skip_serializing_if = "Option::is_none")]
    pub background_style: Option<BackgroundStyle>,
    #[serde(flatten, default)]
    pub extensions: ExtensionFields,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Node {
    Text(TextNode),
    File(FileNode),
    Link(LinkNode),
    Group(GroupNode),
}

impl Node {
    pub fn text(id: impl Into<NodeId>, bounds: NodeBounds, text: impl Into<String>) -> Self {
        Node::Text(TextNode {
            id: id.into(),
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            color: None,
            text: text.into(),
            extensions: ExtensionFields::new(),
        })
    }

    pub fn file(id: impl Into<NodeId>, bounds: NodeBounds, file: impl Into<String>) -> Self {
        Node::File(FileNode {
            id: id.into(),
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            color: None,
            file: file.into(),
            subpath: None,
            extensions: ExtensionFields::new(),
        })
    }

    pub fn link(id: impl Into<NodeId>, bounds: NodeBounds, url: impl Into<String>) -> Self {
        Node::Link(LinkNode {
            id: id.into(),
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            color: None,
            url: url.into(),
            extensions: ExtensionFields::new(),
        })
    }

    pub fn group(id: impl Into<NodeId>, bounds: NodeBounds, label: Option<String>) -> Self {
        Node::Group(GroupNode {
            id: id.into(),
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            color: None,
            label,
            background: None,
            background_style: None,
            extensions: ExtensionFields::new(),
        })
    }

    pub fn with_color(mut self, color: CanvasColor) -> Self {
        self.set_color(Some(color));
        self
    }

    pub fn id(&self) -> &NodeId {
        match self {
            Node::Text(n) => &n.id,
            Node::File(n) => &n.id,
            Node::Link(n) => &n.id,
            Node::Group(n) => &n.id,
        }
    }

    pub fn kind(&self) -> NodeKind {
        match self {
            Node::Text(_) => NodeKind::Text,
            Node::File(_) => NodeKind::File,
            Node::Link(_) => NodeKind::Link,
            Node::Group(_) => NodeKind::Group,
        }
    }

    pub fn is_group(&self) -> bool {
        match self {
            Node::Group(_) => true,
            Node::Text(_) | Node::File(_) | Node::Link(_) => false,
        }
    }

    pub fn x(&self) -> i64 {
        match self {
            Node::Text(n) => n.x,
            Node::File(n) => n.x,
            Node::Link(n) => n.x,
            Node::Group(n) => n.x,
        }
    }

    pub fn y(&self) -> i64 {
        match self {
            Node::Text(n) => n.y,
            Node::File(n) => n.y,
            Node::Link(n) => n.y,
            Node::Group(n) => n.y,
        }
    }

    pub fn width(&self) -> i64 {
        match self {
            Node::Text(n) => n.width,
            Node::File(n) => n.width,
            Node::Link(n) => n.width,
            Node::Group(n) => n.width,
        }
    }

    pub fn height(&self) -> i64 {
        match self {
            Node::Text(n) => n.height,
            Node::File(n) => n.height,
            Node::Link(n) => n.height,
            Node::Group(n) => n.height,
        }
    }

    pub fn bounds(&self) -> NodeBounds {
        NodeBounds {
            x: self.x(),
            y: self.y(),
            width: self.width(),
            height: self.height(),
        }
    }

    pub fn rect(&self) -> Rect {
        self.bounds().to_rect()
    }

    pub fn set_bounds(&mut self, bounds: NodeBounds) {
        match self {
            Node::Text(n) => {
                n.x = bounds.x;
                n.y = bounds.y;
                n.width = bounds.width;
                n.height = bounds.height;
            }
            Node::File(n) => {
                n.x = bounds.x;
                n.y = bounds.y;
                n.width = bounds.width;
                n.height = bounds.height;
            }
            Node::Link(n) => {
                n.x = bounds.x;
                n.y = bounds.y;
                n.width = bounds.width;
                n.height = bounds.height;
            }
            Node::Group(n) => {
                n.x = bounds.x;
                n.y = bounds.y;
                n.width = bounds.width;
                n.height = bounds.height;
            }
        }
    }

    pub fn translate(&mut self, dx: i64, dy: i64) {
        let mut b = self.bounds();
        b.x = b.x.saturating_add(dx);
        b.y = b.y.saturating_add(dy);
        self.set_bounds(b);
    }

    pub fn color(&self) -> Option<&CanvasColor> {
        match self {
            Node::Text(n) => n.color.as_ref(),
            Node::File(n) => n.color.as_ref(),
            Node::Link(n) => n.color.as_ref(),
            Node::Group(n) => n.color.as_ref(),
        }
    }

    pub fn set_color(&mut self, color: Option<CanvasColor>) {
        match self {
            Node::Text(n) => n.color = color,
            Node::File(n) => n.color = color,
            Node::Link(n) => n.color = color,
            Node::Group(n) => n.color = color,
        }
    }

    pub fn extensions(&self) -> &ExtensionFields {
        match self {
            Node::Text(n) => &n.extensions,
            Node::File(n) => &n.extensions,
            Node::Link(n) => &n.extensions,
            Node::Group(n) => &n.extensions,
        }
    }

    pub fn extensions_mut(&mut self) -> &mut ExtensionFields {
        match self {
            Node::Text(n) => &mut n.extensions,
            Node::File(n) => &mut n.extensions,
            Node::Link(n) => &mut n.extensions,
            Node::Group(n) => &mut n.extensions,
        }
    }

    pub fn as_text(&self) -> Option<&TextNode> {
        match self {
            Node::Text(n) => Some(n),
            Node::File(_) | Node::Link(_) | Node::Group(_) => None,
        }
    }

    pub fn as_file(&self) -> Option<&FileNode> {
        match self {
            Node::File(n) => Some(n),
            Node::Text(_) | Node::Link(_) | Node::Group(_) => None,
        }
    }

    pub fn as_link(&self) -> Option<&LinkNode> {
        match self {
            Node::Link(n) => Some(n),
            Node::Text(_) | Node::File(_) | Node::Group(_) => None,
        }
    }

    pub fn as_group(&self) -> Option<&GroupNode> {
        match self {
            Node::Group(n) => Some(n),
            Node::Text(_) | Node::File(_) | Node::Link(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: EdgeId,
    pub from_node: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_side: Option<Side>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_end: Option<End>,
    pub to_node: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_side: Option<Side>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_end: Option<End>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CanvasColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten, default)]
    pub extensions: ExtensionFields,
}

impl Edge {
    pub fn new(id: impl Into<EdgeId>, from_node: impl Into<NodeId>, to_node: impl Into<NodeId>) -> Self {
        Self {
            id: id.into(),
            from_node: from_node.into(),
            from_side: None,
            from_end: None,
            to_node: to_node.into(),
            to_side: None,
            to_end: None,
            color: None,
            label: None,
            extensions: ExtensionFields::new(),
        }
    }

    pub fn with_sides(mut self, from_side: Option<Side>, to_side: Option<Side>) -> Self {
        self.from_side = from_side;
        self.to_side = to_side;
        self
    }

    pub fn with_ends(mut self, from_end: Option<End>, to_end: Option<End>) -> Self {
        self.from_end = from_end;
        self.to_end = to_end;
        self
    }

    pub fn with_color(mut self, color: CanvasColor) -> Self {
        self.color = Some(color);
        self
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// JSON Canvas 1.0 default for `fromEnd` is `none`.
    pub fn effective_from_end(&self) -> End {
        self.from_end.unwrap_or(End::None)
    }

    /// JSON Canvas 1.0 default for `toEnd` is `arrow`.
    pub fn effective_to_end(&self) -> End {
        self.to_end.unwrap_or(End::Arrow)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Canvas {
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(flatten, default)]
    pub extensions: ExtensionFields,
}

impl Canvas {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decodes a JSON Canvas 1.0 document and validates all specification invariants.
    pub fn from_json_str(input: &str) -> Result<Self, CanvasError> {
        let canvas = Self::from_json_str_unchecked(input)?;
        validate(&canvas)?;
        Ok(canvas)
    }

    /// Decodes a JSON Canvas document without running semantic spec validation,
    /// allowing diagnostic callers to inspect all issues via [`Canvas::validate`].
    pub fn from_json_str_unchecked(input: &str) -> Result<Self, CanvasError> {
        let canvas: Canvas = serde_json::from_str(input)?;
        Ok(canvas)
    }

    pub fn to_json_string(&self) -> Result<String, CanvasError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn to_json_string_pretty(&self) -> Result<String, CanvasError> {
        Ok(serde_json::to_string_pretty(self)?)
    }

    pub fn validate(&self) -> Result<(), ValidationReport> {
        validate(self)
    }

    pub fn strip_extensions(&mut self) {
        self.extensions.clear();
        for node in &mut self.nodes {
            node.extensions_mut().clear();
        }
        for edge in &mut self.edges {
            edge.extensions.clear();
        }
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id() == id)
    }

    pub fn node_mut(&mut self, id: &NodeId) -> Option<&mut Node> {
        self.nodes.iter_mut().find(|n| n.id() == id)
    }

    pub fn node_index(&self, id: &NodeId) -> Option<usize> {
        self.nodes.iter().position(|n| n.id() == id)
    }

    pub fn edge(&self, id: &EdgeId) -> Option<&Edge> {
        self.edges.iter().find(|e| &e.id == id)
    }

    pub fn edge_mut(&mut self, id: &EdgeId) -> Option<&mut Edge> {
        self.edges.iter_mut().find(|e| &e.id == id)
    }

    pub fn edge_index(&self, id: &EdgeId) -> Option<usize> {
        self.edges.iter().position(|e| &e.id == id)
    }

    pub fn edges_for_node(&self, id: &NodeId) -> Vec<&Edge> {
        self.edges.iter().filter(|e| &e.from_node == id || &e.to_node == id).collect()
    }

    pub fn content_bounds(&self) -> Option<Rect> {
        let mut iter = self.nodes.iter().map(Node::rect);
        let first = iter.next()?;
        Some(iter.fold(first, Rect::union))
    }

    pub fn nodes_bounds(&self, ids: &[NodeId]) -> Option<Rect> {
        let mut bounds: Option<Rect> = None;
        for id in ids {
            if let Some(node) = self.node(id) {
                let rect = node.rect();
                bounds = Some(match bounds {
                    Some(existing) => existing.union(rect),
                    None => rect,
                });
            }
        }
        bounds
    }
}
