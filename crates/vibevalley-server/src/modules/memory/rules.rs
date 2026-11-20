//! An agent's memory: the words a memory is compared by (Chinese cut as gse
//! cuts it, Latin and code words whole), recall scoring, de-duplication,
//! eviction, search, and redaction of secrets before text leaves the
//! machine. Storage is the server's: these are pure functions over `Memory` rows.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::gse;

pub use gse::{cut_all, cut_search, go_lower};

const DAY_MS: f64 = 86_400_000.0;
/// An agent's memories past this go, the longest unused first.
pub const MEMORY_KEEP: usize = 300;
pub const RECALL_COUNT: usize = 8;
const RECALL_ISSUES: usize = 3;
pub const RECALL_CHARS: usize = 1600;
const RECALL_ELSEWHERE: usize = 3;
const RECALL_MATCH_MOST: f64 = 5.0;
const RECALL_MATCH_WEIGHT: f64 = 0.3;
const RECALL_SHARED_WEIGHT: f64 = 0.5;
pub const NOTE_MAX_CHARS: usize = 300;
pub const SEARCH_LIMIT: usize = 10;
/// Raised when the cut or the dictionary changes: stored terms are then
/// cut again.
pub const TERMS_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Note,
    Issue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    User,
    Agent,
    System,
}

/// VibeValley's `Memory` (packages/protocol/src/memory/shapes.ts), same
/// wire shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub agent: String,
    pub kind: MemoryKind,
    pub text: String,
    pub author: ActorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub at: i64,
    pub recalled: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recalled_at: Option<i64>,
    pub fading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

fn stopwords() -> &'static HashSet<String> {
    static STOP: LazyLock<HashSet<String>> = LazyLock::new(|| serde_json::from_str(include_str!("data/stopwords.json")).expect("bundled stopwords"));
    &STOP
}

fn has_han(s: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Han}").expect("regex"));
    RE.is_match(s)
}

fn code_words() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z0-9_][a-z0-9_.\-/]*[a-z0-9_]").expect("regex"));
    &RE
}

/// Words in lower case, in order of appearance, each once: Chinese words of
/// two or more characters (search cut, then every dictionary word), then
/// Latin, numbers and code whole (`db/migrations`, `v1.2.3`).
pub fn terms_list(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    let stop = stopwords();
    let mut add = |w: &str| {
        if !seen.contains(w) && !stop.contains(w) {
            seen.insert(w.to_string());
            out.push(w.to_string());
        }
    };
    for cut in [cut_search(text), cut_all(text)] {
        for raw in cut {
            let w = raw.trim();
            if has_han(w) && w.chars().count() > 1 {
                add(w);
            }
        }
    }
    let lower = go_lower(text);
    for m in code_words().find_iter(&lower) {
        add(m.as_str());
    }
    out
}

pub fn terms_of(text: &str) -> HashSet<String> {
    terms_list(text).into_iter().collect()
}

/// What a terms column holds: the words, space-joined.
pub fn terms_text(text: &str) -> String {
    terms_list(text).join(" ")
}

fn in_common(a: &HashSet<String>, b: &HashSet<String>) -> usize {
    a.iter().filter(|t| b.contains(*t)).count()
}

#[cfg(test)]
pub fn likeness(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    let shared = in_common(a, b);
    let all = a.len() + b.len() - shared;
    if all == 0 { 0.0 } else { shared as f64 / all as f64 }
}

