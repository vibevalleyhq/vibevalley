//! Structured Block Doc kernel (`#38`, `#39`):
//! - [`DocDocument`] stored in `structure/doc.json`
//! - Markdown <-> [`DocBlock`] lossless-friendly conversion
//! - Link extraction (`extract_doc_links`) spanning embeds and wikilinks
//! - View projection (`project_doc_view`) for `/notes` and `vv_doc_*` MCP tools

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{BlockKind, DocBlock, DocView, LinkEntityKind, LinkRelation, NoteLinkRef};

use crate::note::links::{dedup_links, extract_markdown_links};

/// Current `structure/doc.json` schema version.
pub const DOC_SCHEMA_VERSION: u32 = 1;

/// On-disk JSON shape of `structure/doc.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocDocument {
    pub version: u32,
    pub blocks: Vec<DocBlock>,
}

impl Default for DocDocument {
    fn default() -> Self {
        Self {
            version: DOC_SCHEMA_VERSION,
            blocks: Vec::new(),
        }
    }
}

pub fn parse_doc_document(raw: &str) -> Result<DocDocument, String> {
    let mut doc: DocDocument = serde_json::from_str(raw).map_err(|e| format!("invalid doc.json: {e}"))?;
    if doc.version == 0 {
        doc.version = DOC_SCHEMA_VERSION;
    }
    Ok(doc)
}

