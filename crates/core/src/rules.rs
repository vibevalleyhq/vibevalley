//! VibeValley's shared rules: `packages/protocol/src/rules/*.ts`, and the
//! server's `base/order.ts` and `base/clip.ts`. Strings are measured as
//! JavaScript measures them (UTF-16 units) where VibeValley cuts them.

use std::cmp::Ordering;

use vibevalley_i18n::{list, t};
use vibevalley_protocol::*;

/// The length JavaScript gives `s.length`.
pub(crate) fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `slice(s, start, end)`: UTF-16 units, a surrogate pair cut in half made
/// U+FFFD.
pub fn slice(s: &str, start: usize, end: Option<usize>) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.unwrap_or(units.len()).min(units.len());
    let start = start.min(end);
    char::decode_utf16(units[start..end].iter().copied()).map(|r| r.unwrap_or('\u{FFFD}')).collect()
}

/// `cut`: `s` when it fits in `max` units, else its first `max` and "…".
pub fn cut(s: &str, max: usize) -> String {
    if js_len(s) > max { slice(s, 0, Some(max)) + "…" } else { s.to_string() }
}

/// `oneLine`: runs of white space are one space.
pub fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// `clip` (`base/clip.ts`): on one line and trimmed, at most `max` units
/// with the ellipsis.
pub(crate) fn clip(s: &str, max: usize) -> String {
    let flat = one_line(s);
    let flat = flat.trim();
    if js_len(flat) > max {
        slice(flat, 0, Some(max.saturating_sub(1))) + "…"
    } else {
        flat.to_string()
    }
}

/// `compareText`: by code point (the order of UTF-8 bytes).
pub fn compare_text(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

/// `plainText`: markdown read as plain words.
pub(crate) fn plain_text(markdown: &str) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"```[\s\S]*?```").unwrap());
    static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`]*)`").unwrap());
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap());
    static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let s = FENCE.replace_all(markdown, " ");
    let s = CODE.replace_all(&s, "$1");
    let s = LINK.replace_all(&s, "$1");
    let s = LEAD.replace_all(&s, "");
    let s = strip_emphasis(&s);
    let s = s.replace('|', " ");
    SPACE.replace_all(&s, " ").trim().to_string()
}