/// Whether `text` is worth a new note: no note in the same scope says the
/// same thing (equal, or ≥ 0.8 likeness).
#[cfg(test)]
pub fn is_new_note(memories: &[Memory], text: &str, repo: Option<&str>) -> bool {
    let terms = terms_of(text);
    !memories
        .iter()
        .any(|m| m.kind == MemoryKind::Note && m.repo.as_deref() == repo && (m.text == text || likeness(&terms_of(&m.text), &terms) >= 0.8))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// On one line and trimmed, at most `max` UTF-16 units with an ellipsis.
pub fn clip(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if utf16_len(&flat) <= max {
        return flat;
    }
    let mut out = String::new();
    for ch in flat.chars() {
        if utf16_len(&out) + ch.len_utf16() > max - 1 {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

fn where_words(m: &Memory, repo: &str) -> String {
    match &m.repo {
        None => "所有仓库".into(),
        Some(r) if r == repo => "这个仓库".into(),
        Some(r) => format!("仓库 {r}"),
    }
}

/// How a recalled memory is written into the prompt.
pub fn line_of(m: &Memory, repo: &str) -> String {
    let w = where_words(m, repo);
    match m.kind {
        MemoryKind::Issue => format!("- 做过（{w}）：{}", m.text),
        MemoryKind::Note => format!("- （{w}）{}", m.text),
    }
}

/// A finished issue's memory: its brief, and what came of it.
pub fn issue_memory_text(brief: &str, summary: &str, failed: bool) -> String {
    format!("{} → {}{}", clip(brief, 100), if failed { "没做成：" } else { "" }, clip(summary, 200))
}

/// The memory lines carried in a prompt, the oldest cut past 8000 chars.
pub fn carried_memory(lines: &[String]) -> String {
    let text = lines.iter().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n");
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > 8000 {
        let tail = String::from_utf16_lossy(&units[units.len() - 8000..]);
        format!("较早的记性未放入上下文，需要时用 memory_search 查询。\n{tail}")
    } else {
        text
    }
}

/// Authorship stays explicit when user-written notes become model input.
pub const FROM_USER: &str = "用户交代：";

/// What a turn recalls by. `matches`: full-text rank per memory id, higher
/// better (the store's own index; 0 when absent).
#[derive(Debug, Clone, Default)]
pub struct Cue<'a> {
    pub session: Option<&'a str>,
    pub repo: &'a str,
    pub text: &'a str,
    pub skip: HashSet<String>,
    pub now: i64,
    pub matches: std::collections::HashMap<String, f64>,
}

fn relevance(m: &Memory, cue: &Cue, terms: &HashSet<String>) -> Option<f64> {
    if cue.skip.contains(&m.id) || (m.session.is_some() && m.session.as_deref() == cue.session) {
        return None;
    }
    let shared = in_common(&terms_of(&m.text), terms);
    let here = m.repo.as_deref() == Some(cue.repo);
    let everywhere = m.repo.is_none();
    match m.kind {
        MemoryKind::Issue if !here => return None,
        MemoryKind::Note if !here && !everywhere && shared < RECALL_ELSEWHERE => return None,
        _ => {}
    }
    let used = m.recalled_at.unwrap_or(m.at);
    let age = ((cue.now - used).max(0)) as f64 / DAY_MS;
    let kind = if m.kind == MemoryKind::Note { 2.0 } else { 0.5 };
    let place = if here {
        2.0
    } else if everywhere {
        1.0
    } else {
        0.0
    };
    let matched = cue.matches.get(&m.id).copied().unwrap_or(0.0).min(RECALL_MATCH_MOST) * RECALL_MATCH_WEIGHT;
    Some(kind + place + (shared.min(8) as f64) * RECALL_SHARED_WEIGHT + matched + (-age / 30.0).exp())
}

/// The memories to recall for a turn: best first, at most 8, at most 3
/// issue memories, at most 1600 chars of lines.
pub fn pick(memories: &[Memory], cue: &Cue) -> Vec<Memory> {
    let terms = terms_of(cue.text);
    let mut ranked: Vec<(&Memory, f64)> = memories.iter().filter_map(|m| relevance(m, cue, &terms).map(|s| (m, s))).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.at.cmp(&a.0.at)));
    let mut picked = vec![];
    let (mut chars, mut issues) = (0, 0);
    for (m, _) in ranked {
        if picked.len() == RECALL_COUNT {
            break;
        }
        let length = utf16_len(&line_of(m, cue.repo)) + 1;
        if (m.kind == MemoryKind::Issue && issues == RECALL_ISSUES) || chars + length > RECALL_CHARS {
            continue;
        }
        chars += length;
        if m.kind == MemoryKind::Issue {
            issues += 1;
        }
        picked.push(m.clone());
    }
    picked
}

/// Ids to evict before `coming` new memories: the longest unused first.
pub fn next_forgotten(memories: &[Memory], coming: usize) -> Vec<String> {
    let over = (memories.len() + coming).saturating_sub(MEMORY_KEEP);
    if over == 0 {
        return vec![];
    }
    let mut sorted: Vec<&Memory> = memories.iter().collect();
    sorted.sort_by_key(|m| m.recalled_at.unwrap_or(m.at));
    sorted.into_iter().take(over).map(|m| m.id.clone()).collect()
}

/// Matches for `memory_search`, best first. A query with no words lists
/// the newest.
pub fn search(
    memories: &[Memory],
    repo: &str,
    text: &str,
    kind: Option<MemoryKind>,
    limit: usize,
    matches: &std::collections::HashMap<String, f64>,
) -> Vec<(Memory, f64)> {
    let limit = if limit > 0 { limit } else { SEARCH_LIMIT };
    let terms = terms_of(text);
    let whole = text.to_lowercase().trim().to_string();
    let mut out: Vec<(Memory, f64)> = vec![];
    for m in memories {
        let in_repo = repo.is_empty() || m.repo.is_none() || m.repo.as_deref() == Some(repo);
        if kind.is_some_and(|k| k != m.kind) || !in_repo {
            continue;
        }
        let mut score = matches.get(&m.id).copied().unwrap_or(0.0) + in_common(&terms_of(&m.text), &terms) as f64 * RECALL_SHARED_WEIGHT;
        if !whole.is_empty() && m.text.to_lowercase().contains(&whole) {
            score += 2.0;
        }
        if !whole.is_empty() && score == 0.0 {
            continue;
        }
        if !repo.is_empty() && m.repo.is_some() {
            score += 0.5;
        }
        out.push((m.clone(), score));
    }
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.at.cmp(&a.0.at)));
    out.truncate(limit);
    out
}

