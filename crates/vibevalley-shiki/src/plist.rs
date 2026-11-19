use std::collections::BTreeMap;

use serde::de::{self, DeserializeOwned, DeserializeSeed, IntoDeserializer, MapAccess, SeqAccess, Visitor};

use crate::error::ShikiError;

/// Decodes a TextMate XML plist document directly into a typed serde struct
/// (`RawGrammar`, `RawTheme`, etc.) without exposing untyped values outside this boundary.
pub(crate) fn from_plist_str<T: DeserializeOwned>(content: &str) -> Result<T, ShikiError> {
    let value = parse_plist_value(content)?;
    T::deserialize(value).map_err(|err| ShikiError::PlistParse {
        offset: 0,
        message: err.to_string(),
    })
}

/// Boundary-only plist DOM consumed immediately by serde deserialization.
#[derive(Debug)]
enum PlistValue {
    Dict(BTreeMap<String, PlistValue>),
    Array(Vec<PlistValue>),
    String(String),
    Integer(i64),
    Real(f64),
    Bool(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerKind {
    Dict,
    Array,
}

enum Container {
    Dict(BTreeMap<String, PlistValue>),
    Array(Vec<PlistValue>),
}

fn parse_plist_value(content: &str) -> Result<PlistValue, ShikiError> {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut pos = if content.starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 };

    let mut stack: Vec<(Container, Option<String>)> = Vec::new();
    let mut root: Option<PlistValue> = None;

    let fail = |offset: usize, msg: &str| ShikiError::PlistParse {
        offset,
        message: msg.to_string(),
    };

    let accept_value =
        |val: PlistValue, stack: &mut Vec<(Container, Option<String>)>, root: &mut Option<PlistValue>, offset: usize| -> Result<(), ShikiError> {
            match stack.last_mut() {
                Some((Container::Dict(map), cur_key)) => {
                    let key = cur_key.take().ok_or_else(|| fail(offset, "missing <key>"))?;
                    map.insert(key, val);
                    Ok(())
                }
                Some((Container::Array(arr), _)) => {
                    arr.push(val);
                    Ok(())
                }
                None => {
                    *root = Some(val);
                    Ok(())
                }
            }
        };

    while pos < len {
        while pos < len && matches!(bytes[pos], b' ' | b'\t' | b'\r' | b'\n') {
            pos += 1;
        }
        if pos >= len {
            break;
        }

        if bytes[pos] != b'<' {
            return Err(fail(pos, "expected '<'"));
        }
        let tag_start = pos;
        pos += 1;
        if pos >= len {
            return Err(fail(pos, "unexpected end of input"));
        }

        match bytes[pos] {
            b'?' => {
                pos += 1;
                pos = advance_until(content, pos, "?>");
                continue;
            }
            b'!' => {
                pos += 1;
                if content[pos..].starts_with("--") {
                    pos += 2;
                    pos = advance_until(content, pos, "-->");
                } else {
                    pos = advance_until(content, pos, ">");
                }
                continue;
            }
            b'/' => {
                pos += 1;
                while pos < len && matches!(bytes[pos], b' ' | b'\t' | b'\r' | b'\n') {
                    pos += 1;
                }
                let (close_name, next_pos) = capture_until(content, pos, ">");
                pos = next_pos;
                let close_name = close_name.trim();
                if close_name == "plist" {
                    continue;
                }
                let expected = match close_name {
                    "dict" => ContainerKind::Dict,
                    "array" => ContainerKind::Array,
                    _ => return Err(fail(tag_start, &format!("unexpected closing tag </{close_name}>"))),
                };
                let (container, _) = stack.pop().ok_or_else(|| fail(tag_start, "unexpected closing tag at root"))?;
                let val = match (expected, container) {
                    (ContainerKind::Dict, Container::Dict(map)) => PlistValue::Dict(map),
                    (ContainerKind::Array, Container::Array(arr)) => PlistValue::Array(arr),
                    _ => return Err(fail(tag_start, "mismatched closing tag")),
                };
                accept_value(val, &mut stack, &mut root, tag_start)?;
                continue;
            }
            _ => {}
        }

        let (raw_tag, after_open) = capture_until(content, pos, ">");
        pos = after_open;
        let (tag_body, self_closing) = match raw_tag.strip_suffix('/') {
            Some(stripped) => (stripped.trim(), true),
            None => (raw_tag.trim(), false),
        };

        if tag_body.starts_with("plist") {
            continue;
        }

        match tag_body {
            "dict" => {
                if self_closing {
                    accept_value(PlistValue::Dict(BTreeMap::new()), &mut stack, &mut root, tag_start)?;
                } else {
                    stack.push((Container::Dict(BTreeMap::new()), None));
                }
            }
            "array" => {
                if self_closing {
                    accept_value(PlistValue::Array(Vec::new()), &mut stack, &mut root, tag_start)?;
                } else {
                    stack.push((Container::Array(Vec::new()), None));
                }
            }
            "key" => {
                let text = read_tag_text(content, &mut pos, self_closing);
                match stack.last_mut() {
                    Some((Container::Dict(_), cur_key)) => {
                        if cur_key.is_some() {
                            return Err(fail(tag_start, "too many <key> elements"));
                        }
                        *cur_key = Some(text);
                    }
                    _ => return Err(fail(tag_start, "unexpected <key> outside <dict>")),
                }
            }
            "string" | "data" | "date" => {
                let text = read_tag_text(content, &mut pos, self_closing);
                accept_value(PlistValue::String(text), &mut stack, &mut root, tag_start)?;
            }
            "integer" => {
                let text = read_tag_text(content, &mut pos, self_closing);
                let val = text.trim().parse::<i64>().map_err(|_| fail(tag_start, "cannot parse <integer>"))?;
                accept_value(PlistValue::Integer(val), &mut stack, &mut root, tag_start)?;
            }
            "real" => {
                let text = read_tag_text(content, &mut pos, self_closing);
                let val = text.trim().parse::<f64>().map_err(|_| fail(tag_start, "cannot parse <real>"))?;
                accept_value(PlistValue::Real(val), &mut stack, &mut root, tag_start)?;
            }
            "true" => {
                let _ = read_tag_text(content, &mut pos, self_closing);
                accept_value(PlistValue::Bool(true), &mut stack, &mut root, tag_start)?;
            }
            "false" => {
                let _ = read_tag_text(content, &mut pos, self_closing);
                accept_value(PlistValue::Bool(false), &mut stack, &mut root, tag_start)?;
            }
            other => {
                return Err(fail(tag_start, &format!("unexpected opening tag <{other}>")));
            }
        }
    }

    if !stack.is_empty() {
        return Err(fail(pos, "unclosed container in plist"));
    }

    root.ok_or_else(|| fail(pos, "empty plist document"))
}

fn advance_until(content: &str, pos: usize, needle: &str) -> usize {
    match content[pos..].find(needle) {
        Some(rel) => pos + rel + needle.len(),
        None => content.len(),
    }
}

fn capture_until<'a>(content: &'a str, pos: usize, needle: &str) -> (&'a str, usize) {
    match content[pos..].find(needle) {
        Some(rel) => (&content[pos..pos + rel], pos + rel + needle.len()),
        None => (&content[pos..], content.len()),
    }
}

