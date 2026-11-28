//! Multi-Dimensional Database Base kernel (`#32`, `#38`, `#40`):
//! - [`BaseDocument`] stored in `structure/base.json`
//! - Pure view projection [`project_base_view`] (filter, sort, group_by, summary ops)
//! - Row upsert & Agent Action prompt template substitution

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{
    BaseCellValue, BaseColumn, BaseColumnKind, BaseFilterOp, BaseFilterRule, BaseGroupSnapshot, BaseRow, BaseSheet, BaseSheetMeta, BaseSortRule,
    BaseSummaryConfig, BaseSummaryOp, BaseSummaryResult, BaseUpsertRowRequest, BaseViewConfig, BaseViewKind, BaseViewRequest, BaseViewSnapshot, JsNumber,
    LinkEntityKind, LinkRelation, NoteLinkRef,
};

use crate::note::links::{dedup_links, extract_markdown_links};

/// Current `structure/base.json` schema version.
pub const BASE_SCHEMA_VERSION: u32 = 1;

/// On-disk JSON shape of `structure/base.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseDocument {
    pub version: u32,
    pub sheets: Vec<BaseSheet>,
}

impl Default for BaseDocument {
    fn default() -> Self {
        Self {
            version: BASE_SCHEMA_VERSION,
            sheets: Vec::new(),
        }
    }
}

pub fn parse_base_document(raw: &str) -> Result<BaseDocument, String> {
    let mut doc: BaseDocument = serde_json::from_str(raw).map_err(|e| format!("invalid base.json: {e}"))?;
    if doc.version == 0 {
        doc.version = BASE_SCHEMA_VERSION;
    }
    Ok(doc)
}

