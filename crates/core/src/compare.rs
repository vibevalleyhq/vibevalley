//! Parsing, validation, and formatting for fenced `compare` Markdown blocks
//! plus board-card image preview extraction.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use vibevalley_protocol::{
    BoardCardPreview, CompareAnnotation, CompareAnnotationSide, CompareAnnotationTone, CompareImage, CompareMarkdownSegment, CompareSpec, Issue,
};

static FENCE_OPEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$").expect("valid compare fence regex"));

fn has_non_empty(opt: Option<&String>) -> bool {
    opt.is_some_and(|s| !s.is_empty())
}

fn validate_image(img: &CompareImage) -> bool {
    if img.attachment.as_ref().is_some_and(String::is_empty) {
        return false;
    }
    if img.url.as_ref().is_some_and(String::is_empty) {
        return false;
    }
    has_non_empty(img.attachment.as_ref()) || has_non_empty(img.url.as_ref())
}

fn validate_annotation(ann: &CompareAnnotation) -> bool {
    ann.n > 0 && ann.rect.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v))
}

/// Parses and validates raw JSON from a fenced `compare` block; returns `None` on malformed input.
pub fn parse_compare_spec(raw: &str) -> Option<CompareSpec> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let spec: CompareSpec = serde_json::from_str(trimmed).ok()?;
    if spec.before.is_none() && spec.after.is_none() && spec.image.is_none() {
        return None;
    }
    if let Some(before) = &spec.before
        && !validate_image(before)
    {
        return None;
    }
    if let Some(after) = &spec.after
        && !validate_image(after)
    {
        return None;
    }
    if let Some(image) = &spec.image
        && !validate_image(image)
    {
        return None;
    }
    if let Some(annotations) = &spec.annotations
        && !annotations.iter().all(validate_annotation)
    {
        return None;
    }
    Some(spec)
}

fn is_closing_fence(line: &str, marker_char: char, min_len: usize) -> bool {
    let mut trimmed = line;
    let mut leading_ws = 0usize;
    for ch in line.chars() {
        if (ch == ' ' || ch == '\t') && leading_ws < 3 {
            leading_ws += 1;
            trimmed = &trimmed[ch.len_utf8()..];
        } else {
            break;
        }
    }
    let trimmed = trimmed.trim_end_matches([' ', '\t']);
    let mut count = 0usize;
    for ch in trimmed.chars() {
        if ch != marker_char {
            return false;
        }
        count += 1;
    }
    count >= min_len
}

fn strip_outer_blank_lines(text: &str) -> &str {
    let mut s = text;
    while let Some(nl) = s.find('\n') {
        if s[..nl].chars().all(|c| c == ' ' || c == '\t') {
            s = &s[nl + 1..];
        } else {
            break;
        }
    }
    while let Some(nl) = s.rfind('\n') {
        if s[nl + 1..].chars().all(|c| c == ' ' || c == '\t') {
            s = &s[..nl];
        } else {
            break;
        }
    }
    s
}

fn append_markdown(out: &mut Vec<CompareMarkdownSegment>, text: &str) {
    let normalized = strip_outer_blank_lines(text);
    if normalized.trim().is_empty() {
        return;
    }
    if let Some(CompareMarkdownSegment::Markdown { text: prev }) = out.last_mut() {
        prev.push('\n');
        prev.push_str(normalized);
    } else {
        out.push(CompareMarkdownSegment::Markdown { text: normalized.to_string() });
    }
}

