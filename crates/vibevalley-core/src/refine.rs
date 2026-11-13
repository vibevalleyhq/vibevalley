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

pub const REFINEMENT_OPENING: &str = "This round you only draft an issue: read the code and write what the user wants \
done as an issue another agent can be sent to do. Do not change files and do not commit; whatever you change is \
thrown away when you hand back.";

/// The drafting session's prompt. The draft so far goes in when there is
/// one: the user may have edited it.
pub fn refinement_brief(
    title: &str,
    description: &str,
    criteria: &[String],
    questions: &[Question],
    word: &str,
    repo: Option<&str>,
    discussion: &str,
) -> String {
    let word = word.trim();
    let answering = !word.is_empty() && !questions.is_empty();
    let redraft = !description.is_empty() || !criteria.is_empty();
    let mut lines: Vec<String> = vec![REFINEMENT_OPENING.into(), String::new()];
    lines.push(match repo {
        Some(repo) => format!("Repository: {repo} (you are in a checkout of it now)."),
        None => "No repository is chosen: discuss only the goal, scope, what is not done, acceptance criteria and \
                 the deliverable; do not create a repository and do not implement anything."
            .into(),
    });
    lines.push(format!("What the user wants: {}", if !word.is_empty() && !redraft { word } else { title }));
    if !discussion.is_empty() {
        let tail: String = {
            let chars: Vec<char> = discussion.chars().collect();
            chars[chars.len().saturating_sub(24_000)..].iter().collect()
        };
        lines.extend([
            "".into(),
            "The issue's discussion so far (context; it does not replace the request):".into(),
            tail,
        ]);
    }
    if redraft {
        lines.extend(["".into(), "The previous draft (the user may have edited it; it is the one to go by):".into()]);
        lines.push(format!("Title: {title}"));
        if !description.is_empty() {
            lines.push(description.into());
        }
        if !criteria.is_empty() {
            lines.push(format!("Acceptance criteria:\n- {}", criteria.join("\n- ")));
        }
    }
    if answering {
        let asked: Vec<&str> = questions.iter().map(|q| q.question.as_str()).collect();
        lines.extend([
            "".into(),
            format!("What you asked the user last time:\n- {}", asked.join("\n- ")),
            format!("The user's answer: {word}"),
            "".into(),
            "Draft it again from the user's answer; rewrite the whole issue.".into(),
        ]);
    } else if redraft && !word.is_empty() {
        lines.extend([
            "".into(),
            format!("The user says now: {word}"),
            "".into(),
            "Draft it again as the user says; rewrite the whole issue.".into(),
        ]);
    } else if redraft {
        lines.extend(["".into(), "Draft it again; rewrite the whole issue.".into()]);
    }
    lines.extend([
        "".into(),
        if repo.is_some() {
            "Read the code first to learn how things are, then write. The rules:"
        } else {
            "Put the request in order from the discussion; assume nothing about a repository. The rules:"
        }
        .into(),
        "- title: a short title saying what to do, at most 10 words; details go in why and todo.".into(),
        "- why: why it is wanted, a sentence or two.".into(),
        "- todo: the things to do, one per line, down to where the change goes.".into(),
        "- criteria: how to tell it is done, each one a point the user can check (a command to run and what it \
         prints, what a page looks like)."
            .into(),
        "- notDoing: what this issue does not do, so no more gets done; an empty array when nothing.".into(),
        "- files: the files or directories it will likely touch.".into(),
        "- What you are unsure of and the user must decide: write it before the code block, one question per \
         line, each line starting with `Ask the user:`; put the answers you can think of at the end as \
         `(options: A | B)`. Do not ask what you can find out yourself. Write the whole draft from your best guess \
         anyway."
            .into(),
        "".into(),
        "End your reply with the draft in a json code block shaped like this:".into(),
        "```json".into(),
        r#"{
  "title": "Drag on the board calls issue.status",
  "why": "Dragging a card still calls the old start endpoint, so moving it to done does nothing.",
  "todo": ["board.rs: call issue.status on drop", "remove the old endpoint's caller"],
  "criteria": ["dragging a backlog card to todo starts it", "cargo test -p board passes"],
  "notDoing": ["the board's look"],
  "files": ["crates/board/src/board.rs"]
}"#
        .into(),
        "```".into(),
        "After the block, say in one sentence whether the draft is ready and what you still ask the user.".into(),
    ]);
    lines.join("\n")
}
