//! Drafting an issue (refine): what the drafting session is told and how its
//! draft is read back. Ported from VibeValley
//! `apps/server/src/modules/issue/refinement.ts` (`parseRefinement`,
//! `refinementDescription`, `kept`) and `prompts.ts` (`refinementBrief`).
//! VibeValley's prompts are in English.

use serde::{Deserialize, Deserializer};

use crate::text::{BlockProblem, clip, last_json_block};
use vibevalley_protocol::Question;

/// A draft as the drafting session writes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Draft {
    pub title: String,
    pub why: String,
    pub todo: Vec<String>,
    pub criteria: Vec<String>,
    pub not_doing: Vec<String>,
    pub files: Vec<String>,
}

/// A missing or null field is empty; one line may stand for a list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Block {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    why: Option<String>,
    #[serde(default, deserialize_with = "lines")]
    todo: Vec<String>,
    #[serde(default, deserialize_with = "lines")]
    criteria: Vec<String>,
    #[serde(default, alias = "not_doing", deserialize_with = "lines")]
    not_doing: Vec<String>,
    #[serde(default, deserialize_with = "lines")]
    files: Vec<String>,
}

fn lines<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Lines {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Option::<Lines>::deserialize(d)? {
        None => vec![],
        Some(Lines::One(s)) => vec![s],
        Some(Lines::Many(v)) => v,
    })
}

/// Non-empty lines, trimmed.
pub fn kept(lines: &[String]) -> Vec<String> {
    lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// Questions with words in them.
pub fn open_questions(questions: &[Question]) -> Vec<Question> {
    questions.iter().filter(|q| !q.question.trim().is_empty()).cloned().collect()
}

/// The last block that reads as a draft with a title; the error says why
/// none did.
pub fn parse_refinement(text: &str) -> Result<Draft, String> {
    let read = last_json_block::<Block>(text, |b| {
        clip(b.title.as_deref().unwrap_or(""), 80)
            .is_empty()
            .then(|| "the draft has no title".to_string())
    });
    match read {
        Ok(b) => Ok(Draft {
            title: clip(b.title.as_deref().unwrap_or(""), 80),
            why: b.why.unwrap_or_default(),
            todo: b.todo,
            criteria: b.criteria,
            not_doing: b.not_doing,
            files: b.files,
        }),
        Err(BlockProblem::None) => Err("no ```json block with the draft".into()),
        Err(BlockProblem::Unreadable(why)) => Err(format!("the draft block cannot be read: {why}")),
        Err(BlockProblem::Refused(why)) => Err(why),
    }
}

/// The issue's description written from a draft.
pub fn refinement_description(d: &Draft) -> String {
    let mut parts = Vec::new();
    let why = d.why.trim();
    if !why.is_empty() {
        parts.push(format!("Why\n{why}"));
    }
    for (head, lines) in [("To do", kept(&d.todo)), ("Not doing", kept(&d.not_doing)), ("Files", kept(&d.files))] {
        if !lines.is_empty() {
            parts.push(format!("{head}\n- {}", lines.join("\n- ")));
        }
    }
    parts.join("\n\n")
}

pub use crate::prompts::REFINEMENT_OPENING;

/// The drafting session's prompt (`refinementBrief`).
pub fn refinement_brief(
    title: &str,
    description: &str,
    criteria: &[String],
    questions: &[Question],
    word: &str,
    repo: Option<&str>,
    discussion: &str,
) -> String {
    crate::prompts::refinement_brief(title, description, criteria, questions, word, repo.unwrap_or(""), discussion)
}