#[cfg(test)]
fn shapes() -> &'static [Regex] {
    static RE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            r"\bsk-[A-Za-z0-9_-]{16,}",
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})",
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
            r"\bAKIA[0-9A-Z]{16}\b",
            r"\bAIza[0-9A-Za-z_-]{30,}",
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
            r"\bhb_[A-Za-z0-9]+_[A-Za-z0-9_-]{16,}",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("regex"))
        .collect()
    });
    &RE
}

#[cfg(test)]
const REDACTED: &str = "[redacted]";

/// Masks secrets before text leaves the machine (external memory sources,
/// logs). The name and what joins it stay: `api_key=[redacted]`.
#[cfg(test)]
pub fn redact(text: &str) -> String {
    static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}").expect("regex"));
    static NAMED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)(\b[a-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|certificate)[a-z0-9_]*["']?\s*[=:]\s*["']?)([^\s"',;]{6,})"#,
        )
        .expect("regex")
    });
    let mut out = text.to_string();
    for shape in shapes() {
        out = shape.replace_all(&out, REDACTED).into_owned();
    }
    out = BEARER.replace_all(&out, format!("${{1}}{REDACTED}")).into_owned();
    NAMED
        .replace_all(&out, |c: &regex::Captures| {
            if &c[2] == REDACTED {
                c[0].to_string()
            } else {
                format!("{}{REDACTED}", &c[1])
            }
        })
        .into_owned()
}

#[cfg(test)]
#[path = "rules_tests.rs"]
mod tests;

// From VibeValley sources.ts: the farm's own memory plus external sources
// (Nowledge Mem, EverOS). Their scores are not comparable, so results are
// taken in turn by rank, near-duplicates dropped.

/// The name of the local source; other sources' ids carry `name:` before
/// their own id.
#[cfg(test)]
pub const LOCAL: &str = "local";

/// A recalled line from one source.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub struct RecalledLine {
    pub id: String,
    pub line: String,
    pub score: f64,
}

/// The id a user sees for a source's memory.
#[cfg(test)]
pub fn source_id(source: &str, id: &str) -> String {
    if source == LOCAL || id.is_empty() {
        id.to_string()
    } else {
        format!("{source}:{id}")
    }
}

/// Which source a user-facing id belongs to, and its id there. An id whose
/// prefix names no source is the first source's.
#[cfg(test)]
pub fn split_source_id<'a>(sources: &[&'a str], id: &'a str) -> (&'a str, &'a str) {
    if let Some((name, rest)) = id.split_once(':')
        && let Some(found) = sources.iter().find(|s| **s == name)
    {
        return (found, rest);
    }
    (sources.first().copied().unwrap_or(LOCAL), id)
}

/// The ids in `skip` that belong to `source`, in its own id space.
#[cfg(test)]
pub fn skip_for(source: &str, skip: &HashSet<String>) -> HashSet<String> {
    skip.iter()
        .filter_map(|id| match id.split_once(':') {
            None if source == LOCAL => Some(id.clone()),
            Some((name, rest)) if name == source => Some(rest.to_string()),
            _ => None,
        })
        .collect()
}

/// Round-robin by rank across groups, dropping items whose text repeats or
/// is ≥ 0.8 alike an earlier one, and those `keep` refuses.
#[cfg(test)]
pub fn interleave<T: Clone>(groups: &[Vec<T>], text: impl Fn(&T) -> &str, mut keep: impl FnMut(&T) -> bool) -> Vec<T> {
    let mut out = vec![];
    let mut seen: Vec<HashSet<String>> = vec![];
    let mut texts: Vec<String> = vec![];
    for rank in 0.. {
        let mut more = false;
        for g in groups {
            let Some(one) = g.get(rank) else { continue };
            more = true;
            let words = text(one);
            let terms = terms_of(words);
            if texts.iter().any(|t| t == words) || seen.iter().any(|s| likeness(s, &terms) >= 0.8) || !keep(one) {
                continue;
            }
            seen.push(terms);
            texts.push(words.to_string());
            out.push(one.clone());
        }
        if !more {
            break;
        }
    }
    out
}

/// One recall from several sources, within the recall budget.
#[cfg(test)]
pub fn merge_recalled(groups: &[Vec<RecalledLine>]) -> Vec<RecalledLine> {
    let some: Vec<Vec<RecalledLine>> = groups.iter().filter(|g| !g.is_empty()).cloned().collect();
    if some.len() <= 1 {
        return some.into_iter().next().unwrap_or_default();
    }
    let (mut count, mut chars) = (0, 0);
    interleave(
        &some,
        |l| l.line.as_str(),
        |l| {
            let length = utf16_len(&l.line) + 1;
            if count == RECALL_COUNT || chars + length > RECALL_CHARS {
                return false;
            }
            count += 1;
            chars += length;
            true
        },
    )
}
