use std::collections::HashMap;

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceLocation};
use crate::text::entities::written_codes;
use crate::util::chars::{is_digit, is_hex};

use super::types::JsonValue;

#[derive(Debug, Clone, PartialEq)]
pub struct OrderedJson {
    pub value: IndexMap<String, JsonValue>,
    pub property_order: IndexMap<String, Vec<String>>,
}

struct WalkError {
    offset: usize,
    message: &'static str,
}

enum Frame {
    Object {
        pointer: String,
        map: IndexMap<String, JsonValue>,
        keys: Vec<String>,
        ranges: HashMap<String, (usize, usize)>,
        key: String,
        from: usize,
    },
    Array {
        pointer: String,
        items: Vec<JsonValue>,
        index: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Value,
    Key,
    After,
}

fn escape_pointer(key: &str) -> String {
    if !key.contains('~') && !key.contains('/') {
        return key.to_string();
    }
    key.replace('~', "~0").replace('/', "~1")
}

fn parse_hex4(bytes: &[u8], at: usize) -> Result<u16, WalkError> {
    if at + 4 > bytes.len() {
        return Err(WalkError {
            offset: at,
            message: "Invalid Unicode escape",
        });
    }
    let mut val = 0u16;
    for k in 0..4 {
        let b = bytes[at + k];
        if !is_hex(b as u32) {
            return Err(WalkError {
                offset: at,
                message: "Invalid Unicode escape",
            });
        }
        let digit = match b {
            b'0'..=b'9' => (b - b'0') as u16,
            b'a'..=b'f' => (b - b'a' + 10) as u16,
            _ => (b - b'A' + 10) as u16,
        };
        val = (val << 4) | digit;
    }
    Ok(val)
}

/// Iteratively parses RFC 8259 JSON into `JsonValue` while recording exact source key order
/// by JSON Pointer. Uses an explicit stack so nesting depth never overflows the call stack.
fn parse_json_iter(text: &str) -> Result<(JsonValue, IndexMap<String, Vec<String>>), WalkError> {
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut order: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut created: Vec<String> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut at = 0usize;
    let mut pointer = String::new();
    let mut state = State::Value;
    let mut current_val: Option<JsonValue> = None;

    let skip = |at: &mut usize| {
        while *at < n && matches!(bytes[*at], b' ' | b'\t' | b'\n' | b'\r') {
            *at += 1;
        }
    };

    let read_string = |at: &mut usize| -> Result<String, WalkError> {
        *at += 1; // opening quote
        let mut out = String::new();
        while *at < n {
            let start = *at;
            let b = bytes[start];
            if b == b'"' {
                *at += 1;
                return Ok(out);
            }
            if b < 0x20 {
                return Err(WalkError {
                    offset: start,
                    message: "Bad control character in string literal",
                });
            }
            if b != b'\\' {
                let ch = text[start..].chars().next().unwrap();
                out.push(ch);
                *at += ch.len_utf8();
                continue;
            }
            *at += 1;
            let escape_at = *at;
            if escape_at >= n {
                return Err(WalkError {
                    offset: escape_at,
                    message: "Unterminated string escape",
                });
            }
            let esc = bytes[escape_at];
            *at += 1;
            match esc {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'b' => out.push('\u{0008}'),
                b'f' => out.push('\u{000C}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let u1 = parse_hex4(bytes, *at)?;
                    *at += 4;
                    if (0xD800..=0xDBFF).contains(&u1)
                        && bytes.get(*at) == Some(&b'\\')
                        && bytes.get(*at + 1) == Some(&b'u')
                        && let Ok(u2) = parse_hex4(bytes, *at + 2)
                        && (0xDC00..=0xDFFF).contains(&u2)
                    {
                        *at += 6;
                        let cp = 0x10000 + (((u1 as u32) - 0xD800) << 10) + ((u2 as u32) - 0xDC00);
                        out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                    } else {
                        out.push(char::from_u32(u1 as u32).unwrap_or('\u{FFFD}'));
                    }
                }
                _ => {
                    return Err(WalkError {
                        offset: escape_at,
                        message: "Bad escaped character in JSON",
                    });
                }
            }
        }
        Err(WalkError {
            offset: *at,
            message: "Unterminated string in JSON",
        })
    };

    let read_literal = |at: &mut usize, word: &[u8]| -> Result<(), WalkError> {
        for (k, &expected) in word.iter().enumerate() {
            if bytes.get(*at + k) != Some(&expected) {
                return Err(WalkError {
                    offset: *at + k,
                    message: "Unexpected token in JSON",
                });
            }
        }
        *at += word.len();
        Ok(())
    };

    let read_number = |at: &mut usize| -> Result<f64, WalkError> {
        let start = *at;
        if bytes.get(*at) == Some(&b'-') {
            *at += 1;
        }
        match bytes.get(*at) {
            Some(&b'0') => *at += 1,
            Some(&b) if is_digit(b as u32) => {
                while bytes.get(*at).is_some_and(|&d| is_digit(d as u32)) {
                    *at += 1;
                }
            }
            _ => {
                return Err(WalkError {
                    offset: *at,
                    message: "Invalid number in JSON",
                });
            }
        }
        if bytes.get(*at) == Some(&b'.') {
            *at += 1;
            if !bytes.get(*at).is_some_and(|&d| is_digit(d as u32)) {
                return Err(WalkError {
                    offset: *at,
                    message: "Invalid fraction in JSON number",
                });
            }
            while bytes.get(*at).is_some_and(|&d| is_digit(d as u32)) {
                *at += 1;
            }
        }
        if bytes.get(*at).is_some_and(|&b| (b | 32) == b'e') {
            *at += 1;
            if matches!(bytes.get(*at), Some(b'+' | b'-')) {
                *at += 1;
            }
            if !bytes.get(*at).is_some_and(|&d| is_digit(d as u32)) {
                return Err(WalkError {
                    offset: *at,
                    message: "Invalid exponent in JSON number",
                });
            }
            while bytes.get(*at).is_some_and(|&d| is_digit(d as u32)) {
                *at += 1;
            }
        }
        let num_val = text[start..*at].parse::<f64>().map_err(|_| WalkError {
            offset: start,
            message: "Invalid number in JSON",
        })?;
        Ok(num_val)
    };

    skip(&mut at);
    let root_val = loop {
        match state {
            State::Value => {
                skip(&mut at);
                let Some(&c) = bytes.get(at) else {
                    return Err(WalkError {
                        offset: at,
                        message: "Unexpected end of JSON input",
                    });
                };
                state = State::After;
                match c {
                    b'{' => {
                        at += 1;
                        order.insert(pointer.clone(), Vec::new());
                        created.push(pointer.clone());
                        skip(&mut at);
                        if bytes.get(at) == Some(&b'}') {
                            at += 1;
                            current_val = Some(JsonValue::Object(IndexMap::new()));
                        } else {
                            stack.push(Frame::Object {
                                pointer: pointer.clone(),
                                map: IndexMap::new(),
                                keys: Vec::new(),
                                ranges: HashMap::new(),
                                key: String::new(),
                                from: 0,
                            });
                            state = State::Key;
                        }
                    }
                    b'[' => {
                        at += 1;
                        skip(&mut at);
                        if bytes.get(at) == Some(&b']') {
                            at += 1;
                            current_val = Some(JsonValue::Array(Vec::new()));
                        } else {
                            stack.push(Frame::Array {
                                pointer: pointer.clone(),
                                items: Vec::new(),
                                index: 0,
                            });
                            pointer.push_str("/0");
                            state = State::Value;
                        }
                    }
                    b'"' => {
                        let s = read_string(&mut at)?;
                        current_val = Some(JsonValue::String(s));
                    }
                    b't' => {
                        read_literal(&mut at, b"true")?;
                        current_val = Some(JsonValue::Bool(true));
                    }
                    b'f' => {
                        read_literal(&mut at, b"false")?;
                        current_val = Some(JsonValue::Bool(false));
                    }
                    b'n' => {
                        read_literal(&mut at, b"null")?;
                        current_val = Some(JsonValue::Null);
                    }
                    b'-' | b'0'..=b'9' => {
                        let num_val = read_number(&mut at)?;
                        current_val = Some(JsonValue::Number(num_val));
                    }
                    _ => {
                        return Err(WalkError {
                            offset: at,
                            message: "Unexpected token in JSON",
                        });
                    }
                }
            }
            State::Key => {
                if bytes.get(at) != Some(&b'"') {
                    return Err(WalkError {
                        offset: at,
                        message: "Expected property name in JSON object",
                    });
                }
                let key = read_string(&mut at)?;
                let Some(Frame::Object {
                    pointer: frame_ptr,
                    keys,
                    ranges,
                    key: cur_key,
                    from,
                    ..
                }) = stack.last_mut()
                else {
                    unreachable!("Key state always has an Object frame");
                };
                if let Some(&(r0, r1)) = ranges.get(&key) {
                    // Repeated key keeps its first place and takes the nested order of its last value.
                    for ptr in &created[r0..r1] {
                        order.shift_remove(ptr);
                    }
                } else {
                    keys.push(key.clone());
                }
                *cur_key = key.clone();
                *from = created.len();
                skip(&mut at);
                if bytes.get(at) != Some(&b':') {
                    return Err(WalkError {
                        offset: at,
                        message: "Expected ':' after property name in JSON",
                    });
                }
                at += 1;
                pointer = format!("{frame_ptr}/{}", escape_pointer(&key));
                state = State::Value;
            }
            State::After => {
                let val = current_val.take().unwrap();
                let Some(frame) = stack.last_mut() else {
                    break val;
                };
                let (close_byte, is_obj) = match frame {
                    Frame::Object { map, ranges, key, from, .. } => {
                        map.insert(key.clone(), val);
                        ranges.insert(key.clone(), (*from, created.len()));
                        (b'}', true)
                    }
                    Frame::Array { items, index, .. } => {
                        items.push(val);
                        *index += 1;
                        (b']', false)
                    }
                };
                skip(&mut at);
                let Some(&c) = bytes.get(at) else {
                    return Err(WalkError {
                        offset: at,
                        message: "Unexpected end of JSON input",
                    });
                };
                if c == close_byte {
                    at += 1;
                    let popped = stack.pop().unwrap();
                    match popped {
                        Frame::Object { pointer: ptr, map, keys, .. } => {
                            if let Some(slot) = order.get_mut(&ptr) {
                                *slot = keys;
                            } else {
                                order.insert(ptr, keys);
                            }
                            current_val = Some(JsonValue::Object(map));
                        }
                        Frame::Array { items, .. } => {
                            current_val = Some(JsonValue::Array(items));
                        }
                    }
                } else if c == b',' {
                    at += 1;
                    skip(&mut at);
                    if is_obj {
                        state = State::Key;
                    } else if let Some(Frame::Array { pointer: ptr, index, .. }) = stack.last() {
                        pointer = format!("{ptr}/{index}");
                        state = State::Value;
                    }
                } else {
                    return Err(WalkError {
                        offset: at,
                        message: "Unexpected token in JSON",
                    });
                }
            }
        }
    };
    skip(&mut at);
    if at != n {
        return Err(WalkError {
            offset: at,
            message: "Unexpected non-whitespace character after JSON",
        });
    }
    Ok((root_val, order))
}

fn location_at(text: &str, offset: usize, mut line: usize, mut column: usize) -> (usize, usize) {
    let end = offset.min(text.len());
    let mut prev_cr = false;
    for ch in text[..end].chars() {
        if ch == '\r' {
            line += 1;
            column = 1;
            prev_cr = true;
        } else if ch == '\n' {
            if !prev_cr {
                line += 1;
                column = 1;
            }
            prev_cr = false;
        } else {
            column += 1;
            prev_cr = false;
        }
    }
    (line, column)
}

fn json_error(message: String, line: usize, column: usize) -> PeleError {
    PeleError::new(format!("{message} (line {line}, column {column})"), ErrorCode::Syntax)
        .with_diagram_type(DiagramType::Usecase)
        .with_location(SourceLocation {
            line,
            column,
            snippet: String::new(),
        })
}

/// Parses the body of a `json` node. `origin` gives the `(line, column)` where the text starts in the diagram.
pub fn parse_ordered_json<F>(text: &str, origin: F) -> Result<OrderedJson, PeleError>
where
    F: FnOnce() -> (usize, usize),
{
    match parse_json_iter(text) {
        Ok((mut root, property_order)) => {
            if let JsonValue::Object(map) = &mut root {
                Ok(OrderedJson {
                    value: std::mem::take(map),
                    property_order,
                })
            } else {
                let (line, column) = origin();
                Err(json_error("JSON value must have an object root".to_string(), line, column))
            }
        }
        Err(first_err) => {
            // Reparse restored entity codes so error messages and positions match the source.
            let shown = written_codes(text);
            let err = if shown != text {
                match parse_json_iter(&shown) {
                    Err(e) => e,
                    Ok(_) => first_err,
                }
            } else {
                first_err
            };
            let (orig_line, orig_col) = origin();
            let (line, column) = location_at(&shown, err.offset, orig_line, orig_col);
            Err(json_error(format!("Invalid JSON: {}", err.message), line, column))
        }
    }
}
