//! Parser for git's unified patch output, plus word-level emphasis.

use std::ops::Range;
use std::path::PathBuf;

use crate::cmd::path_from_bytes;
use crate::{Change, DiffLine, FileDiff, GitError, Hunk, LineKind, Result};

/// A parsed file together with where its pieces sit in the raw output, so a
/// single hunk can be handed back to `git apply` byte for byte.
pub(crate) struct ParsedFile {
    pub diff: FileDiff,
    /// The raw `+++ ` line (without the newline), when the file has one.
    pub new_name_line: Option<Range<usize>>,
    /// From the `diff --git` line up to the first hunk.
    pub header: Range<usize>,
    pub hunks: Vec<Range<usize>>,
}

struct Lines<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Lines<'a> {
    /// The next line without its newline, and the offset where it starts.
    fn peek(&self) -> Option<(usize, &'a [u8])> {
        if self.pos >= self.data.len() {
            return None;
        }
        let rest = &self.data[self.pos..];
        let len = rest.iter().position(|b| *b == b'\n').unwrap_or(rest.len());
        Some((self.pos, &rest[..len]))
    }

    fn advance(&mut self) {
        if let Some((start, line)) = self.peek() {
            self.pos = (start + line.len() + 1).min(self.data.len());
        }
    }
}

