//! Pure bidirectional wikilink and issue-reference parser shared by `note`, `doc`, and `issue`.

use std::collections::HashSet;

use vibevalley_protocol::{LinkEntityKind, LinkRelation, NoteLinkRef};

fn trim_code_and_extract(text: &str, out: &mut Vec<NoteLinkRef>) {
    let mut in_fence = false;
    for raw_line in text.lines() {
        let trimmed = raw_line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let cleaned = strip_inline_code(raw_line);
        extract_line_links(&cleaned, out);
    }
}

fn strip_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for ch in line.chars() {
        if ch == '`' {
            in_code = !in_code;
            out.push(' ');
            continue;
        }
        if !in_code {
            out.push(ch);
        }
    }
    out
}

fn extract_line_links(line: &str, out: &mut Vec<NoteLinkRef>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Check `![[...]]` embed or `[[...]]` link.
        let (is_embed, bracket_start) = if bytes[i..].starts_with(b"![[") {
            (true, i + 3)
        } else if bytes[i..].starts_with(b"[[") {
            (false, i + 2)
        } else {
            (false, usize::MAX)
        };

        if bracket_start != usize::MAX
            && let Some(rel_end) = line[bracket_start..].find("]]")
        {
            let inner = &line[bracket_start..bracket_start + rel_end];
            if let Some(link) = parse_wikilink_inner(inner, if is_embed { LinkRelation::Embed } else { LinkRelation::Link }) {
                out.push(link);
            }
            i = bracket_start + rel_end + 2;
            continue;
        }

        // Check standalone `#<digits>` issue numbers (e.g. `#128` at word boundary, never URL fragments `#L10` or `http://...#1`).
        if bytes[i] == b'#' {
            let prev_ok = i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'(' | b'[' | b',' | b':' | b';');
            if prev_ok {
                let mut j = i + 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                let next_ok = j == bytes.len() || !bytes[j].is_ascii_alphanumeric();
                if j > i + 1 && next_ok {
                    let digits = &line[i + 1..j];
                    out.push(NoteLinkRef {
                        kind: LinkEntityKind::Issue,
                        id: digits.to_owned(),
                        relation: LinkRelation::Link,
                        title: None,
                    });
                    i = j;
                    continue;
                }
            }
        }

        let ch_len = line[i..].chars().next().map_or(1, char::len_utf8);
        i += ch_len;
    }
}

fn parse_wikilink_inner(inner: &str, relation: LinkRelation) -> Option<NoteLinkRef> {
    let (target_raw, alias) = match inner.split_once('|') {
        Some((left, right)) => (left.trim(), Some(right.trim()).filter(|s| !s.is_empty()).map(str::to_owned)),
        None => (inner.trim(), None),
    };
    if let Some(id) = target_raw.strip_prefix("note:").map(str::trim).filter(|s| !s.is_empty()) {
        return Some(NoteLinkRef {
            kind: LinkEntityKind::Note,
            id: id.to_owned(),
            relation,
            title: alias,
        });
    }
    if let Some(id) = target_raw.strip_prefix("issue:").map(str::trim).filter(|s| !s.is_empty()) {
        return Some(NoteLinkRef {
            kind: LinkEntityKind::Issue,
            id: id.trim_start_matches('#').to_owned(),
            relation,
            title: alias,
        });
    }
    None
}

/// Deduplicates extracted links while promoting `Link` to `Embed` if the same `(kind, id)` appears as both.
pub fn dedup_links(items: Vec<NoteLinkRef>) -> Vec<NoteLinkRef> {
    let mut seen: HashSet<(LinkEntityKind, String)> = HashSet::new();
    let mut out: Vec<NoteLinkRef> = Vec::new();
    for item in items {
        let key = (item.kind, item.id.clone());
        if seen.insert(key) {
            out.push(item);
        } else if let Some(existing) = out.iter_mut().find(|x| x.kind == item.kind && x.id == item.id) {
            if item.relation == LinkRelation::Embed {
                existing.relation = LinkRelation::Embed;
            }
            if existing.title.is_none() && item.title.is_some() {
                existing.title = item.title;
            }
        }
    }
    out
}

/// Extracts `[[note:<id>]]`, `[[issue:<id>]]`, `![[...]]`, and standalone `#<num>` references
/// from Markdown / plain text outside fenced and inline code.
pub fn extract_markdown_links(text: &str) -> Vec<NoteLinkRef> {
    let mut raw = Vec::new();
    trim_code_and_extract(text, &mut raw);
    dedup_links(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_note_issue_wikilinks_and_hash_refs_skipping_code() {
        let text = r#"
See [[note:note-42|Architecture]] and ![[issue:i9|Ship Base]].
Also tracks #128, (#42), and ignores `#999` plus https://example.com/#777.
```markdown
[[note:ignored-in-fence]] #555
```
Final ref: [[issue:#10]].
"#;
        let links = extract_markdown_links(text);
        assert_eq!(
            links,
            vec![
                NoteLinkRef {
                    kind: LinkEntityKind::Note,
                    id: "note-42".to_owned(),
                    relation: LinkRelation::Link,
                    title: Some("Architecture".to_owned()),
                },
                NoteLinkRef {
                    kind: LinkEntityKind::Issue,
                    id: "i9".to_owned(),
                    relation: LinkRelation::Embed,
                    title: Some("Ship Base".to_owned()),
                },
                NoteLinkRef {
                    kind: LinkEntityKind::Issue,
                    id: "128".to_owned(),
                    relation: LinkRelation::Link,
                    title: None,
                },
                NoteLinkRef {
                    kind: LinkEntityKind::Issue,
                    id: "42".to_owned(),
                    relation: LinkRelation::Link,
                    title: None,
                },
                NoteLinkRef {
                    kind: LinkEntityKind::Issue,
                    id: "10".to_owned(),
                    relation: LinkRelation::Link,
                    title: None,
                },
            ]
        );
    }
}