/// `(\*\*|__|\*|_|~~)(.+?)\1` → `$2` (the regex crate has no backreferences).
fn strip_emphasis(s: &str) -> String {
    const MARKS: [&str; 5] = ["**", "__", "*", "_", "~~"];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    'outer: while !rest.is_empty() {
        for m in MARKS {
            if let Some(after) = rest.strip_prefix(m) {
                // .+? : at least one char, no newline, lazily up to the same mark.
                let line_end = after.find('\n').unwrap_or(after.len());
                let first = after.chars().next().map_or(0, char::len_utf8);
                if first > 0
                    && first <= line_end
                    && let Some(close) = after[first..line_end].find(m)
                {
                    out.push_str(&after[..first + close]);
                    rest = &after[first + close + m.len()..];
                    continue 'outer;
                }
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// `sessionIdsOf`: the helper sessions that executed it, in order.
pub fn session_ids_of(issue: &Issue) -> Vec<&SessionId> {
    issue
        .executions()
        .filter_map(|e| match e {
            Execution::Worker { session, .. } => Some(session),
            Execution::Orchestrator { .. } => None,
        })
        .collect()
}

const TITLE_MAX: usize = 120;

/// `shortTitle`: one line for a title; preserves normal titles up to `TITLE_MAX`
/// characters and breaks overly long lines cleanly at punctuation or word boundaries.
pub fn short_title(text: &str) -> String {
    let line = text.split('\n').find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= TITLE_MAX {
        return line.to_string();
    }
    let head: String = chars[..TITLE_MAX + 1].iter().collect();
    // ^(.{4,}?)[。！？!?；;]
    let head_chars: Vec<char> = head.chars().collect();
    for (i, c) in head_chars.iter().enumerate() {
        if i >= 4 && "。！？!?；;".contains(*c) {
            return head_chars[..i].iter().collect::<String>().trim().to_string();
        }
    }
    // The last pause, by UTF-16 index as JavaScript's matchAll gives it.
    let mut pause: isize = -1;
    let mut unit = 0isize;
    for c in head.chars() {
        if "：:，,、".contains(c) {
            pause = unit;
        }
        unit += c.len_utf16() as isize;
    }
    if pause >= 4 {
        return slice(&head, 0, Some(pause as usize)).trim().to_string();
    }
    if let Some(space) = chars[..TITLE_MAX].iter().rposition(|c| c.is_whitespace())
        && space >= TITLE_MAX / 2
    {
        return chars[..space].iter().collect::<String>().trim_end().to_string() + "…";
    }
    chars[..TITLE_MAX - 1].iter().collect::<String>() + "…"
}

/// `closedText`: done with what it delivered, or canceled and why.
pub fn closed_text(issue: &Issue) -> String {
    if let Some(d) = issue.delivered {
        t("shared.doneWith", &[("what", t(&format!("shared.delivered.{}", d.as_str()), &[]).into())])
    } else if let Some(c) = issue.canceled {
        t("shared.canceledFor", &[("why", t(&format!("shared.canceled.{}", c.as_str()), &[]).into())])
    } else {
        t(&format!("shared.status.{}", issue.status.as_str()), &[])
    }
}

/// `spanText`: seconds under a minute (at least one), else minutes.
fn span_text(ms: i64) -> String {
    if ms < 60_000 {
        t("shared.seconds", &[("n", ((ms as f64 / 1000.0).round().max(1.0)).into())])
    } else {
        t("shared.minutes", &[("n", (ms as f64 / 60_000.0).round().into())])
    }
}

pub(crate) fn is_busy(s: &Session) -> bool {
    s.phase.is_working()
}

/// `roomLeft`: how many more may start now, on the farm and in the repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Room {
    pub farm: usize,
    /// `None` is no limit of the repo's own (JavaScript's Infinity).
    pub repo: Option<usize>,
    pub busy: usize,
    pub in_repo: usize,
}

pub fn room_left(sessions: &[Session], repo: &str, space: usize, per_repo: usize, except: &str) -> Room {
    let busy: Vec<&Session> = sessions.iter().filter(|h| h.is_board_worker() && is_busy(h) && h.id != except).collect();
    let in_repo = busy.iter().filter(|h| h.repo_name() == Some(repo)).count();
    Room {
        farm: if space == 0 { usize::MAX } else { space.saturating_sub(busy.len()) },
        repo: (per_repo > 0).then(|| per_repo.saturating_sub(in_repo)),
        busy: busy.len(),
        in_repo,
    }
}

/// `Need`: what a session wants of someone.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Need {
    Quiet { since: i64 },
    Retrying { retry: Retry },
    Conflict { conflict: Conflict },
    Review,
    Fix,
}

pub(crate) fn need_of(h: &Session, conflict: Option<&Conflict>) -> Option<Need> {
    match &h.phase {
        Phase::Working(p) => {
            if let Some(since) = p.quiet_since {
                Some(Need::Quiet { since })
            } else {
                p.retry.clone().map(|retry| Need::Retrying { retry })
            }
        }
        Phase::Done(_) => Some(match conflict {
            Some(c) => Need::Conflict { conflict: c.clone() },
            None => Need::Review,
        }),
        Phase::Failed(_) => Some(Need::Fix),
        Phase::Resting(_) => conflict.map(|c| Need::Conflict { conflict: c.clone() }),
        Phase::Closed(_) => None,
    }
}

const PHASE_SPAN: &str = "{span}";

/// `phaseText`: `phase_words` as said at `now`.
pub fn phase_text(h: &Session, now: i64, conflict: Option<&Conflict>) -> String {
    let said = phase_words(h, conflict);
    match need_of(h, conflict) {
        Some(Need::Quiet { since }) => said.replace(PHASE_SPAN, &span_text(now - since)),
        _ => said,
    }
}

/// `phaseWords`: what a session is doing in words; how long it has been
/// quiet is left as `{span}`.
pub(crate) fn phase_words(h: &Session, conflict: Option<&Conflict>) -> String {
    let need = need_of(h, conflict);
    let conflict_words = match &need {
        Some(Need::Conflict { conflict }) => t(
            "shared.phase.conflict",
            &[("base", conflict.base.clone().into()), ("files", list(&conflict.files).into())],
        ),
        _ => String::new(),
    };
    match &h.phase {
        Phase::Working(p) => {
            let action = t(&format!("shared.action.{}", p.doing.action.as_str()), &[]);
            let what = if !p.doing.label.is_empty() {
                t("shared.phase.workingOn", &[("action", action.into()), ("label", p.doing.label.clone().into())])
            } else {
                t("shared.phase.working", &[("action", action.into())])
            };
            match need {
                Some(Need::Quiet { .. }) => t("shared.phase.quiet", &[("what", what.into()), ("span", PHASE_SPAN.into())]),
                Some(Need::Retrying { retry }) => match retry.of {
                    Some(of) if of != 0 => t(
                        "shared.phase.retryingOf",
                        &[("what", what.into()), ("attempt", retry.attempt.into()), ("of", of.into())],
                    ),
                    _ => t("shared.phase.retrying", &[("what", what.into()), ("attempt", retry.attempt.into())]),
                },
                _ => what,
            }
        }
        Phase::Done(_) => t("shared.phase.done", &[("conflict", conflict_words.into())]),
        Phase::Failed(_) => t("shared.phase.failed", &[]),
        Phase::Resting(_) => match h.last_run.as_ref().map(|r| r.outcome) {
            None => t("shared.phase.rested", &[("conflict", conflict_words.into())]),
            Some(outcome) => t(
                "shared.phase.resting",
                &[
                    ("last", t(&format!("shared.outcome.{}", outcome.as_str()), &[]).into()),
                    ("conflict", conflict_words.into()),
                ],
            ),
        },
        Phase::Closed(_) => String::new(),
    }
}

/// `farmOf`: each repo has its own farm; sessions without one share one.
pub fn farm_of(h: &Session) -> &str {
    h.repo_name().unwrap_or("")
}

/// `plotKeyOf`: its issue, so a reopened issue keeps its plot.
pub(crate) fn plot_key_of(h: &Session) -> &str {
    h.issue_id().unwrap_or(&h.id)
}

/// `actorRoleOf`.
pub fn actor_role_of(actor: &Actor) -> Option<AgentRole> {
    match actor {
        Actor::Agent { role, .. } => Some(*role),
        _ => None,
    }
}

const KEY_DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_KEY_LEN: usize = 256;

pub(crate) fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= MAX_KEY_LEN && !k.ends_with('0') && k.chars().all(|c| KEY_DIGITS.contains(c))
}

