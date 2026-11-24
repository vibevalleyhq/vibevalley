//! The structured report an agent hands back at the end of a round through
//! the `issue_report` tool (`SessionEngine::report`). A round with no report is
//! read from what the agent said.

use std::path::Path;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{CriterionCheck, Deliverable, IssueAnswer, IssueReportMemory, Question};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    /// The work is done and committed.
    #[default]
    Done,
    /// The agent cannot go on without an answer.
    Blocked,
    /// The agent tried and could not do it.
    Failed,
}

/// A question as a string, or with options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReportQuestion {
    Text(String),
    Full {
        question: String,
        #[serde(default)]
        options: Vec<String>,
    },
}

impl ReportQuestion {
    pub fn to_question(&self) -> Question {
        match self {
            ReportQuestion::Text(q) => Question {
                question: q.clone(),
                options: vec![],
            },
            ReportQuestion::Full { question, options } => Question {
                question: question.clone(),
                options: options.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Report {
    pub status: ReportStatus,
    pub summary: String,
    pub questions: Vec<ReportQuestion>,
    #[serde(deserialize_with = "lenient_answer")]
    pub answer: Option<IssueAnswer>,
    pub checks: Vec<CriterionCheck>,
    pub remember: Vec<IssueReportMemory>,
}

/// An answer as the agent writes it: only `conclusion` is required, the
/// lists of `IssueAnswer` default to empty.
fn lenient_answer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<IssueAnswer>, D::Error> {
    #[derive(Deserialize)]
    struct Said {
        conclusion: String,
        #[serde(default)]
        evidence: Vec<String>,
        #[serde(default)]
        unsure: Vec<String>,
        #[serde(default)]
        next: Vec<String>,
    }
    Ok(Option::<Said>::deserialize(d)?.map(|a| IssueAnswer {
        conclusion: a.conclusion,
        evidence: a.evidence,
        unsure: a.unsure,
        next: a.next,
    }))
}

impl Report {
    /// `None` when the file is missing or unreadable.
    pub fn read(path: &Path) -> Option<Report> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// Appended to the agent's system prompt when the drivers have no rules of
/// their own (standalone boards).
pub fn instructions(deliver: Deliverable) -> String {
    let work = match deliver {
        Deliverable::Change | Deliverable::Branch | Deliverable::PullRequest => {
            "You work in a git worktree on the issue's own branch. Commit your work there with a clear message; \
             do not switch branches, push or merge."
        }
        Deliverable::Answer => ANSWER_ONLY,
    };
    format!(
        "You are working on an issue from VibeValley's board. {work}\n\n\
         When you finish a round, call the issue_report tool of the vibevalley MCP server with a one or two \
         sentence summary, any questions for the user, and for an answer issue the answer."
    )
}

/// What an answer issue's helper is told beside its rules.
pub const ANSWER_ONLY: &str = "This issue asks for an answer, not a change: investigate read-only (read code, run read-only \
     commands) and do not modify or commit files; anything you change is thrown away.";