pub fn serialize_doc_document(doc: &DocDocument) -> Result<String, String> {
    let mut out = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Parses a Markdown pipe row (`| a | b |`) into trimmed cells.
fn parse_pipe_row(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !trimmed.contains('|') {
        return None;
    }
    let inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    let cells: Vec<String> = inner.split('|').map(|c| c.trim().to_owned()).collect();
    (!cells.is_empty()).then_some(cells)
}

/// Parses a Markdown table separator row (`| :--- | :---: | ---: |`).
fn parse_table_separator(line: &str, col_count: usize) -> Option<Vec<String>> {
    let cells = parse_pipe_row(line)?;
    if cells.len() != col_count {
        return None;
    }
    let mut aligns = Vec::with_capacity(cells.len());
    for cell in cells {
        let c = cell.trim();
        let dashes = c.trim_start_matches(':').trim_end_matches(':');
        if dashes.len() < 3 || !dashes.chars().all(|ch| ch == '-') {
            return None;
        }
        let align = match (c.starts_with(':'), c.ends_with(':')) {
            (true, true) => "center",
            (true, false) => "left",
            (false, true) => "right",
            (false, false) => "",
        };
        aligns.push(align.to_owned());
    }
    Some(aligns)
}

/// Converts Markdown lines into a flat sequence of [`DocBlock`]s.
pub fn markdown_to_blocks(md: &str) -> Vec<DocBlock> {
    let mut blocks = Vec::new();
    let mut idx = 1usize;
    let mut next_id = || {
        let id = format!("b{idx}");
        idx += 1;
        id
    };

    let lines: Vec<&str> = md.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        if trimmed == "---" || trimmed == "***" {
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Divider,
                collapsed: None,
                children: None,
            });
            i += 1;
            continue;
        }
        if let Some(rest_after_open) = trimmed.strip_prefix("$$") {
            let expression = if let Some(inline) = rest_after_open.strip_suffix("$$")
                && !rest_after_open.is_empty()
            {
                i += 1;
                inline.trim().to_owned()
            } else {
                i += 1;
                let mut expr_lines = Vec::new();
                while i < lines.len() && !lines[i].trim().starts_with("$$") {
                    expr_lines.push(lines[i]);
                    i += 1;
                }
                if i < lines.len() {
                    i += 1;
                }
                expr_lines.join("\n").trim().to_owned()
            };
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Math {
                    expression,
                    display: Some(true),
                },
                collapsed: None,
                children: None,
            });
            continue;
        }
        if let Some(fence_lang) = trimmed.strip_prefix("```") {
            let lang = Some(fence_lang.trim()).filter(|s| !s.is_empty()).map(str::to_owned);
            i += 1;
            let mut code_lines = Vec::new();
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                code_lines.push(lines[i]);
                i += 1;
            }
            if i < lines.len() {
                i += 1;
            }
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Code {
                    language: lang,
                    code: code_lines.join("\n"),
                },
                collapsed: None,
                children: None,
            });
            continue;
        }
        if let Some(headers) = parse_pipe_row(trimmed)
            && i + 1 < lines.len()
            && let Some(aligns) = parse_table_separator(lines[i + 1], headers.len())
        {
            i += 2;
            let mut rows = Vec::new();
            while i < lines.len()
                && !lines[i].trim().is_empty()
                && let Some(mut row) = parse_pipe_row(lines[i])
            {
                row.resize(headers.len(), String::new());
                row.truncate(headers.len());
                rows.push(row);
                i += 1;
            }
            let alignments = aligns.iter().any(|a| !a.is_empty()).then_some(aligns);
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Table { headers, rows, alignments },
                collapsed: None,
                children: None,
            });
            continue;
        }
        if trimmed.starts_with("> ") || trimmed == ">" {
            let mut quote_lines = Vec::new();
            while i < lines.len() {
                let t = lines[i].trim();
                if let Some(rest) = t.strip_prefix("> ") {
                    quote_lines.push(rest.trim_end().to_owned());
                    i += 1;
                } else if t == ">" {
                    quote_lines.push(String::new());
                    i += 1;
                } else {
                    break;
                }
            }
            let attribution = quote_lines
                .last()
                .and_then(|last| last.strip_prefix("— ").or_else(|| last.strip_prefix("-- ")))
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            if attribution.is_some() {
                quote_lines.pop();
            }
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Quote {
                    text: quote_lines.join("\n"),
                    attribution,
                },
                collapsed: None,
                children: None,
            });
            continue;
        }
        let hash_count = trimmed.bytes().take_while(|&b| b == b'#').count();
        if (1..=3).contains(&hash_count) && trimmed.as_bytes().get(hash_count) == Some(&b' ') {
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Heading {
                    level: hash_count as u8,
                    text: trimmed[hash_count + 1..].trim().to_owned(),
                },
                collapsed: None,
                children: None,
            });
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- [x] ").or_else(|| trimmed.strip_prefix("- [X] ")) {
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Todo {
                    checked: true,
                    text: rest.trim().to_owned(),
                },
                collapsed: None,
                children: None,
            });
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- [ ] ") {
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::Todo {
                    checked: false,
                    text: rest.trim().to_owned(),
                },
                collapsed: None,
                children: None,
            });
            i += 1;
            continue;
        }
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let mut items = Vec::new();
            while i < lines.len() {
                let t = lines[i].trim();
                if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* "))
                    && !rest.starts_with("[ ] ")
                    && !rest.starts_with("[x] ")
                    && !rest.starts_with("[X] ")
                {
                    items.push(rest.trim().to_owned());
                    i += 1;
                } else {
                    break;
                }
            }
            blocks.push(DocBlock {
                id: next_id(),
                kind: BlockKind::List { ordered: false, items },
                collapsed: None,
                children: None,
            });
            continue;
        }

        let mut para = vec![line.trim_end()];
        i += 1;
        while i < lines.len() {
            let t = lines[i].trim();
            if t.is_empty()
                || t.starts_with('#')
                || t.starts_with("```")
                || t.starts_with("$$")
                || t.starts_with("> ")
                || t == ">"
                || t.starts_with("- ")
                || t.starts_with("* ")
                || t == "---"
                || t == "***"
                || (parse_pipe_row(t).is_some()
                    && i + 1 < lines.len()
                    && parse_pipe_row(t).is_some_and(|h| parse_table_separator(lines[i + 1], h.len()).is_some()))
            {
                break;
            }
            para.push(lines[i].trim_end());
            i += 1;
        }
        blocks.push(DocBlock {
            id: next_id(),
            kind: BlockKind::Prose { text: para.join("\n") },
            collapsed: None,
            children: None,
        });
    }
    blocks
}

