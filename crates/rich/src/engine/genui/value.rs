use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::engine::genui::error::GenUiError;

#[derive(Debug, Clone, PartialEq)]
pub enum StateValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<StateValue>),
    Record(Vec<(String, StateValue)>),
}

impl StateValue {
    pub fn number(value: f64) -> Result<Self, GenUiError> {
        if !value.is_finite() {
            return Err(GenUiError::NonFiniteResult {
                context: "state number".to_owned(),
            });
        }
        Ok(Self::Number(normalize_zero(value)))
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "bool",
            Self::Number(_) => "number",
            Self::Text(_) => "text",
            Self::List(_) => "list",
            Self::Record(_) => "record",
        }
    }

    pub fn is_truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::Text(s) => !s.is_empty(),
            Self::List(items) => !items.is_empty(),
            Self::Record(entries) => !entries.is_empty(),
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            Self::Null | Self::Number(_) | Self::Text(_) | Self::List(_) | Self::Record(_) => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            Self::Null | Self::Bool(_) | Self::Text(_) | Self::List(_) | Self::Record(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s.as_str()),
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::List(_) | Self::Record(_) => None,
        }
    }

    pub fn as_list(&self) -> Option<&[StateValue]> {
        match self {
            Self::List(items) => Some(items.as_slice()),
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::Text(_) | Self::Record(_) => None,
        }
    }

    pub fn as_record(&self) -> Option<&[(String, StateValue)]> {
        match self {
            Self::Record(entries) => Some(entries.as_slice()),
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::Text(_) | Self::List(_) => None,
        }
    }

    pub fn get_field(&self, key: &str) -> Option<&StateValue> {
        match self {
            Self::Record(entries) => entries.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::Text(_) | Self::List(_) => None,
        }
    }

    pub fn structural_eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::Number(a), Self::Number(b)) => a == b,
            (Self::Text(a), Self::Text(b)) => a == b,
            (Self::List(a), Self::List(b)) => a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.structural_eq(y)),
            (Self::Record(a), Self::Record(b)) => {
                if a.len() != b.len() {
                    return false;
                }
                let mut matched = vec![false; b.len()];
                a.iter().all(|(k, v)| {
                    if let Some(pos) = b.iter().enumerate().position(|(i, (bk, bv))| !matched[i] && bk == k && v.structural_eq(bv)) {
                        matched[pos] = true;
                        true
                    } else {
                        false
                    }
                })
            }
            (Self::Null, Self::Bool(_) | Self::Number(_) | Self::Text(_) | Self::List(_) | Self::Record(_))
            | (Self::Bool(_), Self::Null | Self::Number(_) | Self::Text(_) | Self::List(_) | Self::Record(_))
            | (Self::Number(_), Self::Null | Self::Bool(_) | Self::Text(_) | Self::List(_) | Self::Record(_))
            | (Self::Text(_), Self::Null | Self::Bool(_) | Self::Number(_) | Self::List(_) | Self::Record(_))
            | (Self::List(_), Self::Null | Self::Bool(_) | Self::Number(_) | Self::Text(_) | Self::Record(_))
            | (Self::Record(_), Self::Null | Self::Bool(_) | Self::Number(_) | Self::Text(_) | Self::List(_)) => false,
        }
    }

    pub fn to_display_string(&self) -> String {
        match self {
            Self::Null => String::new(),
            Self::Bool(b) => {
                if *b {
                    "true".to_owned()
                } else {
                    "false".to_owned()
                }
            }
            Self::Number(n) => format_plain_number(*n),
            Self::Text(s) => s.clone(),
            Self::List(items) => {
                let parts: Vec<String> = items.iter().map(Self::to_display_string).collect();
                format!("[{}]", parts.join(", "))
            }
            Self::Record(entries) => {
                let parts: Vec<String> = entries.iter().map(|(k, v)| format!("{k}: {}", v.to_display_string())).collect();
                format!("{{{}}}", parts.join(", "))
            }
        }
    }
}

impl From<bool> for StateValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<f64> for StateValue {
    fn from(value: f64) -> Self {
        Self::Number(normalize_zero(value))
    }
}

impl From<i64> for StateValue {
    fn from(value: i64) -> Self {
        Self::Number(value as f64)
    }
}

impl From<i32> for StateValue {
    fn from(value: i32) -> Self {
        Self::Number(f64::from(value))
    }
}

impl From<&str> for StateValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for StateValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<Vec<StateValue>> for StateValue {
    fn from(value: Vec<StateValue>) -> Self {
        Self::List(value)
    }
}