/// Undoes git's C-style quoting of unusual path names (`"a\tb\346\227\245"`).
/// Returns the bytes and how much of `input` the quoted string took.
fn unquote(input: &[u8]) -> Option<(Vec<u8>, usize)> {
    if input.first() != Some(&b'"') {
        return None;
    }
    let mut out = Vec::new();
    let mut i = 1;
    while i < input.len() {
        match input[i] {
            b'"' => return Some((out, i + 1)),
            b'\\' => {
                i += 1;
                let c = *input.get(i)?;
                match c {
                    b'a' => out.push(7),
                    b'b' => out.push(8),
                    b't' => out.push(b'\t'),
                    b'n' => out.push(b'\n'),
                    b'v' => out.push(11),
                    b'f' => out.push(12),
                    b'r' => out.push(b'\r'),
                    b'0'..=b'7' => {
                        let digits = input.get(i..i + 3)?;
                        let mut value = 0u32;
                        for d in digits {
                            if !(b'0'..=b'7').contains(d) {
                                return None;
                            }
                            value = value * 8 + u32::from(d - b'0');
                        }
                        out.push(value as u8);
                        i += 2;
                    }
                    other => out.push(other),
                }
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

/// A name as it appears after `--- `, `+++ `, `rename from ` and friends.
fn name(raw: &[u8]) -> Vec<u8> {
    if let Some((bytes, _)) = unquote(raw) {
        return bytes;
    }
    // git appends a tab to names containing spaces on ---/+++ lines.
    raw.strip_suffix(b"\t").unwrap_or(raw).to_vec()
}

fn strip_side(name: Vec<u8>, prefix: &[u8]) -> Option<PathBuf> {
    if name == b"/dev/null" {
        return None;
    }
    Some(path_from_bytes(name.strip_prefix(prefix).unwrap_or(&name)))
}

/// Splits the names of a `diff --git a/X b/Y` line. Unquoted names with
/// spaces make this ambiguous in general, but git only omits the explicit
/// `rename from`/`---`/`+++` lines when both names are equal, and then the
/// line splits exactly in half.
fn git_header_names(rest: &[u8]) -> (Option<PathBuf>, Option<PathBuf>) {
    if let Some((first, used)) = unquote(rest) {
        let second = rest.get(used + 1..).map(name).unwrap_or_default();
        return (strip_side(first, b"a/"), strip_side(second, b"b/"));
    }
    if rest.len() % 2 == 1 {
        let mid = rest.len() / 2;
        let (a, b) = (&rest[..mid], &rest[mid + 1..]);
        if rest[mid] == b' ' && a.starts_with(b"a/") && b.starts_with(b"b/") && a[2..] == b[2..] {
            return (Some(path_from_bytes(&a[2..])), Some(path_from_bytes(&b[2..])));
        }
    }
    let split = rest
        .windows(3)
        .position(|w| w == b" b/")
        .or_else(|| rest.windows(4).position(|w| w == b" \"b/"));
    match split {
        Some(at) => (strip_side(name(&rest[..at]), b"a/"), strip_side(name(&rest[at + 1..]), b"b/")),
        None => (None, None),
    }
}

fn parse_range(part: &str) -> Option<(u32, u32)> {
    let part = &part[1..];
    match part.split_once(',') {
        Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
        None => Some((part.parse().ok()?, 1)),
    }
}

fn parse_hunk_header(line: &[u8]) -> Result<Hunk> {
    let header = String::from_utf8_lossy(line).into_owned();
    let bad = || GitError::Parse(format!("hunk header: {header}"));
    let mut parts = header.split(' ');
    if parts.next() != Some("@@") {
        return Err(bad());
    }
    let old = parts.next().filter(|p| p.starts_with('-')).ok_or_else(bad)?;
    let new = parts.next().filter(|p| p.starts_with('+')).ok_or_else(bad)?;
    let (old_start, old_lines) = parse_range(old).ok_or_else(bad)?;
    let (new_start, new_lines) = parse_range(new).ok_or_else(bad)?;
    Ok(Hunk {
        header,
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: Vec::new(),
    })
}

fn parse_hunk(lines: &mut Lines<'_>, mut hunk: Hunk) -> Hunk {
    let (mut old_no, mut new_no) = (hunk.old_start, hunk.new_start);
    let (mut old_left, mut new_left) = (hunk.old_lines, hunk.new_lines);
    while let Some((_, line)) = lines.peek() {
        let (marker, body) = match line.split_first() {
            Some((m, body)) => (*m, body),
            // A context line whose single space was stripped by some tool.
            None => (b' ', line),
        };
        let exhausted = old_left == 0 && new_left == 0;
        let (kind, old, new) = match marker {
            b'\\' => (LineKind::NoNewline, None, None),
            _ if exhausted => break,
            b' ' => (LineKind::Context, Some(old_no), Some(new_no)),
            b'-' => (LineKind::Removed, Some(old_no), None),
            b'+' => (LineKind::Added, None, Some(new_no)),
            _ => break,
        };
        if old.is_some() {
            old_no += 1;
            old_left = old_left.saturating_sub(1);
        }
        if new.is_some() {
            new_no += 1;
            new_left = new_left.saturating_sub(1);
        }
        hunk.lines.push(DiffLine {
            kind,
            old_no: old,
            new_no: new,
            text: String::from_utf8_lossy(body).into_owned(),
            emphasis: Vec::new(),
        });
        lines.advance();
    }
    emphasize(&mut hunk.lines);
    hunk
}

pub(crate) fn parse(data: &[u8]) -> Result<Vec<ParsedFile>> {
    let mut lines = Lines { data, pos: 0 };
    let mut files: Vec<ParsedFile> = Vec::new();

    while let Some((start, line)) = lines.peek() {
        // Conflicted paths come out as combined diffs (`diff --cc`), whose
        // three-way hunks do not fit `Hunk`; they are reported without hunks.
        let combined = line.strip_prefix(b"diff --cc ").or_else(|| line.strip_prefix(b"diff --combined "));
        if let Some(path) = combined {
            let path = strip_side(name(path), b"");
            files.push(ParsedFile {
                diff: FileDiff {
                    old_path: path.clone(),
                    new_path: path,
                    change: Change::Conflicted,
                    binary: false,
                    added: 0,
                    removed: 0,
                    hunks: Vec::new(),
                },
                new_name_line: None,
                header: start..start,
                hunks: Vec::new(),
            });
            lines.advance();
            while let Some((_, next)) = lines.peek() {
                if next.starts_with(b"diff --") {
                    break;
                }
                lines.advance();
            }
            continue;
        }

        let Some(rest) = line.strip_prefix(b"diff --git ") else {
            lines.advance();
            continue;
        };
        let (old_path, new_path) = git_header_names(rest);
        let mut file = ParsedFile {
            diff: FileDiff {
                old_path,
                new_path,
                change: Change::Modified,
                binary: false,
                added: 0,
                removed: 0,
                hunks: Vec::new(),
            },
            new_name_line: None,
            header: start..start,
            hunks: Vec::new(),
        };
        lines.advance();

        while let Some((at, line)) = lines.peek() {
            file.header.end = at;
            if line.starts_with(b"diff --") || line.starts_with(b"@@ ") {
                break;
            }
            let diff = &mut file.diff;
            if line.starts_with(b"new file mode ") {
                diff.change = Change::Added;
            } else if line.starts_with(b"deleted file mode ") {
                diff.change = Change::Deleted;
            } else if let Some(from) = line.strip_prefix(b"rename from ") {
                diff.change = Change::Renamed;
                diff.old_path = Some(path_from_bytes(&name(from)));
            } else if let Some(to) = line.strip_prefix(b"rename to ") {
                diff.change = Change::Renamed;
                diff.new_path = Some(path_from_bytes(&name(to)));
            } else if let Some(from) = line.strip_prefix(b"copy from ") {
                diff.change = Change::Copied;
                diff.old_path = Some(path_from_bytes(&name(from)));
            } else if let Some(to) = line.strip_prefix(b"copy to ") {
                diff.change = Change::Copied;
                diff.new_path = Some(path_from_bytes(&name(to)));
            } else if let Some(old) = line.strip_prefix(b"--- ") {
                diff.old_path = strip_side(name(old), b"a/");
            } else if let Some(new) = line.strip_prefix(b"+++ ") {
                diff.new_path = strip_side(name(new), b"b/");
                file.new_name_line = Some(at..at + line.len());
            } else if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
                diff.binary = true;
            }
            lines.advance();
            file.header.end = lines.pos;
        }

        while let Some((at, line)) = lines.peek() {
            if !line.starts_with(b"@@ ") {
                break;
            }
            let hunk = parse_hunk_header(line)?;
            lines.advance();
            let hunk = parse_hunk(&mut lines, hunk);
            file.hunks.push(at..lines.pos);
            for line in &hunk.lines {
                match line.kind {
                    LineKind::Added => file.diff.added += 1,
                    LineKind::Removed => file.diff.removed += 1,
                    _ => {}
                }
            }
            file.diff.hunks.push(hunk);
        }

        match file.diff.change {
            Change::Added => file.diff.old_path = None,
            Change::Deleted => file.diff.new_path = None,
            _ => {}
        }
        files.push(file);
    }
    Ok(files)
}

/// Lines longer than this are not worth a word diff (minified bundles).
const MAX_EMPHASIS_LINE: usize = 2000;
/// Below this share of common text, two lines are treated as unrelated.
const MIN_SIMILARITY: f32 = 0.3;

fn emphasize(lines: &mut [DiffLine]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != LineKind::Removed {
            i += 1;
            continue;
        }
        let mut removed = Vec::new();
        let mut added = Vec::new();
        let mut j = i;
        while j < lines.len() {
            match lines[j].kind {
                LineKind::Removed if added.is_empty() => removed.push(j),
                LineKind::Added => added.push(j),
                LineKind::NoNewline => {}
                _ => break,
            }
            j += 1;
        }
        // Only an equal number of lines pairs up unambiguously.
        if removed.len() == added.len() {
            for (r, a) in removed.iter().zip(&added) {
                let (old, new) = word_diff(&lines[*r].text, &lines[*a].text);
                lines[*r].emphasis = old;
                lines[*a].emphasis = new;
            }
        }
        i = j.max(i + 1);
    }
}

#[derive(PartialEq, Eq, Hash, Clone, Copy)]
enum Class {
    Word,
    Space,
    Other,
}

fn tokens(text: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut last = Class::Other;
    for (at, c) in text.char_indices() {
        // CJK has no spaces between words: every character is its own token.
        let class = if (c.is_alphanumeric() || c == '_') && (c as u32) < 0x2E80 {
            Class::Word
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        };
        match out.last_mut() {
            Some(prev) if class == last && class != Class::Other => prev.end = at + c.len_utf8(),
            _ => out.push(at..at + c.len_utf8()),
        }
        last = class;
    }
    out
}

fn push_merged(ranges: &mut Vec<Range<usize>>, range: Range<usize>) {
    if range.is_empty() {
        return;
    }
    match ranges.last_mut() {
        Some(prev) if prev.end == range.start => prev.end = range.end,
        _ => ranges.push(range),
    }
}

fn span(tokens: &[Range<usize>], range: Range<usize>) -> Range<usize> {
    if range.is_empty() {
        0..0
    } else {
        tokens[range.start].start..tokens[range.end - 1].end
    }
}

/// Changed byte ranges of `old` and of `new`.
pub(crate) fn word_diff(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    if old.len() > MAX_EMPHASIS_LINE || new.len() > MAX_EMPHASIS_LINE {
        return (Vec::new(), Vec::new());
    }
    let (old_tokens, new_tokens) = (tokens(old), tokens(new));
    let old_words: Vec<&str> = old_tokens.iter().map(|r| &old[r.clone()]).collect();
    let new_words: Vec<&str> = new_tokens.iter().map(|r| &new[r.clone()]).collect();
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old_words, &new_words);

    let (mut old_ranges, mut new_ranges) = (Vec::new(), Vec::new());
    let mut common = 0usize;
    for op in &ops {
        if op.tag() == similar::DiffTag::Equal {
            common += old_words[op.old_range()]
                .iter()
                .filter(|w| !w.trim().is_empty())
                .map(|w| w.len())
                .sum::<usize>();
        } else {
            push_merged(&mut old_ranges, span(&old_tokens, op.old_range()));
            push_merged(&mut new_ranges, span(&new_tokens, op.new_range()));
        }
    }
    let solid = |s: &str| s.chars().filter(|c| !c.is_whitespace()).map(char::len_utf8).sum::<usize>();
    let longest = solid(old).max(solid(new));
    if longest == 0 || (common as f32) < MIN_SIMILARITY * longest as f32 {
        return (Vec::new(), Vec::new());
    }
    (old_ranges, new_ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_octal_and_escapes() {
        let (bytes, used) = unquote(br#""a/\346\227\245\t\"x\"" tail"#).unwrap();
        assert_eq!(bytes, "a/日\t\"x\"".as_bytes());
        assert_eq!(used, 23);
        assert!(unquote(b"plain").is_none());
        assert!(unquote(b"\"unterminated").is_none());
    }

    #[test]
    fn header_names_with_spaces() {
        let (a, b) = git_header_names(b"a/my file.txt b/my file.txt");
        assert_eq!(a.unwrap(), PathBuf::from("my file.txt"));
        assert_eq!(b.unwrap(), PathBuf::from("my file.txt"));
        let (a, b) = git_header_names(br#""a/x\ty" "b/x\ty""#);
        assert_eq!(a.unwrap(), PathBuf::from("x\ty"));
        assert_eq!(b.unwrap(), PathBuf::from("x\ty"));
    }

    #[test]
    fn word_diff_marks_only_the_changed_word() {
        let (old, new) = word_diff("let total = count + 1;", "let total = count + 20;");
        assert_eq!(old, vec![20..21]);
        assert_eq!(new, vec![20..22]);

        let (old, new) = word_diff("名称：旧值", "名称：新值");
        assert_eq!(&"名称：旧值"[old[0].clone()], "旧");
        assert_eq!(&"名称：新值"[new[0].clone()], "新");

        let (old, new) = word_diff("fn alpha() {}", "struct Completely(Different);");
        assert!(old.is_empty() && new.is_empty());
    }

    #[test]
    fn line_numbers_and_no_newline_marker() {
        let patch =
            b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -3,4 +3,4 @@ fn ctx()\n a\n-b\n+B\n c\n-d\n\\ No newline at end of file\n+d\n";
        let files = parse(patch).unwrap();
        assert_eq!(files.len(), 1);
        let hunk = &files[0].diff.hunks[0];
        assert_eq!((hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines), (3, 4, 3, 4));
        let numbers: Vec<_> = hunk.lines.iter().map(|l| (l.kind, l.old_no, l.new_no)).collect();
        assert_eq!(
            numbers,
            vec![
                (LineKind::Context, Some(3), Some(3)),
                (LineKind::Removed, Some(4), None),
                (LineKind::Added, None, Some(4)),
                (LineKind::Context, Some(5), Some(5)),
                (LineKind::Removed, Some(6), None),
                (LineKind::NoNewline, None, None),
                (LineKind::Added, None, Some(6)),
            ]
        );
        assert_eq!(hunk.lines[5].text, " No newline at end of file");
        assert_eq!((files[0].diff.added, files[0].diff.removed), (2, 2));
        assert_eq!(&patch[files[0].hunks[0].clone()][..3], b"@@ ");
        assert_eq!(files[0].hunks[0].end, patch.len());
    }

    #[test]
    fn garbage_does_not_panic() {
        assert!(parse(b"").unwrap().is_empty());
        assert!(parse(b"not a diff\n\n@@ nonsense\n").unwrap().is_empty());
        assert!(parse(b"diff --git a/x b/x\n@@ broken @@\n").is_err());
        let files = parse(b"diff --git \n--- \n+++ \n@@ -1 +1 @@\n-a\n+b").unwrap();
        assert_eq!(files[0].diff.hunks[0].lines.len(), 2);
    }
}