pub fn serialize_base_document(doc: &BaseDocument) -> Result<String, String> {
    let mut out = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Formats any [`BaseCellValue`] into a compact display string for previews, sorting, and prompt substitution.
pub fn cell_as_text(cell: &BaseCellValue) -> String {
    match cell {
        BaseCellValue::Text { value } => value.clone(),
        BaseCellValue::Number { value } => format_js_number(value.0),
        BaseCellValue::Bool { value } => if *value { "true" } else { "false" }.to_owned(),
        BaseCellValue::Strings { items } => items.join(", "),
        BaseCellValue::IssueRef { issue_id } => issue_id.clone(),
        BaseCellValue::NoteRef { note_id } => note_id.clone(),
        BaseCellValue::AgentRef { agent_id } => agent_id.clone(),
        BaseCellValue::AgentRun { summary, status, .. } => summary.clone().unwrap_or_else(|| status.clone()),
    }
}

fn format_js_number(n: f64) -> String {
    if (n - n.round()).abs() < 1e-9 && n.abs() < 1e15 {
        format!("{}", n.round() as i64)
    } else {
        let s = format!("{n:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

fn cell_as_number(cell: &BaseCellValue) -> Option<f64> {
    match cell {
        BaseCellValue::Number { value } => Some(value.0),
        BaseCellValue::Text { value } => value.trim().parse::<f64>().ok(),
        BaseCellValue::Bool { value } => Some(if *value { 1.0 } else { 0.0 }),
        BaseCellValue::Strings { .. }
        | BaseCellValue::IssueRef { .. }
        | BaseCellValue::NoteRef { .. }
        | BaseCellValue::AgentRef { .. }
        | BaseCellValue::AgentRun { .. } => None,
    }
}

fn cell_is_empty(cell: Option<&BaseCellValue>) -> bool {
    match cell {
        None => true,
        Some(BaseCellValue::Text { value }) => value.trim().is_empty(),
        Some(BaseCellValue::Strings { items }) => items.is_empty(),
        Some(BaseCellValue::IssueRef { issue_id }) => issue_id.trim().is_empty(),
        Some(BaseCellValue::NoteRef { note_id }) => note_id.trim().is_empty(),
        Some(BaseCellValue::AgentRef { agent_id }) => agent_id.trim().is_empty(),
        Some(BaseCellValue::Number { .. } | BaseCellValue::Bool { .. } | BaseCellValue::AgentRun { .. }) => false,
    }
}

fn matches_filter(row: &BaseRow, rule: &BaseFilterRule) -> bool {
    let cell = row.cells.get(&rule.column_id);
    let needle = rule.value.as_deref().unwrap_or("");
    match rule.op {
        BaseFilterOp::Empty => cell_is_empty(cell),
        BaseFilterOp::NotEmpty => !cell_is_empty(cell),
        BaseFilterOp::Eq => cell.map(cell_as_text).unwrap_or_default().eq_ignore_ascii_case(needle),
        BaseFilterOp::Neq => !cell.map(cell_as_text).unwrap_or_default().eq_ignore_ascii_case(needle),
        BaseFilterOp::Contains => cell
            .map(cell_as_text)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains(&needle.to_ascii_lowercase()),
    }
}

fn compare_rows(a: &BaseRow, b: &BaseRow, sorts: &[BaseSortRule]) -> Ordering {
    for sort in sorts {
        let ca = a.cells.get(&sort.column_id);
        let cb = b.cells.get(&sort.column_id);
        let ord = match (ca.and_then(cell_as_number), cb.and_then(cell_as_number)) {
            (Some(na), Some(nb)) => na.partial_cmp(&nb).unwrap_or(Ordering::Equal),
            _ => {
                let sa = ca.map(cell_as_text).unwrap_or_default();
                let sb = cb.map(cell_as_text).unwrap_or_default();
                sa.to_ascii_lowercase().cmp(&sb.to_ascii_lowercase())
            }
        };
        if ord != Ordering::Equal {
            return if sort.desc { ord.reverse() } else { ord };
        }
    }
    a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id))
}

fn build_groups(columns: &[BaseColumn], rows: &[BaseRow], group_col_id: Option<&str>) -> Vec<BaseGroupSnapshot> {
    let Some(col_id) = group_col_id else {
        return Vec::new();
    };
    let col = columns.iter().find(|c| c.id == col_id);
    let mut buckets: HashMap<String, Vec<String>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut label_map: HashMap<String, String> = HashMap::new();

    if let Some(col) = col
        && let Some(options) = &col.options
    {
        for opt in options {
            order.push(opt.value.clone());
            label_map.insert(opt.value.clone(), opt.label.clone().unwrap_or_else(|| opt.value.clone()));
            buckets.entry(opt.value.clone()).or_default();
        }
    }

    for row in rows {
        let key = row
            .cells
            .get(col_id)
            .map(cell_as_text)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(row.id.clone());
    }

    order
        .into_iter()
        .filter_map(|key| {
            let row_ids = buckets.remove(&key)?;
            if row_ids.is_empty() && key.is_empty() {
                return None;
            }
            let label = if key.is_empty() {
                "Uncategorized".to_owned()
            } else {
                label_map.get(&key).cloned().unwrap_or_else(|| key.clone())
            };
            let count = row_ids.len() as u32;
            Some(BaseGroupSnapshot { key, label, row_ids, count })
        })
        .collect()
}

fn compute_summaries(rows: &[BaseRow], summaries: &[BaseSummaryConfig]) -> Vec<BaseSummaryResult> {
    summaries
        .iter()
        .map(|cfg| {
            let value = match cfg.op {
                BaseSummaryOp::Count => {
                    let count = rows.iter().filter(|r| !cell_is_empty(r.cells.get(&cfg.column_id))).count();
                    count.to_string()
                }
                BaseSummaryOp::Sum | BaseSummaryOp::Avg | BaseSummaryOp::Min | BaseSummaryOp::Max => {
                    let nums: Vec<f64> = rows.iter().filter_map(|r| r.cells.get(&cfg.column_id).and_then(cell_as_number)).collect();
                    if nums.is_empty() {
                        "—".to_owned()
                    } else {
                        let agg = match cfg.op {
                            BaseSummaryOp::Sum => nums.iter().sum(),
                            BaseSummaryOp::Avg => nums.iter().sum::<f64>() / (nums.len() as f64),
                            BaseSummaryOp::Min => nums.iter().copied().fold(f64::INFINITY, f64::min),
                            BaseSummaryOp::Max => nums.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                            BaseSummaryOp::Count => unreachable!(),
                        };
                        format_js_number(agg)
                    }
                }
            };
            BaseSummaryResult {
                column_id: cfg.column_id.clone(),
                op: cfg.op,
                value,
            }
        })
        .collect()
}

fn parse_view_kind(raw: &str) -> Option<BaseViewKind> {
    match raw {
        "table" => Some(BaseViewKind::Table),
        "board" => Some(BaseViewKind::Board),
        "gallery" => Some(BaseViewKind::Gallery),
        "timeline" => Some(BaseViewKind::Timeline),
        _ => None,
    }
}

/// Projects `structure/base.json` into a [`BaseViewSnapshot`] with filters, sorts, groups, and summaries.
pub fn project_base_view(note_id: &str, files: &BTreeMap<String, Vec<u8>>, req: &BaseViewRequest) -> Result<BaseViewSnapshot, String> {
    let raw = files
        .get("structure/base.json")
        .and_then(|b| std::str::from_utf8(b).ok())
        .ok_or_else(|| "missing structure/base.json".to_owned())?;
    let doc = parse_base_document(raw)?;

    let sheets: Vec<BaseSheetMeta> = doc
        .sheets
        .iter()
        .map(|s| BaseSheetMeta {
            id: s.id.clone(),
            name: s.name.clone(),
            row_count: s.rows.len() as u32,
        })
        .collect();

    let sheet = match req.sheet_id.as_deref() {
        Some(sid) => doc.sheets.iter().find(|s| s.id == sid).ok_or_else(|| format!("sheet {sid} not found"))?,
        None => doc.sheets.first().ok_or_else(|| "base has no sheets".to_owned())?,
    };

    let fallback_view = BaseViewConfig {
        id: "default".to_owned(),
        name: "Table".to_owned(),
        kind: BaseViewKind::Table,
        group_by: None,
        hidden_columns: None,
        filters: None,
        sorts: None,
        summaries: None,
    };
    let resolved_owned: BaseViewConfig;
    let view = match req.view_id.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(vid) => {
            if let Some(exact) = sheet.views.iter().find(|v| v.id == vid) {
                exact
            } else if let Some(requested_kind) = parse_view_kind(vid) {
                if let Some(by_kind) = sheet.views.iter().find(|v| v.kind == requested_kind) {
                    by_kind
                } else {
                    let base_cfg = sheet.views.first().unwrap_or(&fallback_view);
                    let default_group_by = if requested_kind == BaseViewKind::Board {
                        sheet
                            .views
                            .iter()
                            .find_map(|v| v.group_by.clone())
                            .or_else(|| sheet.columns.iter().find(|c| c.kind == BaseColumnKind::Select).map(|c| c.id.clone()))
                            .or_else(|| sheet.columns.iter().find(|c| c.kind == BaseColumnKind::AgentRef).map(|c| c.id.clone()))
                    } else {
                        base_cfg.group_by.clone()
                    };
                    resolved_owned = BaseViewConfig {
                        id: vid.to_owned(),
                        name: base_cfg.name.clone(),
                        kind: requested_kind,
                        group_by: default_group_by,
                        hidden_columns: base_cfg.hidden_columns.clone(),
                        filters: base_cfg.filters.clone(),
                        sorts: base_cfg.sorts.clone(),
                        summaries: base_cfg.summaries.clone(),
                    };
                    &resolved_owned
                }
            } else {
                return Err(format!("view {vid} not found"));
            }
        }
        None => sheet.views.first().unwrap_or(&fallback_view),
    };

    let hidden: Vec<&str> = view.hidden_columns.as_deref().unwrap_or(&[]).iter().map(String::as_str).collect();
    let columns: Vec<BaseColumn> = sheet.columns.iter().filter(|c| !hidden.contains(&c.id.as_str())).cloned().collect();

    let filters = view.filters.as_deref().unwrap_or(&[]);
    let mut rows: Vec<BaseRow> = sheet
        .rows
        .iter()
        .map(|row| evaluate_row_formulas(&sheet.columns, row))
        .filter(|row| filters.iter().all(|rule| matches_filter(row, rule)))
        .collect();
    let sorts = view.sorts.as_deref().unwrap_or(&[]);
    rows.sort_by(|a, b| compare_rows(a, b, sorts));

    let groups = build_groups(&sheet.columns, &rows, view.group_by.as_deref());
    let summaries = compute_summaries(&rows, view.summaries.as_deref().unwrap_or(&[]));
    let total_rows = rows.len() as u32;

    Ok(BaseViewSnapshot {
        note_id: note_id.to_owned(),
        sheets,
        active_sheet_id: sheet.id.clone(),
        active_view_id: view.id.clone(),
        active_view_kind: view.kind,
        columns,
        rows,
        groups,
        summaries,
        total_rows,
    })
}

/// Evaluates all [`BaseColumnKind::Formula`] columns in `columns` against `row`
/// without panicking, populating computed cells on a cloned [`BaseRow`].
pub fn evaluate_row_formulas(columns: &[BaseColumn], row: &BaseRow) -> BaseRow {
    let mut out = row.clone();
    for col in columns {
        if col.kind != BaseColumnKind::Formula {
            continue;
        }
        let val = match col.formula.as_deref() {
            Some(expr) => evaluate_formula(expr, columns, &out),
            None => BaseCellValue::Text { value: String::new() },
        };
        out.cells.insert(col.id.clone(), val);
    }
    out
}

/// Evaluates a single deterministic Base formula expression against `columns` and `row`.
/// Returns a clean fallback string [`BaseCellValue::Text`] on syntax or runtime errors.
pub fn evaluate_formula(formula: &str, columns: &[BaseColumn], row: &BaseRow) -> BaseCellValue {
    let trimmed = formula.trim();
    if trimmed.is_empty() {
        return BaseCellValue::Text { value: String::new() };
    }
    match parse_and_eval(trimmed, columns, row) {
        Ok(FormulaVal::Number(n)) if n.is_finite() => BaseCellValue::Number { value: JsNumber(n) },
        Ok(FormulaVal::Bool(b)) => BaseCellValue::Bool { value: b },
        Ok(FormulaVal::Text(s)) => BaseCellValue::Text { value: s },
        Ok(FormulaVal::List(items)) => BaseCellValue::Strings { items },
        Ok(FormulaVal::Empty) => BaseCellValue::Text { value: String::new() },
        Ok(FormulaVal::Number(_)) | Err(_) => BaseCellValue::Text { value: "—".to_owned() },
    }
}

/// Extracts outgoing note and issue links from `structure/base.json`:
/// `page_note_id` row pages, `NoteRef` / `IssueRef` / `AgentRun.spawned_issue_id` cells,
/// and markdown wikilinks inside text cells.
pub fn extract_base_links(files: &BTreeMap<String, Vec<u8>>) -> Vec<NoteLinkRef> {
    let Some(raw) = files.get("structure/base.json").and_then(|b| std::str::from_utf8(b).ok()) else {
        return Vec::new();
    };
    let Ok(doc) = parse_base_document(raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for sheet in &doc.sheets {
        for row in &sheet.rows {
            if let Some(page_id) = row.page_note_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                out.push(NoteLinkRef {
                    kind: LinkEntityKind::Note,
                    id: page_id.to_owned(),
                    relation: LinkRelation::Link,
                    title: None,
                });
            }
            if let Some(aref) = &row.annotation_ref
                && !aref.note_id.trim().is_empty()
            {
                out.push(NoteLinkRef {
                    kind: LinkEntityKind::Note,
                    id: aref.note_id.trim().to_owned(),
                    relation: LinkRelation::Link,
                    title: None,
                });
            }
            for cell in row.cells.values() {
                match cell {
                    BaseCellValue::NoteRef { note_id } if !note_id.trim().is_empty() => out.push(NoteLinkRef {
                        kind: LinkEntityKind::Note,
                        id: note_id.trim().to_owned(),
                        relation: LinkRelation::Link,
                        title: None,
                    }),
                    BaseCellValue::IssueRef { issue_id } if !issue_id.trim().is_empty() => out.push(NoteLinkRef {
                        kind: LinkEntityKind::Issue,
                        id: issue_id.trim().to_owned(),
                        relation: LinkRelation::Link,
                        title: None,
                    }),
                    BaseCellValue::AgentRun {
                        spawned_issue_id: Some(issue_id),
                        ..
                    } if !issue_id.trim().is_empty() => out.push(NoteLinkRef {
                        kind: LinkEntityKind::Issue,
                        id: issue_id.trim().to_owned(),
                        relation: LinkRelation::Link,
                        title: None,
                    }),
                    BaseCellValue::Text { value } => out.extend(extract_markdown_links(value)),
                    BaseCellValue::Strings { items } => {
                        for item in items {
                            out.extend(extract_markdown_links(item));
                        }
                    }
                    BaseCellValue::Number { .. }
                    | BaseCellValue::Bool { .. }
                    | BaseCellValue::NoteRef { .. }
                    | BaseCellValue::IssueRef { .. }
                    | BaseCellValue::AgentRef { .. }
                    | BaseCellValue::AgentRun { .. } => {}
                }
            }
        }
    }
    dedup_links(out)
}

#[derive(Debug, Clone)]
enum FormulaVal {
    Number(f64),
    Bool(bool),
    Text(String),
    List(Vec<String>),
    Empty,
}

impl FormulaVal {
    fn from_cell(cell: Option<&BaseCellValue>) -> Self {
        match cell {
            None => Self::Empty,
            Some(BaseCellValue::Number { value }) => Self::Number(value.0),
            Some(BaseCellValue::Bool { value }) => Self::Bool(*value),
            Some(BaseCellValue::Text { value }) => Self::Text(value.clone()),
            Some(BaseCellValue::Strings { items }) => Self::List(items.clone()),
            Some(BaseCellValue::IssueRef { issue_id }) => Self::Text(issue_id.clone()),
            Some(BaseCellValue::NoteRef { note_id }) => Self::Text(note_id.clone()),
            Some(BaseCellValue::AgentRef { agent_id }) => Self::Text(agent_id.clone()),
            Some(BaseCellValue::AgentRun { summary, status, .. }) => Self::Text(summary.clone().unwrap_or_else(|| status.clone())),
        }
    }

    fn as_number(&self) -> Result<f64, String> {
        match self {
            Self::Number(n) => Ok(*n),
            Self::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
            Self::Empty => Ok(0.0),
            Self::Text(s) => {
                let t = s.trim();
                if t.is_empty() {
                    Ok(0.0)
                } else {
                    t.parse::<f64>().map_err(|_| format!("non-numeric text: {s}"))
                }
            }
            Self::List(_) => Err("list value is not numeric".to_owned()),
        }
    }

    fn as_bool(&self) -> bool {
        match self {
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::Text(s) => !s.trim().is_empty(),
            Self::List(items) => !items.is_empty(),
            Self::Empty => false,
        }
    }

    fn into_text(self) -> String {
        match self {
            Self::Text(s) => s,
            Self::Number(n) => format_js_number(n),
            Self::Bool(b) => if b { "true" } else { "false" }.to_owned(),
            Self::List(items) => items.join(", "),
            Self::Empty => String::new(),
        }
    }

    fn count_units(&self) -> usize {
        match self {
            Self::Empty => 0,
            Self::List(items) => items.len(),
            Self::Text(s) => usize::from(!s.trim().is_empty()),
            Self::Number(_) | Self::Bool(_) => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Str(String),
    Bool(bool),
    Ref(String),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Bang,
    Eq,
    Neq,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    LParen,
    RParen,
    Comma,
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b == b'{' {
            let start = i + 1;
            let Some(rel_end) = input[start..].find('}') else {
                return Err("unclosed '{' reference".to_owned());
            };
            let name = input[start..start + rel_end].trim().to_owned();
            if name.is_empty() {
                return Err("empty '{}' reference".to_owned());
            }
            out.push(Token::Ref(name));
            i = start + rel_end + 1;
            continue;
        }
        if b == b'"' || b == b'\'' {
            let quote = b as char;
            let mut chars = input[i + 1..].char_indices();
            let mut s = String::new();
            let mut closed_at = None;
            while let Some((idx, ch)) = chars.next() {
                if ch == '\\' {
                    let Some((_, esc)) = chars.next() else {
                        return Err("unterminated escape in string".to_owned());
                    };
                    match esc {
                        'n' => s.push('\n'),
                        't' => s.push('\t'),
                        'r' => s.push('\r'),
                        other => s.push(other),
                    }
                } else if ch == quote {
                    closed_at = Some(i + 1 + idx + ch.len_utf8());
                    break;
                } else {
                    s.push(ch);
                }
            }
            let Some(next_i) = closed_at else {
                return Err("unterminated string literal".to_owned());
            };
            out.push(Token::Str(s));
            i = next_i;
            continue;
        }
        if b.is_ascii_digit() || (b == b'.' && bytes.get(i + 1).is_some_and(u8::is_ascii_digit)) {
            let start = i;
            let mut seen_dot = false;
            while i < bytes.len() {
                if bytes[i].is_ascii_digit() {
                    i += 1;
                } else if bytes[i] == b'.' && !seen_dot {
                    seen_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            let num: f64 = input[start..i].parse().map_err(|_| "invalid number".to_owned())?;
            out.push(Token::Num(num));
            continue;
        }
        if b.is_ascii_alphabetic() || b == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let ident = &input[start..i];
            if ident.eq_ignore_ascii_case("true") {
                out.push(Token::Bool(true));
            } else if ident.eq_ignore_ascii_case("false") {
                out.push(Token::Bool(false));
            } else {
                out.push(Token::Ident(ident.to_owned()));
            }
            continue;
        }
        if bytes[i..].starts_with(b"==") {
            out.push(Token::Eq);
            i += 2;
        } else if bytes[i..].starts_with(b"!=") || bytes[i..].starts_with(b"<>") {
            out.push(Token::Neq);
            i += 2;
        } else if bytes[i..].starts_with(b"<=") {
            out.push(Token::Le);
            i += 2;
        } else if bytes[i..].starts_with(b">=") {
            out.push(Token::Ge);
            i += 2;
        } else if bytes[i..].starts_with(b"&&") {
            out.push(Token::And);
            i += 2;
        } else if bytes[i..].starts_with(b"||") {
            out.push(Token::Or);
            i += 2;
        } else {
            let tok = match b {
                b'+' => Token::Plus,
                b'-' => Token::Minus,
                b'*' => Token::Star,
                b'/' => Token::Slash,
                b'!' => Token::Bang,
                b'=' => Token::Eq,
                b'<' => Token::Lt,
                b'>' => Token::Gt,
                b'(' => Token::LParen,
                b')' => Token::RParen,
                b',' => Token::Comma,
                other => return Err(format!("unexpected character '{}'", other as char)),
            };
            out.push(tok);
            i += 1;
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Ref(String),
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Bin(BinOp, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Debug, Clone, Copy)]
enum BinOp {
    Or,
    And,
    Eq,
    Neq,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<&Token> {
        let tok = self.tokens.get(self.pos)?;
        self.pos += 1;
        Some(tok)
    }

    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > 64 {
            return Err("formula nesting too deep".to_owned());
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.enter()?;
        let res = self.parse_or();
        self.leave();
        res
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_and()?;
        while matches!(self.peek(), Some(Token::Or)) {
            self.next();
            let rhs = self.parse_and()?;
            lhs = Expr::Bin(BinOp::Or, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_cmp()?;
        while matches!(self.peek(), Some(Token::And)) {
            self.next();
            let rhs = self.parse_cmp()?;
            lhs = Expr::Bin(BinOp::And, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_cmp(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_add()?;
        while let Some(op) = match self.peek() {
            Some(Token::Eq) => Some(BinOp::Eq),
            Some(Token::Neq) => Some(BinOp::Neq),
            Some(Token::Lt) => Some(BinOp::Lt),
            Some(Token::Le) => Some(BinOp::Le),
            Some(Token::Gt) => Some(BinOp::Gt),
            Some(Token::Ge) => Some(BinOp::Ge),
            _ => None,
        } {
            self.next();
            let rhs = self.parse_add()?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_mul()?;
        while let Some(op) = match self.peek() {
            Some(Token::Plus) => Some(BinOp::Add),
            Some(Token::Minus) => Some(BinOp::Sub),
            _ => None,
        } {
            self.next();
            let rhs = self.parse_mul()?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_unary()?;
        while let Some(op) = match self.peek() {
            Some(Token::Star) => Some(BinOp::Mul),
            Some(Token::Slash) => Some(BinOp::Div),
            _ => None,
        } {
            self.next();
            let rhs = self.parse_unary()?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Some(Token::Minus) => {
                self.next();
                Ok(Expr::Neg(Box::new(self.parse_unary()?)))
            }
            Some(Token::Plus) => {
                self.next();
                self.parse_unary()
            }
            Some(Token::Bang) => {
                self.next();
                Ok(Expr::Not(Box::new(self.parse_unary()?)))
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        let tok = self.next().cloned().ok_or_else(|| "unexpected end of formula".to_owned())?;
        match tok {
            Token::Num(n) => Ok(Expr::Num(n)),
            Token::Str(s) => Ok(Expr::Str(s)),
            Token::Bool(b) => Ok(Expr::Bool(b)),
            Token::Ref(r) => Ok(Expr::Ref(r)),
            Token::Ident(name) => {
                if !matches!(self.peek(), Some(Token::LParen)) {
                    return Err(format!("unexpected identifier '{name}'"));
                }
                self.next();
                let mut args = Vec::new();
                if !matches!(self.peek(), Some(Token::RParen)) {
                    loop {
                        args.push(self.parse_expr()?);
                        if matches!(self.peek(), Some(Token::Comma)) {
                            self.next();
                        } else {
                            break;
                        }
                    }
                }
                if !matches!(self.next(), Some(Token::RParen)) {
                    return Err("expected ')' after function arguments".to_owned());
                }
                Ok(Expr::Call(name, args))
            }
            Token::LParen => {
                let inner = self.parse_expr()?;
                if !matches!(self.next(), Some(Token::RParen)) {
                    return Err("expected ')'".to_owned());
                }
                Ok(inner)
            }
            other => Err(format!("unexpected token {other:?}")),
        }
    }
}

fn parse_and_eval(formula: &str, columns: &[BaseColumn], row: &BaseRow) -> Result<FormulaVal, String> {
    let tokens = tokenize(formula)?;
    if tokens.is_empty() {
        return Ok(FormulaVal::Empty);
    }
    let mut parser = Parser {
        tokens: &tokens,
        pos: 0,
        depth: 0,
    };
    let expr = parser.parse_expr()?;
    if parser.pos != tokens.len() {
        return Err("unexpected trailing tokens".to_owned());
    }
    eval_expr(&expr, columns, row)
}

fn resolve_ref<'a>(key: &str, columns: &'a [BaseColumn], row: &'a BaseRow) -> FormulaVal {
    let col = columns
        .iter()
        .find(|c| c.id == key)
        .or_else(|| columns.iter().find(|c| c.name == key))
        .or_else(|| columns.iter().find(|c| c.name.eq_ignore_ascii_case(key)));
    let cell = col.and_then(|c| row.cells.get(&c.id)).or_else(|| row.cells.get(key));
    FormulaVal::from_cell(cell)
}

fn compare_values(lhs: FormulaVal, rhs: FormulaVal) -> Ordering {
    match (&lhs, &rhs) {
        (FormulaVal::Empty, FormulaVal::Empty) => Ordering::Equal,
        (FormulaVal::Number(a), _) | (_, FormulaVal::Number(a)) => {
            let _ = a;
            if let (Ok(na), Ok(nb)) = (lhs.as_number(), rhs.as_number()) {
                return na.partial_cmp(&nb).unwrap_or(Ordering::Equal);
            }
            lhs.into_text().cmp(&rhs.into_text())
        }
        (FormulaVal::Bool(a), FormulaVal::Bool(b)) => a.cmp(b),
        _ => lhs.into_text().cmp(&rhs.into_text()),
    }
}

fn eval_expr(expr: &Expr, columns: &[BaseColumn], row: &BaseRow) -> Result<FormulaVal, String> {
    match expr {
        Expr::Num(n) => Ok(FormulaVal::Number(*n)),
        Expr::Str(s) => Ok(FormulaVal::Text(s.clone())),
        Expr::Bool(b) => Ok(FormulaVal::Bool(*b)),
        Expr::Ref(key) => Ok(resolve_ref(key, columns, row)),
        Expr::Neg(inner) => {
            let n = eval_expr(inner, columns, row)?.as_number()?;
            Ok(FormulaVal::Number(-n))
        }
        Expr::Not(inner) => {
            let b = eval_expr(inner, columns, row)?.as_bool();
            Ok(FormulaVal::Bool(!b))
        }
        Expr::Bin(op, lhs_expr, rhs_expr) => match op {
            BinOp::Or => {
                let l = eval_expr(lhs_expr, columns, row)?;
                if l.as_bool() {
                    Ok(FormulaVal::Bool(true))
                } else {
                    Ok(FormulaVal::Bool(eval_expr(rhs_expr, columns, row)?.as_bool()))
                }
            }
            BinOp::And => {
                let l = eval_expr(lhs_expr, columns, row)?;
                if !l.as_bool() {
                    Ok(FormulaVal::Bool(false))
                } else {
                    Ok(FormulaVal::Bool(eval_expr(rhs_expr, columns, row)?.as_bool()))
                }
            }
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div => {
                let a = eval_expr(lhs_expr, columns, row)?.as_number()?;
                let b = eval_expr(rhs_expr, columns, row)?.as_number()?;
                let res = match op {
                    BinOp::Add => a + b,
                    BinOp::Sub => a - b,
                    BinOp::Mul => a * b,
                    BinOp::Div => {
                        if b == 0.0 {
                            return Err("division by zero".to_owned());
                        }
                        a / b
                    }
                    _ => unreachable!(),
                };
                if !res.is_finite() {
                    return Err("non-finite arithmetic result".to_owned());
                }
                Ok(FormulaVal::Number(res))
            }
            BinOp::Eq | BinOp::Neq | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
                let l = eval_expr(lhs_expr, columns, row)?;
                let r = eval_expr(rhs_expr, columns, row)?;
                let ord = compare_values(l, r);
                let matched = match op {
                    BinOp::Eq => ord == Ordering::Equal,
                    BinOp::Neq => ord != Ordering::Equal,
                    BinOp::Lt => ord == Ordering::Less,
                    BinOp::Le => ord != Ordering::Greater,
                    BinOp::Gt => ord == Ordering::Greater,
                    BinOp::Ge => ord != Ordering::Less,
                    _ => unreachable!(),
                };
                Ok(FormulaVal::Bool(matched))
            }
        },
        Expr::Call(name, args) => match name.to_ascii_lowercase().as_str() {
            "concat" => {
                let mut out = String::new();
                for arg in args {
                    out.push_str(&eval_expr(arg, columns, row)?.into_text());
                }
                Ok(FormulaVal::Text(out))
            }
            "count" => {
                let mut total = 0usize;
                for arg in args {
                    total += eval_expr(arg, columns, row)?.count_units();
                }
                Ok(FormulaVal::Number(total as f64))
            }
            "if" => {
                if args.len() != 3 {
                    return Err("if(cond, a, b) requires 3 arguments".to_owned());
                }
                let cond = eval_expr(&args[0], columns, row)?.as_bool();
                eval_expr(if cond { &args[1] } else { &args[2] }, columns, row)
            }
            _ => Err(format!("unknown function '{name}'")),
        },
    }
}

/// Inserts or updates a row in `doc` and returns the effective `row_id`.
pub fn upsert_row(doc: &mut BaseDocument, req: &BaseUpsertRowRequest, now: i64, generated_row_id: &str) -> Result<(String, String), String> {
    let sheet = match req.sheet_id.as_deref() {
        Some(sid) => doc.sheets.iter_mut().find(|s| s.id == sid).ok_or_else(|| format!("sheet {sid} not found"))?,
        None => doc.sheets.first_mut().ok_or_else(|| "base has no sheets".to_owned())?,
    };
    let sheet_id = sheet.id.clone();
    let row_id = req
        .row_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| generated_row_id.to_owned());

    if let Some(existing) = sheet.rows.iter_mut().find(|r| r.id == row_id) {
        for (col_id, val) in &req.cells {
            existing.cells.insert(col_id.clone(), val.clone());
        }
        existing.updated_at = now;
    } else {
        sheet.rows.push(BaseRow {
            id: row_id.clone(),
            cells: req.cells.clone(),
            page_note_id: None,
            annotation_ref: None,
            created_at: now,
            updated_at: now,
        });
    }
    Ok((sheet_id, row_id))
}

/// Renders an Agent Action column's `prompt_template` against a [`BaseRow`],
/// substituting `{{column_id}}`, `{{Column Name}}`, and `{{row_id}}`.
pub fn format_agent_prompt(template: &str, sheet: &BaseSheet, row: &BaseRow) -> String {
    let mut rendered = template.replace("{{row_id}}", &row.id);
    for col in &sheet.columns {
        let text = row.cells.get(&col.id).map(cell_as_text).unwrap_or_default();
        rendered = rendered.replace(&format!("{{{{{}}}}}", col.id), &text);
        rendered = rendered.replace(&format!("{{{{{}}}}}", col.name), &text);
    }
    rendered
}

/// Convenience helper for converting JSON scalar into [`BaseCellValue`].
pub fn text_cell(v: impl Into<String>) -> BaseCellValue {
    BaseCellValue::Text { value: v.into() }
}

pub fn number_cell(v: f64) -> BaseCellValue {
    BaseCellValue::Number { value: JsNumber(v) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_base_doc() -> BaseDocument {
        let mut r1 = BTreeMap::new();
        r1.insert("c_title".to_owned(), text_cell("Alpha"));
        r1.insert("c_score".to_owned(), number_cell(10.0));
        r1.insert("c_status".to_owned(), text_cell("todo"));

        let mut r2 = BTreeMap::new();
        r2.insert("c_title".to_owned(), text_cell("Beta"));
        r2.insert("c_score".to_owned(), number_cell(30.0));
        r2.insert("c_status".to_owned(), text_cell("done"));

        BaseDocument {
            version: 1,
            sheets: vec![BaseSheet {
                id: "s1".to_owned(),
                name: "Metrics".to_owned(),
                columns: vec![
                    BaseColumn {
                        id: "c_title".to_owned(),
                        name: "Title".to_owned(),
                        kind: vibevalley_protocol::BaseColumnKind::Text,
                        options: None,
                        agent_config: None,
                        formula: None,
                        width: None,
                    },
                    BaseColumn {
                        id: "c_score".to_owned(),
                        name: "Score".to_owned(),
                        kind: vibevalley_protocol::BaseColumnKind::Number,
                        options: None,
                        agent_config: None,
                        formula: None,
                        width: None,
                    },
                    BaseColumn {
                        id: "c_status".to_owned(),
                        name: "Status".to_owned(),
                        kind: vibevalley_protocol::BaseColumnKind::Select,
                        options: None,
                        agent_config: None,
                        formula: None,
                        width: None,
                    },
                ],
                rows: vec![
                    BaseRow {
                        id: "r1".to_owned(),
                        cells: r1,
                        page_note_id: None,
                        annotation_ref: None,
                        created_at: 1,
                        updated_at: 1,
                    },
                    BaseRow {
                        id: "r2".to_owned(),
                        cells: r2,
                        page_note_id: None,
                        annotation_ref: None,
                        created_at: 2,
                        updated_at: 2,
                    },
                ],
                views: vec![BaseViewConfig {
                    id: "v1".to_owned(),
                    name: "Board".to_owned(),
                    kind: BaseViewKind::Board,
                    group_by: Some("c_status".to_owned()),
                    hidden_columns: None,
                    filters: Some(vec![BaseFilterRule {
                        column_id: "c_title".to_owned(),
                        op: BaseFilterOp::NotEmpty,
                        value: None,
                    }]),
                    sorts: Some(vec![BaseSortRule {
                        column_id: "c_score".to_owned(),
                        desc: true,
                    }]),
                    summaries: Some(vec![
                        BaseSummaryConfig {
                            column_id: "c_score".to_owned(),
                            op: BaseSummaryOp::Sum,
                        },
                        BaseSummaryConfig {
                            column_id: "c_score".to_owned(),
                            op: BaseSummaryOp::Avg,
                        },
                    ]),
                }],
            }],
        }
    }

    #[test]
    fn projects_filtered_sorted_grouped_and_summarized_snapshot() {
        let doc = sample_base_doc();
        let mut files = BTreeMap::new();
        files.insert("structure/base.json".to_owned(), serialize_base_document(&doc).unwrap().into_bytes());
        let snap = project_base_view(
            "n_base",
            &files,
            &BaseViewRequest {
                id: "n_base".to_owned(),
                sheet_id: None,
                view_id: None,
            },
        )
        .unwrap();
        assert_eq!(snap.rows[0].id, "r2");
        assert_eq!(snap.groups.len(), 2);
        assert_eq!(snap.summaries[0].value, "40");
        assert_eq!(snap.summaries[1].value, "20");

        let prompt = format_agent_prompt("Evaluate {{Title}} ({{c_score}})", &doc.sheets[0], &doc.sheets[0].rows[0]);
        assert_eq!(prompt, "Evaluate Alpha (10)");
    }

    #[test]
    fn evaluates_formulas_noteref_and_page_note_id_links_without_panics() {
        let mut r1_cells = BTreeMap::new();
        r1_cells.insert("c_title".to_owned(), text_cell("Spec Alpha"));
        r1_cells.insert("c_qty".to_owned(), number_cell(4.0));
        r1_cells.insert("c_price".to_owned(), number_cell(12.5));
        r1_cells.insert(
            "c_tags".to_owned(),
            BaseCellValue::Strings {
                items: vec!["a".into(), "b".into()],
            },
        );
        r1_cells.insert("c_ref".to_owned(), BaseCellValue::NoteRef { note_id: "n_linked".into() });

        let mut r2_cells = BTreeMap::new();
        r2_cells.insert("c_title".to_owned(), text_cell("Zero Denom"));
        r2_cells.insert("c_qty".to_owned(), number_cell(0.0));
        r2_cells.insert("c_price".to_owned(), number_cell(5.0));

        let mk_col = |id: &str, name: &str, kind: BaseColumnKind, formula: Option<&str>| BaseColumn {
            id: id.to_owned(),
            name: name.to_owned(),
            kind,
            options: None,
            agent_config: None,
            formula: formula.map(str::to_owned),
            width: None,
        };

        let doc = BaseDocument {
            version: 1,
            sheets: vec![BaseSheet {
                id: "s1".to_owned(),
                name: "Formulas".to_owned(),
                columns: vec![
                    mk_col("c_title", "Title", BaseColumnKind::Text, None),
                    mk_col("c_qty", "Qty", BaseColumnKind::Number, None),
                    mk_col("c_price", "Unit Price", BaseColumnKind::Number, None),
                    mk_col("c_tags", "Tags", BaseColumnKind::MultiSelect, None),
                    mk_col("c_ref", "Ref Note", BaseColumnKind::NoteRef, None),
                    mk_col("f_total", "Total", BaseColumnKind::Formula, Some("({c_qty} + 1) * {Unit Price} - 2.5")),
                    mk_col("f_label", "Label", BaseColumnKind::Formula, Some("concat({Title}, \" -> \", {f_total})")),
                    mk_col("f_count", "Tag Count", BaseColumnKind::Formula, Some("count({Tags}, {Ref Note})")),
                    mk_col(
                        "f_safe_div",
                        "Safe Div",
                        BaseColumnKind::Formula,
                        Some("if({Qty} == 0, \"none\", {Unit Price} / {Qty})"),
                    ),
                    mk_col("f_bad", "Bad", BaseColumnKind::Formula, Some("1 / 0 + unknownFn(")),
                ],
                rows: vec![
                    BaseRow {
                        id: "r1".to_owned(),
                        cells: r1_cells,
                        page_note_id: Some("n_child_page".to_owned()),
                        annotation_ref: None,
                        created_at: 1,
                        updated_at: 1,
                    },
                    BaseRow {
                        id: "r2".to_owned(),
                        cells: r2_cells,
                        page_note_id: None,
                        annotation_ref: None,
                        created_at: 2,
                        updated_at: 2,
                    },
                ],
                views: vec![BaseViewConfig {
                    id: "v1".to_owned(),
                    name: "Table".to_owned(),
                    kind: BaseViewKind::Table,
                    group_by: None,
                    hidden_columns: None,
                    filters: None,
                    sorts: None,
                    summaries: Some(vec![BaseSummaryConfig {
                        column_id: "f_total".to_owned(),
                        op: BaseSummaryOp::Sum,
                    }]),
                }],
            }],
        };

        let mut files = BTreeMap::new();
        files.insert("structure/base.json".to_owned(), serialize_base_document(&doc).unwrap().into_bytes());

        let snap = project_base_view(
            "n_base",
            &files,
            &BaseViewRequest {
                id: "n_base".to_owned(),
                sheet_id: None,
                view_id: None,
            },
        )
        .unwrap();

        let r1 = snap.rows.iter().find(|r| r.id == "r1").unwrap();
        assert_eq!(r1.page_note_id.as_deref(), Some("n_child_page"));
        assert_eq!(cell_as_text(&r1.cells["c_ref"]), "n_linked");
        assert!(!cell_is_empty(r1.cells.get("c_ref")));
        assert_eq!(cell_as_text(&r1.cells["f_total"]), "60");
        assert_eq!(cell_as_text(&r1.cells["f_label"]), "Spec Alpha -> 60");
        assert_eq!(cell_as_text(&r1.cells["f_count"]), "3");
        assert_eq!(cell_as_text(&r1.cells["f_safe_div"]), "3.125");
        assert_eq!(cell_as_text(&r1.cells["f_bad"]), "—");

        let r2 = snap.rows.iter().find(|r| r.id == "r2").unwrap();
        assert_eq!(cell_as_text(&r2.cells["f_total"]), "2.5");
        assert_eq!(cell_as_text(&r2.cells["f_safe_div"]), "none");
        assert_eq!(snap.summaries[0].value, "62.5");

        let links = extract_base_links(&files);
        assert!(links.iter().any(|l| l.kind == LinkEntityKind::Note && l.id == "n_child_page"));
        assert!(links.iter().any(|l| l.kind == LinkEntityKind::Note && l.id == "n_linked"));
    }

    #[test]
    fn regression_project_base_view_resolves_view_kinds_and_empty_view_id_without_dropping_rows() {
        let mut cells = BTreeMap::new();
        cells.insert("c_title".to_owned(), BaseCellValue::Text { value: "Item 1".to_owned() });
        cells.insert("c_status".to_owned(), BaseCellValue::Text { value: "doing".to_owned() });

        let doc = BaseDocument {
            version: 1,
            sheets: vec![BaseSheet {
                id: "s1".to_owned(),
                name: "Tasks".to_owned(),
                columns: vec![
                    BaseColumn {
                        id: "c_title".to_owned(),
                        name: "Title".to_owned(),
                        kind: BaseColumnKind::Text,
                        options: None,
                        agent_config: None,
                        formula: None,
                        width: None,
                    },
                    BaseColumn {
                        id: "c_status".to_owned(),
                        name: "Status".to_owned(),
                        kind: BaseColumnKind::Select,
                        options: Some(vec![
                            vibevalley_protocol::BaseSelectOption {
                                value: "todo".to_owned(),
                                label: Some("Todo".to_owned()),
                                color: Some("stone".to_owned()),
                            },
                            vibevalley_protocol::BaseSelectOption {
                                value: "doing".to_owned(),
                                label: Some("Doing".to_owned()),
                                color: Some("amber".to_owned()),
                            },
                        ]),
                        agent_config: None,
                        formula: None,
                        width: None,
                    },
                ],
                rows: vec![BaseRow {
                    id: "r1".to_owned(),
                    cells,
                    page_note_id: None,
                    annotation_ref: None,
                    created_at: 1,
                    updated_at: 1,
                }],
                views: vec![
                    BaseViewConfig {
                        id: "v_table".to_owned(),
                        name: "Table".to_owned(),
                        kind: BaseViewKind::Table,
                        group_by: None,
                        hidden_columns: None,
                        filters: None,
                        sorts: None,
                        summaries: None,
                    },
                    BaseViewConfig {
                        id: "v_board".to_owned(),
                        name: "Board".to_owned(),
                        kind: BaseViewKind::Board,
                        group_by: Some("c_status".to_owned()),
                        hidden_columns: None,
                        filters: None,
                        sorts: None,
                        summaries: None,
                    },
                ],
            }],
        };

        let mut files = BTreeMap::new();
        files.insert("structure/base.json".to_owned(), serialize_base_document(&doc).unwrap().into_bytes());

        let board_by_kind = project_base_view(
            "n_base",
            &files,
            &BaseViewRequest {
                id: "n_base".to_owned(),
                sheet_id: Some("s1".to_owned()),
                view_id: Some("board".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(board_by_kind.active_view_id, "v_board");
        assert_eq!(board_by_kind.active_view_kind, BaseViewKind::Board);
        assert_eq!(board_by_kind.rows.len(), 1);
        assert_eq!(board_by_kind.groups.len(), 2);

        let gallery_fallback = project_base_view(
            "n_base",
            &files,
            &BaseViewRequest {
                id: "n_base".to_owned(),
                sheet_id: Some("s1".to_owned()),
                view_id: Some("gallery".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(gallery_fallback.active_view_kind, BaseViewKind::Gallery);
        assert_eq!(gallery_fallback.rows.len(), 1);

        let empty_view = project_base_view(
            "n_base",
            &files,
            &BaseViewRequest {
                id: "n_base".to_owned(),
                sheet_id: Some("s1".to_owned()),
                view_id: Some(String::new()),
            },
        )
        .unwrap();
        assert_eq!(empty_view.active_view_id, "v_table");
        assert_eq!(empty_view.rows.len(), 1);
    }
}