/// Splits Markdown text around valid fenced ` ```compare ` blocks.
/// Unclosed blocks (e.g. while streaming) and malformed JSON blocks remain plain Markdown code fences.
pub fn split_markdown_compare_blocks(text: &str) -> Vec<CompareMarkdownSegment> {
    if text.is_empty() {
        return Vec::new();
    }
    if !text.contains("compare") {
        return vec![CompareMarkdownSegment::Markdown { text: text.to_string() }];
    }

    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut segments: Vec<CompareMarkdownSegment> = Vec::new();
    let mut md_lines: Vec<&str> = Vec::new();

    let mut fence_char: Option<char> = None;
    let mut fence_len: usize = 0;
    let mut fence_is_compare = false;
    let mut compare_raw_lines: Vec<&str> = Vec::new();
    let mut compare_body_lines: Vec<&str> = Vec::new();

    let flush_markdown = |out: &mut Vec<CompareMarkdownSegment>, buf: &mut Vec<&str>| {
        if buf.is_empty() {
            return;
        }
        append_markdown(out, &buf.join("\n"));
        buf.clear();
    };

    for line in lines {
        if let Some(fc) = fence_char {
            if is_closing_fence(line, fc, fence_len) {
                if fence_is_compare {
                    let body = compare_body_lines.join("\n");
                    if let Some(spec) = parse_compare_spec(&body) {
                        flush_markdown(&mut segments, &mut md_lines);
                        segments.push(CompareMarkdownSegment::Compare { raw: body, spec });
                    } else {
                        md_lines.extend(compare_raw_lines.iter().copied());
                        md_lines.push(line);
                    }
                    compare_raw_lines.clear();
                    compare_body_lines.clear();
                } else {
                    md_lines.push(line);
                }
                fence_char = None;
                fence_len = 0;
                fence_is_compare = false;
                continue;
            }

            if fence_is_compare {
                compare_raw_lines.push(line);
                compare_body_lines.push(line);
            } else {
                md_lines.push(line);
            }
            continue;
        }

        if let Some(cap) = FENCE_OPEN_RE.captures(line) {
            let marker = cap.get(1).map_or("", |m| m.as_str());
            let info = cap.get(2).map_or("", |m| m.as_str()).trim();
            fence_char = marker.chars().next();
            fence_len = marker.chars().count();
            if info == "compare" {
                fence_is_compare = true;
                compare_raw_lines.clear();
                compare_raw_lines.push(line);
                compare_body_lines.clear();
                continue;
            }
            fence_is_compare = false;
            md_lines.push(line);
            continue;
        }

        md_lines.push(line);
    }

    if fence_is_compare && !compare_raw_lines.is_empty() {
        md_lines.extend(compare_raw_lines);
    }
    flush_markdown(&mut segments, &mut md_lines);
    segments
}