fn push_block_markdown(block: &DocBlock, out: &mut Vec<String>) {
    match &block.kind {
        BlockKind::Prose { text } => {
            if !text.trim().is_empty() {
                out.push(text.clone());
            }
        }
        BlockKind::Heading { level, text } => {
            let hashes = "#".repeat(usize::from((*level).clamp(1, 6)));
            out.push(format!("{hashes} {text}"));
        }
        BlockKind::List { ordered, items } => {
            let lines: Vec<String> = items
                .iter()
                .enumerate()
                .map(|(idx, item)| if *ordered { format!("{}. {item}", idx + 1) } else { format!("- {item}") })
                .collect();
            out.push(lines.join("\n"));
        }
        BlockKind::Todo { checked, text } => {
            let mark = if *checked { "x" } else { " " };
            out.push(format!("- [{mark}] {text}"));
        }
        BlockKind::Callout { title, text, .. } => {
            if let Some(t) = title {
                out.push(format!("> **{t}**\n> {text}"));
            } else {
                out.push(format!("> {text}"));
            }
        }
        BlockKind::Code { language, code } => {
            let lang = language.as_deref().unwrap_or("");
            out.push(format!("```{lang}\n{code}\n```"));
        }
        BlockKind::Divider | BlockKind::PageBreak { .. } => out.push("---".to_owned()),
        BlockKind::BaseEmbed { note_id, .. } => out.push(format!("![[note:{note_id}]]")),
        BlockKind::IssueCard { issue_id } => out.push(format!("![[issue:{issue_id}]]")),
        BlockKind::IssueList { repo, .. } => {
            let label = repo.as_deref().unwrap_or("all");
            out.push(format!("<!-- issue-list:{label} -->"));
        }
        BlockKind::Kpi { items } => {
            let lines: Vec<String> = items.iter().map(|it| format!("- **{}**: {}", it.label, it.value)).collect();
            out.push(lines.join("\n"));
        }
        BlockKind::Diagram { source, .. } => out.push(format!("```mermaid\n{source}\n```")),
        BlockKind::Chart { title, .. } => {
            out.push(format!("<!-- chart:{} -->", title.as_deref().unwrap_or("chart")));
        }
        BlockKind::Compare {
            title,
            before_label,
            after_label,
            ..
        } => {
            out.push(format!(
                "<!-- compare:{} ({before_label} vs {after_label}) -->",
                title.as_deref().unwrap_or("diff")
            ));
        }
        BlockKind::Media { media_kind, src, caption } => {
            out.push(format!("![{} ({media_kind})]({src})", caption.as_deref().unwrap_or("media")));
        }
        BlockKind::Preview { title, entry, .. } => {
            out.push(format!("<!-- preview:{} ({entry}) -->", title.as_deref().unwrap_or("preview")));
        }
        BlockKind::Columns { columns } => {
            for col in columns {
                for b in &col.blocks {
                    push_block_markdown(b, out);
                }
            }
        }
        BlockKind::Quote { text, attribution } => {
            let mut lines: Vec<String> = text.lines().map(|l| format!("> {l}")).collect();
            if lines.is_empty() {
                lines.push(">".to_owned());
            }
            if let Some(attr) = attribution.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                lines.push(format!("> — {attr}"));
            }
            out.push(lines.join("\n"));
        }
        BlockKind::Toggle { title, text } => {
            let body = text.trim();
            if body.is_empty() {
                out.push(format!("<details>\n<summary>{title}</summary>\n</details>"));
            } else {
                out.push(format!("<details>\n<summary>{title}</summary>\n\n{body}\n</details>"));
            }
        }
        BlockKind::Table { headers, rows, alignments } => {
            if !headers.is_empty() {
                let mut table_lines = vec![format!("| {} |", headers.join(" | "))];
                let sep: Vec<&str> = (0..headers.len())
                    .map(|idx| match alignments.as_ref().and_then(|a| a.get(idx)).map(String::as_str) {
                        Some("left") => ":---",
                        Some("center") => ":---:",
                        Some("right") => "---:",
                        _ => "---",
                    })
                    .collect();
                table_lines.push(format!("| {} |", sep.join(" | ")));
                for row in rows {
                    let padded: Vec<&str> = (0..headers.len()).map(|idx| row.get(idx).map(String::as_str).unwrap_or("")).collect();
                    table_lines.push(format!("| {} |", padded.join(" | ")));
                }
                out.push(table_lines.join("\n"));
            }
        }
        BlockKind::Bookmark { url, title, description } => {
            let label = title.as_deref().filter(|s| !s.is_empty()).unwrap_or(url);
            match description.as_deref().filter(|s| !s.is_empty()) {
                Some(desc) => out.push(format!("[{label}]({url}) — {desc}")),
                None => out.push(format!("[{label}]({url})")),
            }
        }
        BlockKind::Toc { .. } => out.push("<!-- toc -->".to_owned()),
        BlockKind::Math { expression, display } => {
            if display.unwrap_or(true) {
                out.push(format!("$$\n{expression}\n$$"));
            } else {
                out.push(format!("${expression}$"));
            }
        }
    }
    if let Some(children) = &block.children {
        for child in children {
            push_block_markdown(child, out);
        }
    }
}