impl Serialize for StateValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(b) => serializer.serialize_bool(*b),
            Self::Number(n) => {
                if !n.is_finite() {
                    return Err(serde::ser::Error::custom("cannot serialize non-finite number in StateValue"));
                }
                let v = normalize_zero(*n);
                if v.fract() == 0.0 && (-9_007_199_254_740_992.0..=9_007_199_254_740_992.0).contains(&v) {
                    serializer.serialize_i64(v as i64)
                } else {
                    serializer.serialize_f64(v)
                }
            }
            Self::Text(s) => serializer.serialize_str(s),
            Self::List(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Record(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (k, v) in entries {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for StateValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct StateValueVisitor;

        impl<'de> Visitor<'de> for StateValueVisitor {
            type Value = StateValue;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("null, boolean, finite number, string, list, or object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(StateValue::Null)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(StateValue::Null)
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StateValue::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StateValue::Number(value as f64))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StateValue::Number(value as f64))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if !value.is_finite() {
                    return Err(E::custom("non-finite floating point value"));
                }
                Ok(StateValue::Number(normalize_zero(value)))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(StateValue::Text(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(StateValue::Text(value))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(1024));
                while let Some(elem) = seq.next_element()? {
                    items.push(elem);
                }
                Ok(StateValue::List(items))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0).min(1024));
                while let Some((k, v)) = map.next_entry::<String, StateValue>()? {
                    entries.push((k, v));
                }
                Ok(StateValue::Record(entries))
            }
        }

        deserializer.deserialize_any(StateValueVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct StateStore {
    values: BTreeMap<String, StateValue>,
}

impl StateStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_map(values: BTreeMap<String, StateValue>) -> Self {
        Self { values }
    }

    pub fn get(&self, key: &str) -> Option<&StateValue> {
        self.values.get(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    pub fn set(&mut self, key: impl Into<String>, value: StateValue) -> bool {
        let key = key.into();
        if let Some(existing) = self.values.get(&key)
            && existing.structural_eq(&value)
        {
            return false;
        }
        self.values.insert(key, value);
        true
    }

    pub fn remove(&mut self, key: &str) -> Option<StateValue> {
        self.values.remove(key)
    }

    pub fn entries(&self) -> &BTreeMap<String, StateValue> {
        &self.values
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormatKind {
    Number,
    Integer,
    Currency,
    /// Expects a ratio (e.g. `0.125` renders as `"12.5%"`).
    Percent,
    /// Expects an already-scaled percentage (e.g. `12.5` renders as `"12.5%"`).
    PercentPoints,
    Compact,
    Decimal,
    /// Expects a duration in seconds.
    Duration,
}

impl FormatKind {
    pub fn parse(name: &str) -> Result<Self, GenUiError> {
        match name {
            "number" => Ok(Self::Number),
            "integer" | "int" => Ok(Self::Integer),
            "currency" | "usd" => Ok(Self::Currency),
            "percent" | "pct" => Ok(Self::Percent),
            "percent_points" | "percent_raw" => Ok(Self::PercentPoints),
            "compact" => Ok(Self::Compact),
            "decimal" | "fixed" => Ok(Self::Decimal),
            "duration" => Ok(Self::Duration),
            _ => Err(GenUiError::UnknownFormat { kind: name.to_owned() }),
        }
    }

    pub fn as_chart_format(self) -> &'static str {
        match self {
            Self::Number | Self::Integer | Self::Decimal => "number",
            Self::Currency => "currency",
            Self::Percent | Self::PercentPoints => "percent",
            Self::Compact => "compact",
            Self::Duration => "duration",
        }
    }
}

pub fn format_value(value: &StateValue, kind: FormatKind, precision: Option<u8>) -> Result<String, GenUiError> {
    let number = match value {
        StateValue::Number(n) => {
            if !n.is_finite() {
                return Err(GenUiError::NonFiniteResult { context: "format".to_owned() });
            }
            normalize_zero(*n)
        }
        StateValue::Null => return Ok("—".to_owned()),
        StateValue::Text(s) => return Ok(s.clone()),
        StateValue::Bool(_) | StateValue::List(_) | StateValue::Record(_) => {
            return Err(GenUiError::TypeMismatch {
                context: "format".to_owned(),
                expected: "number".to_owned(),
                actual: value.type_name().to_owned(),
            });
        }
    };

    Ok(format_number(number, kind, precision))
}

pub fn format_number(value: f64, kind: FormatKind, precision: Option<u8>) -> String {
    let clamped_precision = precision.map(|p| usize::from(p.min(8)));
    match kind {
        FormatKind::Number => {
            let digits = clamped_precision.unwrap_or(2);
            format_grouped_trimmed(value, digits, precision.is_some())
        }
        FormatKind::Integer => format_grouped_trimmed(value.round(), 0, true),
        FormatKind::Decimal => {
            let digits = clamped_precision.unwrap_or(2);
            format_grouped_trimmed(value, digits, true)
        }
        FormatKind::Currency => {
            let digits = clamped_precision.unwrap_or(2);
            let rounded = round_to(value, digits);
            let negative = rounded < 0.0;
            let body = format_grouped_trimmed(rounded.abs(), digits, true);
            if negative { format!("-${body}") } else { format!("${body}") }
        }
        FormatKind::Percent => {
            let digits = clamped_precision.unwrap_or(1);
            let pct = value * 100.0;
            format!("{}%", format_grouped_trimmed(pct, digits, precision.is_some()))
        }
        FormatKind::PercentPoints => {
            let digits = clamped_precision.unwrap_or(1);
            format!("{}%", format_grouped_trimmed(value, digits, precision.is_some()))
        }
        FormatKind::Compact => format_compact(value, clamped_precision),
        FormatKind::Duration => format_duration(value),
    }
}

pub(crate) fn normalize_zero(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

fn round_to(value: f64, digits: usize) -> f64 {
    if digits == 0 {
        return normalize_zero(value.round());
    }
    let factor = 10_f64.powi(digits as i32);
    let scaled = value * factor;
    if scaled.is_finite() {
        normalize_zero(scaled.round() / factor)
    } else {
        normalize_zero(value)
    }
}

fn format_plain_number(value: f64) -> String {
    let v = normalize_zero(value);
    if v.fract() == 0.0 && (-9_007_199_254_740_992.0..=9_007_199_254_740_992.0).contains(&v) {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn format_grouped_trimmed(value: f64, digits: usize, keep_trailing_zeros: bool) -> String {
    let rounded = round_to(value, digits);
    let negative = rounded < 0.0;
    let abs = rounded.abs();
    let formatted = format!("{abs:.digits$}");
    let (int_part, frac_part) = match formatted.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (formatted.as_str(), None),
    };
    let grouped = insert_thousands_sep(int_part);
    let sign = if negative { "-" } else { "" };
    match frac_part {
        Some(frac) => {
            let trimmed = if keep_trailing_zeros { frac } else { frac.trim_end_matches('0') };
            if trimmed.is_empty() {
                format!("{sign}{grouped}")
            } else {
                format!("{sign}{grouped}.{trimmed}")
            }
        }
        None => format!("{sign}{grouped}"),
    }
}

fn insert_thousands_sep(digits: &str) -> String {
    let len = digits.len();
    if len <= 3 {
        return digits.to_owned();
    }
    let mut out = String::with_capacity(len + len / 3);
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (len - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn format_compact(value: f64, precision: Option<usize>) -> String {
    let abs = value.abs();
    let (divisor, suffix) = if abs >= 1_000_000_000_000.0 {
        (1_000_000_000_000.0, "T")
    } else if abs >= 1_000_000_000.0 {
        (1_000_000_000.0, "B")
    } else if abs >= 1_000_000.0 {
        (1_000_000.0, "M")
    } else if abs >= 1_000.0 {
        (1_000.0, "K")
    } else {
        return format_grouped_trimmed(value, precision.unwrap_or(1), precision.is_some());
    };
    let scaled = value / divisor;
    let digits = precision.unwrap_or(1);
    format!("{}{suffix}", format_grouped_trimmed(scaled, digits, precision.is_some()))
}

fn format_duration(seconds: f64) -> String {
    let v = normalize_zero(seconds);
    let sign = if v < 0.0 { "-" } else { "" };
    let abs = v.abs();
    if abs < 1.0 {
        let ms = (abs * 1000.0).round() as u64;
        return format!("{sign}{ms}ms");
    }
    if abs < 60.0 {
        let formatted = format_grouped_trimmed(abs, 1, false);
        return format!("{sign}{formatted}s");
    }
    let total_secs = abs.round() as u64;
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let secs = total_secs % 60;
    if hours > 0 {
        if minutes > 0 {
            format!("{sign}{hours}h {minutes}m")
        } else {
            format!("{sign}{hours}h")
        }
    } else if secs > 0 {
        format!("{sign}{minutes}m {secs}s")
    } else {
        format!("{sign}{minutes}m")
    }
}