/// `keyBetween`: a key after `a` and before `b`; "" is the start or the end.
pub fn key_between(a: &str, b: &str) -> Result<String, String> {
    if (!a.is_empty() && !valid_key(a)) || (!b.is_empty() && !valid_key(b)) {
        return Err(t("shared.order.invalid", &[]));
    }
    if !a.is_empty() && !b.is_empty() && a >= b {
        return Err(t("shared.order.unordered", &[("a", a.into()), ("b", b.into())]));
    }
    Ok(if b.is_empty() {
        if a.is_empty() { "V".into() } else { step_up(a) }
    } else if a.is_empty() {
        before(b)
    } else {
        midpoint(a, b)
    })
}

fn digit_at(i: usize) -> char {
    KEY_DIGITS.as_bytes().get(i).map_or('0', |b| *b as char)
}

fn index_of_head(s: &str) -> usize {
    KEY_DIGITS.find(s.chars().next().unwrap_or('0')).unwrap_or(0)
}

fn step_up(a: &str) -> String {
    let Some(head) = a.chars().next() else { return "1".into() };
    let i = KEY_DIGITS.find(head).unwrap_or(0);
    if i < KEY_DIGITS.len() - 1 {
        digit_at(i + 1).to_string()
    } else {
        format!("{head}{}", step_up(&a[1..]))
    }
}

fn before(b: &str) -> String {
    let i = index_of_head(b);
    if i > 1 {
        digit_at(i - 1).to_string()
    } else if i == 1 {
        "0z".into()
    } else {
        format!("0{}", before(&b[1..]))
    }
}

fn digit_of(s: &str, i: usize) -> char {
    s.as_bytes().get(i).map_or('0', |b| *b as char)
}