/// Renders structured [`DocBlock`]s into readable Markdown (used for AI export / link extraction).
pub fn blocks_to_markdown(blocks: &[DocBlock]) -> String {
    let mut parts = Vec::new();
    for block in blocks {
        push_block_markdown(block, &mut parts);
    }
    parts.join("\n\n")
}

fn collect_links_rec(blocks: &[DocBlock], out: &mut Vec<NoteLinkRef>) {
    for block in blocks {
        match &block.kind {
            BlockKind::BaseEmbed { note_id, .. } => out.push(NoteLinkRef {
                kind: LinkEntityKind::Note,
                id: note_id.clone(),
                relation: LinkRelation::Embed,
                title: None,
            }),
            BlockKind::IssueCard { issue_id } => out.push(NoteLinkRef {
                kind: LinkEntityKind::Issue,
                id: issue_id.clone(),
                relation: LinkRelation::Embed,
                title: None,
            }),
            BlockKind::Prose { text } | BlockKind::Heading { text, .. } | BlockKind::Todo { text, .. } | BlockKind::Quote { text, .. } => {
                out.extend(extract_markdown_links(text));
            }
            BlockKind::Callout { title, text, .. } => {
                if let Some(title_text) = title {
                    out.extend(extract_markdown_links(title_text));
                }
                out.extend(extract_markdown_links(text));
            }
            BlockKind::Toggle { title, text } => {
                out.extend(extract_markdown_links(title));
                out.extend(extract_markdown_links(text));
            }
            BlockKind::Table { headers, rows, .. } => {
                for h in headers {
                    out.extend(extract_markdown_links(h));
                }
                for row in rows {
                    for cell in row {
                        out.extend(extract_markdown_links(cell));
                    }
                }
            }
            BlockKind::List { items, .. } => {
                for item in items {
                    out.extend(extract_markdown_links(item));
                }
            }
            BlockKind::Columns { columns } => {
                for col in columns {
                    collect_links_rec(&col.blocks, out);
                }
            }
            BlockKind::Code { .. }
            | BlockKind::Kpi { .. }
            | BlockKind::Chart { .. }
            | BlockKind::Diagram { .. }
            | BlockKind::Compare { .. }
            | BlockKind::Media { .. }
            | BlockKind::Preview { .. }
            | BlockKind::IssueList { .. }
            | BlockKind::PageBreak { .. }
            | BlockKind::Bookmark { .. }
            | BlockKind::Toc { .. }
            | BlockKind::Math { .. }
            | BlockKind::Divider => {}
        }
        if let Some(children) = &block.children {
            collect_links_rec(children, out);
        }
    }
}

/// Extracts deduplicated outgoing note/issue links from structured doc blocks.
pub fn extract_doc_links(blocks: &[DocBlock]) -> Vec<NoteLinkRef> {
    let mut raw = Vec::new();
    collect_links_rec(blocks, &mut raw);
    dedup_links(raw)
}

fn insert_block_rec(blocks: &mut Vec<DocBlock>, block: &DocBlock, after_id: &str) -> bool {
    for idx in 0..blocks.len() {
        if blocks[idx].id == after_id {
            blocks.insert(idx + 1, block.clone());
            return true;
        }
        if let Some(children) = &mut blocks[idx].children
            && insert_block_rec(children, block, after_id)
        {
            return true;
        }
    }
    false
}

/// Appends `block` after `after_block_id` when found, or at the end of `doc.blocks`.
pub fn append_block(doc: &mut DocDocument, block: DocBlock, after_block_id: Option<&str>) {
    if let Some(target_id) = after_block_id
        && insert_block_rec(&mut doc.blocks, &block, target_id)
    {
        return;
    }
    doc.blocks.push(block);
}