fn read_tag_text(content: &str, pos: &mut usize, self_closing: bool) -> String {
    if self_closing {
        return String::new();
    }
    let (raw, after_close_start) = capture_until(content, *pos, "</");
    *pos = advance_until(content, after_close_start, ">");
    unescape_xml_entities(raw)
}

fn unescape_xml_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp + 1..];
        if let Some(semi) = rest.find(';') {
            let entity = &rest[..semi];
            let decoded = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ if entity.starts_with("#x") || entity.starts_with("#X") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
                _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(ch) = decoded {
                out.push(ch);
                rest = &rest[semi + 1..];
                continue;
            }
        }
        out.push('&');
    }
    out.push_str(rest);
    out
}

#[derive(Debug)]
struct PlistDeError(String);

impl std::fmt::Display for PlistDeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlistDeError {}

impl de::Error for PlistDeError {
    fn custom<T: std::fmt::Display>(msg: T) -> Self {
        Self(msg.to_string())
    }
}

impl<'de> de::Deserializer<'de> for PlistValue {
    type Error = PlistDeError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        match self {
            PlistValue::Dict(map) => visitor.visit_map(PlistMapAccess {
                iter: map.into_iter(),
                value: None,
            }),
            PlistValue::Array(arr) => visitor.visit_seq(PlistSeqAccess { iter: arr.into_iter() }),
            PlistValue::String(s) => visitor.visit_string(s),
            PlistValue::Integer(n) => visitor.visit_i64(n),
            PlistValue::Real(f) => visitor.visit_f64(f),
            PlistValue::Bool(b) => visitor.visit_bool(b),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        visitor.visit_some(self)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        visitor.visit_unit()
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct newtype_struct seq tuple
        tuple_struct map struct enum identifier
    }
}

struct PlistMapAccess {
    iter: std::collections::btree_map::IntoIter<String, PlistValue>,
    value: Option<PlistValue>,
}

impl<'de> MapAccess<'de> for PlistMapAccess {
    type Error = PlistDeError;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, Self::Error> {
        match self.iter.next() {
            Some((k, v)) => {
                self.value = Some(v);
                seed.deserialize(k.into_deserializer()).map(Some)
            }
            None => Ok(None),
        }
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Self::Error> {
        let val = self.value.take().ok_or_else(|| PlistDeError("value called before key".to_string()))?;
        seed.deserialize(val)
    }
}

struct PlistSeqAccess {
    iter: std::vec::IntoIter<PlistValue>,
}

impl<'de> SeqAccess<'de> for PlistSeqAccess {
    type Error = PlistDeError;

    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Self::Error> {
        match self.iter.next() {
            Some(val) => seed.deserialize(val).map(Some),
            None => Ok(None),
        }
    }
}