fn midpoint(a: &str, b: &str) -> String {
    if !b.is_empty() {
        let mut n = 0;
        while n < b.len() && digit_of(a, n) == b.as_bytes()[n] as char {
            n += 1;
        }
        if n > 0 {
            return format!("{}{}", &b[..n], midpoint(if n < a.len() { &a[n..] } else { "" }, &b[n..]));
        }
    }
    let lo = if a.is_empty() { 0 } else { index_of_head(a) };
    let hi = if b.is_empty() { KEY_DIGITS.len() } else { index_of_head(b) };
    if hi - lo > 1 {
        return digit_at((lo + hi).div_ceil(2)).to_string();
    }
    if b.len() > 1 {
        return b[..1].to_string();
    }
    format!("{}{}", digit_at(lo), midpoint(if a.len() > 1 { &a[1..] } else { "" }, ""))
}

/// `actCommand`: the CLI command that does one of an issue's acts.
pub fn act_command(
    issue: &vibevalley_protocol::Issue,
    a: &vibevalley_protocol::IssueAction,
    session: Option<&str>,
) -> Option<(Vec<String>, vibevalley_protocol::ActWords)> {
    let n = issue.number.to_string();
    match a {
        vibevalley_protocol::IssueAction::Move { status, words, .. } => Some((vec!["issue".into(), "status".into(), n, status.as_str().into()], *words)),
        vibevalley_protocol::IssueAction::Say { .. } => Some((vec!["issue".into(), "comment".into(), n], vibevalley_protocol::ActWords::Required)),
        vibevalley_protocol::IssueAction::Stop { .. } => {
            session.map(|s| (vec!["session".into(), "stop".into(), s.into()], vibevalley_protocol::ActWords::None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_are_cut_as_javascript_cuts_them() {
        assert_eq!(js_len("a😀"), 3);
        assert_eq!(cut("ab😀cd", 3), "ab\u{FFFD}…");
        assert_eq!(clip("  a\n b  ", 10), "a b");
        assert_eq!(clip("abcdef", 4), "abc…");
    }

    #[test]
    fn plain_text_drops_markdown() {
        assert_eq!(plain_text("# Hi **there** [x](y)\n- `a` | b"), "Hi there x a b");
    }

    #[test]
    fn order_keys_sort_between() {
        let a = key_between("", "").unwrap();
        let b = key_between(&a, "").unwrap();
        let m = key_between(&a, &b).unwrap();
        assert!(a < m && m < b, "{a} {m} {b}");
        let z = key_between("", &a).unwrap();
        assert!(z < a);
        assert!(key_between("b", "a").is_err());
    }

    #[test]
    fn short_titles() {
        assert_eq!(short_title("\n  fix it \nmore"), "fix it");
        let english = "Polish mobile responsive layout for remote worktree session view";
        assert_eq!(short_title(english), english);
        let chinese = "这是一个很长的标题，里面有很多很多的字，一直写下去一直写下去一直写下去一直写下去再写一点";
        assert_eq!(short_title(chinese), chinese);
        let over_cap = format!("{chinese}，{}", "继续补充更多背景说明内容".repeat(8));
        assert_eq!(short_title(&over_cap), chinese);
        let long_english = "Implement full end-to-end streaming transport synchronization across desktop workbench and mobile remote clients without truncating mid word anywhere";
        let cut_english = short_title(long_english);
        assert!(cut_english.ends_with('…'));
        assert!(cut_english.chars().count() <= TITLE_MAX);
        assert!(!cut_english.ends_with("tru…"));
    }

    #[test]
    fn room_left_unbounded_when_space_and_per_repo_are_zero() {
        let sessions: Vec<Session> = (1..=10)
            .map(|i| {
                let mut s = Session::new(
                    format!("s{i}"),
                    SessionController::IssueBoard,
                    format!("worker-{i}"),
                    "claude",
                    ExecutionPolicy::ManagedWorktree {
                        repo: "app".into(),
                        branch: None,
                    },
                    100,
                );
                s.phase = Phase::working(100, SessionAction::EditFile, "edit");
                s
            })
            .collect();
        let room = room_left(&sessions, "app", 0, 0, "");
        assert_eq!(room.farm, usize::MAX);
        assert_eq!(room.repo, None);
        assert_eq!(room.busy, 10);
        assert_eq!(room.in_repo, 10);
    }
}