fn clean_image(image: &CompareImage) -> CompareImage {
    CompareImage {
        attachment: image.attachment.clone(),
        url: image.url.clone(),
        label: image.label.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormattedAnnotation<'a> {
    n: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    side: Option<CompareAnnotationSide>,
    rect: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    tone: Option<CompareAnnotationTone>,
    note: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormattedCompareSpec<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<CompareImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<CompareImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<CompareImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotations: Option<Vec<FormattedAnnotation<'a>>>,
}

/// Serializes a validated `CompareSpec` into a fenced ` ```compare ` Markdown block.
pub fn format_compare_block(spec: &CompareSpec) -> String {
    let annotations = spec.annotations.as_ref().filter(|items| !items.is_empty()).map(|items| {
        items
            .iter()
            .map(|item| FormattedAnnotation {
                n: item.n,
                side: item.side,
                rect: item.rect,
                tone: item.tone,
                note: &item.note,
            })
            .collect()
    });
    let normalized = FormattedCompareSpec {
        title: spec.title.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        before: spec.before.as_ref().map(clean_image),
        after: spec.after.as_ref().map(clean_image),
        image: spec.image.as_ref().map(clean_image),
        annotations,
    };
    let body = serde_json::to_string_pretty(&normalized).unwrap_or_else(|_| "{}".to_string());
    format!("```compare\n{body}\n```")
}

/// Returns `true` when a spec has both Before and After images for dual comparison.
pub fn is_dual_compare(spec: &CompareSpec) -> bool {
    spec.before.is_some() && spec.after.is_some()
}

/// First previewable image for a board card: prefers a valid ` ```compare ` block image,
/// then the first `image/*` attachment.
pub fn card_preview_of(issue: &Issue) -> Option<BoardCardPreview> {
    if issue.description.contains("compare") {
        for seg in split_markdown_compare_blocks(&issue.description) {
            let CompareMarkdownSegment::Compare { spec, .. } = seg else {
                continue;
            };
            let Some(picked) = spec.after.as_ref().or(spec.before.as_ref()).or(spec.image.as_ref()) else {
                continue;
            };
            if let Some(att) = picked.attachment.as_ref().filter(|s| !s.is_empty()) {
                return Some(BoardCardPreview {
                    attachment_id: Some(att.clone()),
                    url: None,
                    is_compare: true,
                });
            }
            if let Some(url) = picked.url.as_ref().filter(|s| !s.is_empty()) {
                return Some(BoardCardPreview {
                    attachment_id: None,
                    url: Some(url.clone()),
                    is_compare: true,
                });
            }
        }
    }
    issue
        .attachments
        .iter()
        .find(|att| att.r#type.starts_with("image/"))
        .map(|att| BoardCardPreview {
            attachment_id: Some(att.id.clone()),
            url: None,
            is_compare: false,
        })
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::Attachment;

    use super::*;

    #[test]
    fn parses_valid_dual_and_single_specs_and_rejects_invalid_shapes() {
        let dual_raw = r#"{
            "title": "Toolbar alignment",
            "before": { "attachment": "att-1", "label": "Before fix" },
            "after": { "attachment": "att-2", "label": "After fix" },
            "annotations": [
                { "n": 1, "side": "before", "rect": [0.1, 0.2, 0.3, 0.2], "tone": "issue", "note": "Misaligned icon" },
                { "n": 2, "side": "after", "rect": [0.1, 0.2, 0.3, 0.2], "tone": "fixed", "note": "Aligned to 28px bar" }
            ]
        }"#;
        let dual = parse_compare_spec(dual_raw).expect("valid dual compare");
        assert_eq!(dual.title.as_deref(), Some("Toolbar alignment"));
        assert!(is_dual_compare(&dual));
        assert_eq!(dual.annotations.as_ref().map(Vec::len), Some(2));

        let single_raw = r#"{
            "image": { "url": "file:///tmp/single.png", "label": "Audit capture" },
            "annotations": [{ "n": 1, "rect": [0.25, 0.25, 0.5, 0.25], "note": "Check spacing" }]
        }"#;
        let single = parse_compare_spec(single_raw).expect("valid single compare");
        assert!(!is_dual_compare(&single));
        assert_eq!(single.image.as_ref().and_then(|i| i.url.as_deref()), Some("file:///tmp/single.png"));

        assert!(parse_compare_spec("").is_none());
        assert!(parse_compare_spec("{ invalid json").is_none());
        assert!(parse_compare_spec(r#"{"title":"Missing images"}"#).is_none());
        assert!(parse_compare_spec(r#"{"before":{}}"#).is_none());
        assert!(parse_compare_spec(r#"{"image":{"url":"file:///tmp/a.png"},"annotations":[{"n":1,"rect":[-0.1,0,0.5,0.5],"note":"Out of range"}]}"#).is_none());
    }

    #[test]
    fn splits_mixed_markdown_and_keeps_malformed_or_nested_fences_plain() {
        assert_eq!(split_markdown_compare_blocks(""), Vec::<CompareMarkdownSegment>::new());
        assert_eq!(
            split_markdown_compare_blocks("Plain **markdown** only."),
            vec![CompareMarkdownSegment::Markdown {
                text: "Plain **markdown** only.".to_string()
            }]
        );

        let spec = CompareSpec {
            title: Some("Header polish".to_string()),
            before: Some(CompareImage {
                attachment: Some("a-before".to_string()),
                ..Default::default()
            }),
            after: Some(CompareImage {
                attachment: Some("a-after".to_string()),
                ..Default::default()
            }),
            image: None,
            annotations: Some(vec![CompareAnnotation {
                n: 1,
                side: Some(CompareAnnotationSide::Both),
                rect: [0.1, 0.1, 0.4, 0.2],
                tone: Some(CompareAnnotationTone::Fixed),
                note: "Unified height".to_string(),
            }]),
        };
        let block = format_compare_block(&spec);
        let nested_json = r#"{"image":{"url":"file:///nested.png"}}"#;
        let mixed = [
            "Intro paragraph.",
            "",
            &block,
            "",
            "Middle notes.",
            "",
            "```compare",
            "{ not valid json",
            "```",
            "",
            "````markdown",
            "```compare",
            nested_json,
            "```",
            "````",
            "",
            "```compare",
            r#"{"title":"Streaming unclosed""#,
        ]
        .join("\n");

        let segments = split_markdown_compare_blocks(&mixed);
        assert_eq!(segments.len(), 3);
        assert_eq!(
            segments[0],
            CompareMarkdownSegment::Markdown {
                text: "Intro paragraph.".to_string()
            }
        );
        match &segments[1] {
            CompareMarkdownSegment::Compare { spec: got, .. } => assert_eq!(got, &spec),
            other => panic!("expected compare segment, got {other:?}"),
        }
        match &segments[2] {
            CompareMarkdownSegment::Markdown { text } => {
                assert!(text.contains("Middle notes."));
                assert!(text.contains("{ not valid json"));
                assert!(text.contains("file:///nested.png"));
                assert!(text.contains("Streaming unclosed"));
            }
            other => panic!("expected markdown segment, got {other:?}"),
        }
    }

    #[test]
    fn card_preview_prefers_compare_block_then_image_attachment() {
        let mut issue = Issue::new("i-1", 1, "Visual check", 100);
        let spec = CompareSpec {
            before: Some(CompareImage {
                attachment: Some("att-before".to_string()),
                ..Default::default()
            }),
            after: Some(CompareImage {
                attachment: Some("att-after".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        issue.description = format!("Look:\n\n{}", format_compare_block(&spec));
        issue.attachments = vec![Attachment {
            id: "att-fallback".to_string(),
            name: "shot.png".to_string(),
            r#type: "image/png".to_string(),
            size: 12,
        }];

        assert_eq!(
            card_preview_of(&issue),
            Some(BoardCardPreview {
                attachment_id: Some("att-after".to_string()),
                url: None,
                is_compare: true,
            })
        );

        issue.description = "Plain text".to_string();
        assert_eq!(
            card_preview_of(&issue),
            Some(BoardCardPreview {
                attachment_id: Some("att-fallback".to_string()),
                url: None,
                is_compare: false,
            })
        );
    }
}