fn count_words(blocks: &[DocBlock]) -> (u32, u32) {
    let mut words = 0u32;
    let mut breaks = 0u32;
    for block in blocks {
        match &block.kind {
            BlockKind::Prose { text } | BlockKind::Heading { text, .. } | BlockKind::Todo { text, .. } => {
                words += text.split_whitespace().count() as u32;
            }
            BlockKind::Quote { text, attribution } => {
                words += text.split_whitespace().count() as u32;
                if let Some(attr) = attribution {
                    words += attr.split_whitespace().count() as u32;
                }
            }
            BlockKind::Toggle { title, text } => {
                words += title.split_whitespace().count() as u32;
                words += text.split_whitespace().count() as u32;
            }
            BlockKind::Table { headers, rows, .. } => {
                for h in headers {
                    words += h.split_whitespace().count() as u32;
                }
                for row in rows {
                    for cell in row {
                        words += cell.split_whitespace().count() as u32;
                    }
                }
            }
            BlockKind::Bookmark { title, description, .. } => {
                if let Some(t) = title {
                    words += t.split_whitespace().count() as u32;
                }
                if let Some(d) = description {
                    words += d.split_whitespace().count() as u32;
                }
            }
            BlockKind::Math { expression, .. } => {
                words += expression.split_whitespace().count() as u32;
            }
            BlockKind::Callout { title, text, .. } => {
                words += text.split_whitespace().count() as u32;
                if let Some(t) = title {
                    words += t.split_whitespace().count() as u32;
                }
            }
            BlockKind::List { items, .. } => {
                for item in items {
                    words += item.split_whitespace().count() as u32;
                }
            }
            BlockKind::Code { code, .. } => {
                words += code.split_whitespace().count() as u32;
            }
            BlockKind::PageBreak { .. } => {
                breaks += 1;
            }
            BlockKind::Columns { columns } => {
                for col in columns {
                    let (w, b) = count_words(&col.blocks);
                    words += w;
                    breaks += b;
                }
            }
            BlockKind::Kpi { .. }
            | BlockKind::Chart { .. }
            | BlockKind::Diagram { .. }
            | BlockKind::Compare { .. }
            | BlockKind::Media { .. }
            | BlockKind::Preview { .. }
            | BlockKind::BaseEmbed { .. }
            | BlockKind::IssueCard { .. }
            | BlockKind::IssueList { .. }
            | BlockKind::Toc { .. }
            | BlockKind::Divider => {}
        }
        if let Some(children) = &block.children {
            let (w, b) = count_words(children);
            words += w;
            breaks += b;
        }
    }
    (words, breaks)
}

