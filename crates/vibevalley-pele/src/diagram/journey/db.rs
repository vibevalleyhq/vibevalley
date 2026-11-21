use std::collections::HashSet;

use crate::diagram::timeline::scan::{collapse_newline_ws, trim_leading_ws};
use crate::util::chars::is_space_char;

#[derive(Debug, Clone, PartialEq)]
pub struct JourneyTask {
    pub task: String,
    /// As written: any number, or `f64::NAN` when the score is not numeric.
    pub score: f64,
    pub people: Vec<String>,
    /// Name of the section in force when the task was declared, `""` before the first one.
    pub section: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JourneyModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub sections: Vec<String>,
    pub tasks: Vec<JourneyTask>,
    current_section: String,
}

impl Default for JourneyModel {
    fn default() -> Self {
        Self::new()
    }
}

/// Everyone named on a task, once each, in UTF-16 code unit order (matching JS `Array.sort`).
pub fn journey_actors(tasks: &[JourneyTask]) -> Vec<String> {
    let mut names: HashSet<&str> = HashSet::new();
    for task in tasks {
        for name in &task.people {
            names.insert(name.as_str());
        }
    }
    let mut list: Vec<String> = names.into_iter().map(str::to_string).collect();
    list.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    list
}

/// Parses a string like JavaScript `Number(s)`.
pub fn js_number(raw: &str) -> f64 {
    let s = raw.trim_matches(is_space_char);
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return u64::from_str_radix(hex, 16).map_or(f64::NAN, |n| n as f64);
        }
        return f64::NAN;
    }
    if let Some(bin) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
        if !bin.is_empty() && bin.bytes().all(|b| b == b'0' || b == b'1') {
            return u64::from_str_radix(bin, 2).map_or(f64::NAN, |n| n as f64);
        }
        return f64::NAN;
    }
    if let Some(oct) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
        if !oct.is_empty() && oct.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return u64::from_str_radix(oct, 8).map_or(f64::NAN, |n| n as f64);
        }
        return f64::NAN;
    }
    if s.bytes().any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E') {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

impl JourneyModel {
    pub fn new() -> Self {
        Self {
            title: None,
            acc_title: None,
            acc_descr: None,
            sections: Vec::new(),
            tasks: Vec::new(),
            current_section: String::new(),
        }
    }

    pub fn set_diagram_title(&mut self, text: &str) {
        self.title = Some(text.to_string());
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(trim_leading_ws(text));
    }

    pub fn set_acc_description(&mut self, text: &str) {
        self.acc_descr = Some(collapse_newline_ws(text));
    }

    pub fn add_section(&mut self, text: &str) {
        self.current_section = text.to_string();
        self.sections.push(text.to_string());
    }

    /// `data` is the rest of the line from its first colon: `:score` or `:score:actor, actor`.
    pub fn add_task(&mut self, task: &str, data: &str) {
        let rest = data.strip_prefix(':').unwrap_or(data);
        let mut pieces = rest.split(':');
        let score_str = pieces.next().unwrap_or("");
        let people = match pieces.next() {
            None => Vec::new(),
            Some(raw) => raw.split(',').map(|name| name.trim().to_string()).collect(),
        };
        self.tasks.push(JourneyTask {
            task: task.to_string(),
            score: js_number(score_str),
            people,
            section: self.current_section.clone(),
        });
    }

    pub fn get_actors(&self) -> Vec<String> {
        journey_actors(&self.tasks)
    }
}
