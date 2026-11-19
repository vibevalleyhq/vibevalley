//! Reading what an agent said. Ported from VibeValley
//! `apps/server/src/base/questions.ts` (`questionsFromText`),
//! `base/json.ts` (`lastJsonBlock`) and `modules/session/report.ts`
//! (`summaryOf`). VibeValley's agents are told to write in English, so the
//! question marker is `Ask the user:`; VibeValley's `要问用户：` is read too.

use serde::de::DeserializeOwned;

use vibevalley_protocol::{CheckResult, CriterionCheck, Question};

const ASK_MARKERS: [&str; 2] = ["ask the user", "要问用户"];

fn strip_emphasis(s: &str) -> &str {
    s.trim().trim_start_matches("**").trim_end_matches("**").trim()
}

/// `checksFromText`: a helper's word on each criterion, one `标准 N：做到了|没做到|不确定 —— 依据` line each;
/// explicit `issue_report.checks` win over these.
pub fn checks_from_text(said: &str) -> Vec<CriterionCheck> {
    said.split('\n')
        .filter_map(|line| {
            let rest = line.strip_prefix("标准")?.trim_start();
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            let n: i64 = digits.parse().ok()?;
            let rest = rest[digits.len()..].trim_start();
            let rest = rest.strip_prefix('：').or_else(|| rest.strip_prefix(':'))?.trim_start();
            let (result, rest) = [("做到了", CheckResult::Met), ("没做到", CheckResult::Unmet), ("不确定", CheckResult::Unsure)]
                .into_iter()
                .find_map(|(word, result)| rest.strip_prefix(word).map(|r| (result, r)))?;
            let proof = match rest.trim_start().strip_prefix("——") {
                Some(p) => p.trim().to_string(),
                None if rest.trim().is_empty() => String::new(),
                None => return None,
            };
            (n >= 1).then(|| CriterionCheck {
                criterion: n - 1,
                result,
                proof,
            })
        })
        .collect()
}

/// The questions an agent's question lines ask, one per line. A tail
/// `(options: A | B)` gives the options (at least two).
pub fn questions_from_text(said: &str) -> Vec<Question> {
    said.lines().filter_map(question_of).collect()
}

fn question_of(line: &str) -> Option<Question> {
    let line = line.trim_start_matches(|c: char| c.is_whitespace() || ">*#_-".contains(c));
    let line = line.trim_start_matches("**");
    let lower = line.to_lowercase();
    let marker = ASK_MARKERS.iter().find(|m| lower.starts_with(*m))?;
    let rest = &line[marker.len()..];
    let rest = strip_emphasis(rest);
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('：'))?;
    let raw = strip_emphasis(rest);
    if raw.is_empty() {
        return None;
    }
    let (question, options) = match options_tail(raw) {
        Some((at, options)) => (raw[..at].trim().to_string(), options),
        None => (raw.to_string(), vec![]),
    };
    Some(Question {
        question,
        options: if options.len() >= 2 { options } else { vec![] },
    })
}

/// `(options: A | B)` or `（选项：A｜B）` at the end of the line.
fn options_tail(raw: &str) -> Option<(usize, Vec<String>)> {
    let trimmed = raw.trim_end();
    let close = trimmed.chars().last()?;
    if close != ')' && close != '）' {
        return None;
    }
    let open = trimmed.rfind(['(', '（'])?;
    let inner = &trimmed[open..trimmed.len() - close.len_utf8()];
    let inner = inner.trim_start_matches(['(', '（']).trim();
    let lower = inner.to_lowercase();
    let body = ["options", "选项"].iter().find_map(|w| lower.starts_with(w).then(|| &inner[w.len()..]))?;
    let body = body.trim_start();
    let body = body.strip_prefix(':').or_else(|| body.strip_prefix('：'))?;
    let options = body.split(['|', '｜']).map(str::trim).filter(|o| !o.is_empty()).map(String::from).collect();
    Some((open, options))
}

/// What an undeclared report says in short: the last paragraphs, at least
/// `min` characters of them.
pub fn conclusion(text: &str, min: usize) -> String {
    let text = text.trim();
    let blocks: Vec<&str> = text.split("\n\n").map(str::trim).filter(|b| !b.is_empty()).collect();
    let mut tail = String::new();
    for block in blocks.iter().rev() {
        if tail.chars().count() >= min {
            break;
        }
        tail = if tail.is_empty() { block.to_string() } else { format!("{block}\n\n{tail}") };
    }
    tail
}

pub fn summary_of(text: &str) -> String {
    conclusion(text, 80)
}

/// Cuts to `max` characters, ending in `…` when cut.
pub fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The fenced blocks of a text (```json or bare), in order.
pub fn fenced_blocks(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let Some(newline) = after.find('\n') else { break };
        let lang = after[..newline].trim();
        let body = &after[newline + 1..];
        let Some(end) = body.find("```") else { break };
        if lang.is_empty() || lang.eq_ignore_ascii_case("json") || lang.starts_with("json") {
            out.push(&body[..end]);
        }
        rest = &body[end + 3..];
    }
    out
}

/// Why no block was taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockProblem {
    /// The text has no fenced block.
    None,
    /// The last block tried is not JSON, or JSON of another shape.
    Unreadable(String),
    /// It fits, but the caller refused it.
    Refused(String),
}

/// The last fenced block that decodes as `T` and that `refuse` does not
/// refuse.
pub fn last_json_block<T: DeserializeOwned>(text: &str, refuse: impl Fn(&T) -> Option<String>) -> Result<T, BlockProblem> {
    let mut problem = BlockProblem::None;
    for block in fenced_blocks(text).into_iter().rev() {
        match serde_json::from_str::<T>(block) {
            Err(e) => problem = BlockProblem::Unreadable(e.to_string()),
            Ok(value) => match refuse(&value) {
                None => return Ok(value),
                Some(why) => problem = BlockProblem::Refused(why),
            },
        }
    }
    Err(problem)
}

#[cfg(test)]
mod checks_tests {
    use vibevalley_protocol::CheckResult;

    #[test]
    fn criteria_lines_read_as_checks() {
        let c = super::checks_from_text("做完了\n\n标准 1：做到了 —— 跑了 echo hi\n标准2:不确定\n标准 0：做到了\n标准 3：大概吧");
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].criterion, c[0].result, c[0].proof.as_str()), (0, CheckResult::Met, "跑了 echo hi"));
        assert_eq!((c[1].criterion, c[1].result), (1, CheckResult::Unsure));
    }
}