/// Projects a note directory's `structure/doc.json` (or fallback `structure/index.md`) into [`DocView`].
pub fn project_doc_view(note_id: &str, title: &str, files: &BTreeMap<String, Vec<u8>>) -> DocView {
    let blocks = if let Some(bytes) = files.get("structure/doc.json")
        && let Ok(raw) = std::str::from_utf8(bytes)
        && let Ok(doc) = parse_doc_document(raw)
    {
        doc.blocks
    } else if let Some(bytes) = files.get("structure/index.md")
        && let Ok(raw) = std::str::from_utf8(bytes)
    {
        markdown_to_blocks(raw)
    } else {
        Vec::new()
    };

    let (word_count, page_breaks) = count_words(&blocks);
    let extracted_links = extract_doc_links(&blocks);

    DocView {
        note_id: note_id.to_owned(),
        title: title.to_owned(),
        blocks,
        slide_count: page_breaks + 1,
        word_count,
        extracted_links,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_roundtrip_and_doc_view_projection() {
        let md = "# Roadmap\n\nShip [[note:n2]] and ![[issue:i5]].\n\n- [x] Proto\n- [ ] UI\n\n```rust\nfn main() {}\n```\n";
        let blocks = markdown_to_blocks(md);
        assert_eq!(blocks.len(), 5);
        let doc = DocDocument { version: 1, blocks };
        let json = serialize_doc_document(&doc).unwrap();
        let mut files = BTreeMap::new();
        files.insert("structure/doc.json".to_owned(), json.into_bytes());

        let view = project_doc_view("n1", "Roadmap", &files);
        assert_eq!(view.slide_count, 1);
        assert!(view.word_count >= 9);
        assert_eq!(view.extracted_links.len(), 2);
        assert_eq!(view.extracted_links[0].kind, LinkEntityKind::Note);
        assert_eq!(view.extracted_links[1].relation, LinkRelation::Embed);
    }

    #[test]
    fn append_block_inserts_after_target_and_extracts_base_embed() {
        let mut doc = DocDocument {
            version: 1,
            blocks: vec![
                DocBlock {
                    id: "b1".to_owned(),
                    kind: BlockKind::Heading {
                        level: 1,
                        text: "Spec".to_owned(),
                    },
                    collapsed: None,
                    children: None,
                },
                DocBlock {
                    id: "b2".to_owned(),
                    kind: BlockKind::PageBreak {
                        title: Some("Slide 2".to_owned()),
                        speaker_notes: None,
                    },
                    collapsed: None,
                    children: None,
                },
            ],
        };
        append_block(
            &mut doc,
            DocBlock {
                id: "b_embed".to_owned(),
                kind: BlockKind::BaseEmbed {
                    note_id: "base-1".to_owned(),
                    sheet_id: Some("sheet1".to_owned()),
                    view_id: None,
                },
                collapsed: None,
                children: None,
            },
            Some("b1"),
        );
        assert_eq!(doc.blocks[1].id, "b_embed");
        let links = extract_doc_links(&doc.blocks);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].id, "base-1");
        assert_eq!(links[0].relation, LinkRelation::Embed);
    }

    #[test]
    fn quote_table_math_toggle_bookmark_toc_roundtrip_and_links() {
        let md = "> Clarity beats cleverness [[note:n9]]\n> — Design Guild\n\n| Name | Link |\n| :--- | ---: |\n| Alpha | [[issue:i7]] |\n\n$$\nE = mc^2\n$$\n";
        let mut blocks = markdown_to_blocks(md);
        assert_eq!(blocks.len(), 3);
        assert!(
            matches!(&blocks[0].kind, BlockKind::Quote { text, attribution } if text.contains("Clarity") && attribution.as_deref() == Some("Design Guild"))
        );
        assert!(
            matches!(&blocks[1].kind, BlockKind::Table { headers, rows, alignments } if headers == &["Name", "Link"] && rows.len() == 1 && alignments.as_deref() == Some(&["left".to_owned(), "right".to_owned()]))
        );
        assert!(matches!(&blocks[2].kind, BlockKind::Math { expression, display } if expression == "E = mc^2" && *display == Some(true)));

        blocks.push(DocBlock {
            id: "b_toggle".to_owned(),
            kind: BlockKind::Toggle {
                title: "Details [[note:n10]]".to_owned(),
                text: "Hidden body".to_owned(),
            },
            collapsed: Some(true),
            children: None,
        });
        blocks.push(DocBlock {
            id: "b_bm".to_owned(),
            kind: BlockKind::Bookmark {
                url: "https://vibevalley.dev".to_owned(),
                title: Some("VibeValley".to_owned()),
                description: Some("Home".to_owned()),
            },
            collapsed: None,
            children: None,
        });
        blocks.push(DocBlock {
            id: "b_toc".to_owned(),
            kind: BlockKind::Toc { max_level: Some(3) },
            collapsed: None,
            children: None,
        });
        blocks.push(DocBlock {
            id: "b_callout".to_owned(),
            kind: BlockKind::Callout {
                tone: "info".to_owned(),
                title: Some("See [[note:n11]]".to_owned()),
                text: "Follow up on #12".to_owned(),
            },
            collapsed: None,
            children: None,
        });

        let rendered = blocks_to_markdown(&blocks);
        assert!(rendered.contains("> — Design Guild"));
        assert!(rendered.contains("| :--- | ---: |"));
        assert!(rendered.contains("$$\nE = mc^2\n$$"));
        assert!(rendered.contains("<details>\n<summary>Details [[note:n10]]</summary>"));
        assert!(rendered.contains("[VibeValley](https://vibevalley.dev) — Home"));
        assert!(rendered.contains("<!-- toc -->"));
        assert!(rendered.contains("> **See [[note:n11]]**\n> Follow up on #12"));

        let links = extract_doc_links(&blocks);
        assert_eq!(links.len(), 5);
        assert!(links.iter().any(|l| l.kind == LinkEntityKind::Note && l.id == "n11"));
        assert!(links.iter().any(|l| l.kind == LinkEntityKind::Issue && l.id == "12"));
        let (words, _) = count_words(&blocks);
        assert!(words >= 12);
    }
}
