use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::value::{FormatKind, StateValue};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TextExpr(pub String);

impl TextExpr {
    pub fn new(text: impl Into<String>) -> Self {
        Self(text.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for TextExpr {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for TextExpr {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExprSource(pub String);

impl ExprSource {
    pub fn new(expr: impl Into<String>) -> Self {
        Self(expr.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for ExprSource {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for ExprSource {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ValueExpr {
    Literal(StateValue),
    Expr(ExprSource),
    Template(TextExpr),
}

impl ValueExpr {
    pub fn literal(value: impl Into<StateValue>) -> Self {
        Self::Literal(value.into())
    }

    pub fn expr(source: impl Into<String>) -> Self {
        Self::Expr(ExprSource::new(source))
    }

    pub fn template(source: impl Into<String>) -> Self {
        Self::Template(TextExpr::new(source))
    }
}

impl Serialize for ValueExpr {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Literal(val) => match val {
                StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) => val.serialize(serializer),
                StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => {
                    let mut map = serializer.serialize_map(Some(1))?;
                    map.serialize_entry("literal", val)?;
                    map.end()
                }
            },
            Self::Expr(expr) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("expr", expr)?;
                map.end()
            }
            Self::Template(template) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("template", template)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ValueExpr {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ValueExprVisitor;

        impl<'de> Visitor<'de> for ValueExprVisitor {
            type Value = ValueExpr;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a literal value, expression string, template string, or tagged {expr|template|literal} object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(ValueExpr::Literal(StateValue::Null))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(ValueExpr::Literal(StateValue::Null))
            }

            fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
                Ok(ValueExpr::Literal(StateValue::Bool(v)))
            }

            fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
                Ok(ValueExpr::Literal(StateValue::Number(v as f64)))
            }

            fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
                Ok(ValueExpr::Literal(StateValue::Number(v as f64)))
            }

            fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if !v.is_finite() {
                    return Err(E::custom("non-finite number in ValueExpr"));
                }
                Ok(ValueExpr::Literal(StateValue::Number(if v == 0.0 { 0.0 } else { v })))
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                Ok(classify_string_value_expr(v.to_owned()))
            }

            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(classify_string_value_expr(v))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let Some(key) = map.next_key::<String>()? else {
                    return Err(de::Error::custom("empty ValueExpr object"));
                };
                let value = match key.as_str() {
                    "expr" => ValueExpr::Expr(map.next_value()?),
                    "template" => ValueExpr::Template(map.next_value()?),
                    "literal" => ValueExpr::Literal(map.next_value()?),
                    other => {
                        return Err(de::Error::unknown_field(other, &["expr", "template", "literal"]));
                    }
                };
                if let Some(extra) = map.next_key::<String>()? {
                    return Err(de::Error::custom(format!("unexpected extra key `{extra}` in ValueExpr")));
                }
                Ok(value)
            }
        }

        deserializer.deserialize_any(ValueExprVisitor)
    }
}

fn classify_string_value_expr(s: String) -> ValueExpr {
    if contains_unescaped_interpolation(&s) {
        ValueExpr::Template(TextExpr(s))
    } else {
        ValueExpr::Expr(ExprSource(s))
    }
}

fn contains_unescaped_interpolation(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'\\' && i + 2 < bytes.len() && bytes[i + 1] == b'$' && bytes[i + 2] == b'{' {
            i += 3;
            continue;
        }
        if bytes[i] == b'$' && bytes[i + 1] == b'{' {
            return true;
        }
        i += 1;
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackDirection {
    #[default]
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Start,
    Center,
    End,
    #[default]
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    #[default]
    Default,
    Muted,
    Accent,
    Positive,
    Warning,
    Danger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSize {
    Xs,
    Sm,
    #[default]
    Md,
    Lg,
    Xl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalloutKind {
    #[default]
    Info,
    Tip,
    Warning,
    Danger,
    Success,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartKind {
    Line,
    Area,
    Bar,
    StackedBar,
    Scatter,
    Pie,
    Donut,
    Sparkline,
}

impl ChartKind {
    pub fn as_spec_str(self) -> &'static str {
        match self {
            Self::Line => "line",
            Self::Area => "area",
            Self::Bar | Self::StackedBar => "bar",
            Self::Scatter => "scatter",
            Self::Pie => "pie",
            Self::Donut => "donut",
            Self::Sparkline => "sparkline",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabItem {
    pub id: String,
    pub label: TextExpr,
    #[serde(default)]
    pub children: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableColumn {
    pub key: String,
    pub label: TextExpr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<TextAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<FormatKind>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TableRows {
    Static(Vec<Vec<TextExpr>>),
    Expr(ExprSource),
}

impl Serialize for TableRows {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Static(rows) => rows.serialize(serializer),
            Self::Expr(expr) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("expr", expr)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for TableRows {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct TableRowsVisitor;

        impl<'de> Visitor<'de> for TableRowsVisitor {
            type Value = TableRows;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a list of static rows, an expression string, or {expr: \"...\"}")
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                Ok(TableRows::Expr(ExprSource::new(v)))
            }

            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(TableRows::Expr(ExprSource::new(v)))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut rows = Vec::new();
                while let Some(row) = seq.next_element::<Vec<TextExpr>>()? {
                    rows.push(row);
                }
                Ok(TableRows::Static(rows))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let Some(key) = map.next_key::<String>()? else {
                    return Err(de::Error::custom("empty TableRows object"));
                };
                if key != "expr" {
                    return Err(de::Error::unknown_field(&key, &["expr"]));
                }
                let expr: ExprSource = map.next_value()?;
                if let Some(extra) = map.next_key::<String>()? {
                    return Err(de::Error::custom(format!("unexpected extra key `{extra}` in TableRows")));
                }
                Ok(TableRows::Expr(expr))
            }
        }

        deserializer.deserialize_any(TableRowsVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: String,
    pub label: TextExpr,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CategoryBinding {
    Static(Vec<TextExpr>),
    Expr(ExprSource),
}

impl Serialize for CategoryBinding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Static(items) => items.serialize(serializer),
            Self::Expr(expr) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("expr", expr)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for CategoryBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct CategoryBindingVisitor;

        impl<'de> Visitor<'de> for CategoryBindingVisitor {
            type Value = CategoryBinding;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a list of category labels, an expression string, or {expr: \"...\"}")
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                Ok(CategoryBinding::Expr(ExprSource::new(v)))
            }

            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(CategoryBinding::Expr(ExprSource::new(v)))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<TextExpr>()? {
                    items.push(item);
                }
                Ok(CategoryBinding::Static(items))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let Some(key) = map.next_key::<String>()? else {
                    return Err(de::Error::custom("empty CategoryBinding object"));
                };
                if key != "expr" {
                    return Err(de::Error::unknown_field(&key, &["expr"]));
                }
                let expr: ExprSource = map.next_value()?;
                if let Some(extra) = map.next_key::<String>()? {
                    return Err(de::Error::custom(format!("unexpected extra key `{extra}` in CategoryBinding")));
                }
                Ok(CategoryBinding::Expr(expr))
            }
        }

        deserializer.deserialize_any(CategoryBindingVisitor)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SeriesValuesBinding {
    Static(Vec<Option<f64>>),
    Expr(ExprSource),
}

impl Serialize for SeriesValuesBinding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Static(values) => values.serialize(serializer),
            Self::Expr(expr) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("expr", expr)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for SeriesValuesBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SeriesValuesVisitor;

        impl<'de> Visitor<'de> for SeriesValuesVisitor {
            type Value = SeriesValuesBinding;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a list of numeric/null values, an expression string, or {expr: \"...\"}")
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                Ok(SeriesValuesBinding::Expr(ExprSource::new(v)))
            }

            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(SeriesValuesBinding::Expr(ExprSource::new(v)))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(item) = seq.next_element::<Option<f64>>()? {
                    if let Some(n) = item
                        && !n.is_finite()
                    {
                        return Err(de::Error::custom("non-finite number in chart series"));
                    }
                    values.push(item.map(|n| if n == 0.0 { 0.0 } else { n }));
                }
                Ok(SeriesValuesBinding::Static(values))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let Some(key) = map.next_key::<String>()? else {
                    return Err(de::Error::custom("empty SeriesValuesBinding object"));
                };
                if key != "expr" {
                    return Err(de::Error::unknown_field(&key, &["expr"]));
                }
                let expr: ExprSource = map.next_value()?;
                if let Some(extra) = map.next_key::<String>()? {
                    return Err(de::Error::custom(format!("unexpected extra key `{extra}` in SeriesValuesBinding")));
                }
                Ok(SeriesValuesBinding::Expr(expr))
            }
        }

        deserializer.deserialize_any(SeriesValuesVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartSeriesBinding {
    pub name: TextExpr,
    pub values: SeriesValuesBinding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ChartSource {
    Template {
        template: TextExpr,
    },
    Reactive {
        chart_kind: ChartKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x_label: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y_label: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y_format: Option<FormatKind>,
        categories: CategoryBinding,
        series: Vec<ChartSeriesBinding>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeKind {
    Stack {
        #[serde(default)]
        direction: StackDirection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align: Option<Align>,
        #[serde(default)]
        children: Vec<String>,
    },
    Grid {
        columns: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<f32>,
        #[serde(default)]
        children: Vec<String>,
    },
    Card {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle: Option<TextExpr>,
        #[serde(default)]
        children: Vec<String>,
    },
    Tabs {
        bind: String,
        tabs: Vec<TabItem>,
    },
    Divider {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
    },
    Text {
        value: TextExpr,
        #[serde(default)]
        tone: Tone,
        #[serde(default)]
        size: TextSize,
    },
    Markdown {
        text: TextExpr,
    },
    Metric {
        label: TextExpr,
        value: ValueExpr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delta: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<FormatKind>,
    },
    Badge {
        label: TextExpr,
        #[serde(default)]
        tone: Tone,
    },
    Progress {
        value: ValueExpr,
        max: ValueExpr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
    },
    Callout {
        #[serde(default, rename = "callout_kind")]
        callout_kind: CalloutKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<TextExpr>,
        body: TextExpr,
    },
    Table {
        columns: Vec<TableColumn>,
        rows: TableRows,
    },
    Slider {
        bind: String,
        label: TextExpr,
        min: f64,
        max: f64,
        step: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Switch {
        bind: String,
        label: TextExpr,
    },
    Select {
        bind: String,
        label: TextExpr,
        options: Vec<SelectOption>,
    },
    Chart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u32>,
        source: ChartSource,
    },
    Diagram {
        source: TextExpr,
    },
    Canvas {
        data: TextExpr,
    },
    CodeBlock {
        code: TextExpr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
}

impl NodeKind {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Stack { .. } => "stack",
            Self::Grid { .. } => "grid",
            Self::Card { .. } => "card",
            Self::Tabs { .. } => "tabs",
            Self::Divider { .. } => "divider",
            Self::Text { .. } => "text",
            Self::Markdown { .. } => "markdown",
            Self::Metric { .. } => "metric",
            Self::Badge { .. } => "badge",
            Self::Progress { .. } => "progress",
            Self::Callout { .. } => "callout",
            Self::Table { .. } => "table",
            Self::Slider { .. } => "slider",
            Self::Switch { .. } => "switch",
            Self::Select { .. } => "select",
            Self::Chart { .. } => "chart",
            Self::Diagram { .. } => "diagram",
            Self::Canvas { .. } => "canvas",
            Self::CodeBlock { .. } => "code_block",
        }
    }

    pub fn child_ids(&self) -> Vec<&str> {
        match self {
            Self::Stack { children, .. } | Self::Grid { children, .. } | Self::Card { children, .. } => children.iter().map(String::as_str).collect(),
            Self::Tabs { tabs, .. } => tabs.iter().flat_map(|tab| tab.children.iter().map(String::as_str)).collect(),
            Self::Divider { .. }
            | Self::Text { .. }
            | Self::Markdown { .. }
            | Self::Metric { .. }
            | Self::Badge { .. }
            | Self::Progress { .. }
            | Self::Callout { .. }
            | Self::Table { .. }
            | Self::Slider { .. }
            | Self::Switch { .. }
            | Self::Select { .. }
            | Self::Chart { .. }
            | Self::Diagram { .. }
            | Self::Canvas { .. }
            | Self::CodeBlock { .. } => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenUiNode {
    pub id: String,
    #[serde(default)]
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<ExprSource>,
    #[serde(flatten)]
    pub kind: NodeKind,
}

impl GenUiNode {
    pub fn new(id: impl Into<String>, kind: NodeKind) -> Self {
        Self {
            id: id.into(),
            generation: 0,
            visible: None,
            kind,
        }
    }

    pub fn with_visible(mut self, expr: impl Into<String>) -> Self {
        self.visible = Some(ExprSource::new(expr));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct GenUiSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(default)]
    pub state: BTreeMap<String, StateValue>,
    #[serde(default)]
    pub nodes: Vec<GenUiNode>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum FieldPatch<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<T> FieldPatch<T> {
    pub fn is_keep(&self) -> bool {
        matches!(self, Self::Keep)
    }

    pub fn apply(self, target: &mut Option<T>) {
        match self {
            Self::Keep => {}
            Self::Clear => *target = None,
            Self::Set(val) => *target = Some(val),
        }
    }
}

impl<T: Serialize> Serialize for FieldPatch<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Keep | Self::Clear => serializer.serialize_none(),
            Self::Set(v) => serializer.serialize_some(v),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for FieldPatch<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match Option::<T>::deserialize(deserializer)? {
            Some(v) => Ok(Self::Set(v)),
            None => Ok(Self::Clear),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PropsPatch {
    Stack {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<StackDirection>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        gap: FieldPatch<f32>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        align: FieldPatch<Align>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        children: Option<Vec<String>>,
    },
    Grid {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        columns: Option<u16>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        gap: FieldPatch<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        children: Option<Vec<String>>,
    },
    Card {
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        title: FieldPatch<TextExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        subtitle: FieldPatch<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        children: Option<Vec<String>>,
    },
    Tabs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tabs: Option<Vec<TabItem>>,
    },
    Divider {
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        label: FieldPatch<TextExpr>,
    },
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<Tone>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<TextSize>,
    },
    Markdown {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<TextExpr>,
    },
    Metric {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<ValueExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        delta: FieldPatch<TextExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        format: FieldPatch<FormatKind>,
    },
    Badge {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<Tone>,
    },
    Progress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<ValueExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<ValueExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        label: FieldPatch<TextExpr>,
    },
    Callout {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        callout_kind: Option<CalloutKind>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        title: FieldPatch<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<TextExpr>,
    },
    Table {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        columns: Option<Vec<TableColumn>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<TableRows>,
    },
    Slider {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<f64>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        unit: FieldPatch<String>,
    },
    Switch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
    },
    Select {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        options: Option<Vec<SelectOption>>,
    },
    Chart {
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        title: FieldPatch<TextExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        subtitle: FieldPatch<TextExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        width: FieldPatch<u32>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        height: FieldPatch<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<ChartSource>,
    },
    Diagram {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<TextExpr>,
    },
    Canvas {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<TextExpr>,
    },
    CodeBlock {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<TextExpr>,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        language: FieldPatch<String>,
    },
}

impl PropsPatch {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Stack { .. } => "stack",
            Self::Grid { .. } => "grid",
            Self::Card { .. } => "card",
            Self::Tabs { .. } => "tabs",
            Self::Divider { .. } => "divider",
            Self::Text { .. } => "text",
            Self::Markdown { .. } => "markdown",
            Self::Metric { .. } => "metric",
            Self::Badge { .. } => "badge",
            Self::Progress { .. } => "progress",
            Self::Callout { .. } => "callout",
            Self::Table { .. } => "table",
            Self::Slider { .. } => "slider",
            Self::Switch { .. } => "switch",
            Self::Select { .. } => "select",
            Self::Chart { .. } => "chart",
            Self::Diagram { .. } => "diagram",
            Self::Canvas { .. } => "canvas",
            Self::CodeBlock { .. } => "code_block",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PatchOp {
    Title {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle: Option<String>,
    },
    StateInit {
        state: BTreeMap<String, StateValue>,
        #[serde(default)]
        overwrite: bool,
    },
    SetNode {
        node: Box<GenUiNode>,
        #[serde(default)]
        root: bool,
    },
    AppendChild {
        parent_id: String,
        child_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node: Option<Box<GenUiNode>>,
    },
    UpdateProps {
        id: String,
        #[serde(default, skip_serializing_if = "FieldPatch::is_keep")]
        visible: FieldPatch<ExprSource>,
        props: Box<PropsPatch>,
    },
    RemoveNode {
        id: String,
        #[serde(default)]
        recursive: bool,
    },
    Done,
}
