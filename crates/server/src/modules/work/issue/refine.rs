//! Drafting: a session reads the code read-only and writes the issue up
//! from the user's words: a title, description, criteria and questions,
//! which go onto the issue when its round ends.

use vibevalley_core::Refusal;
use vibevalley_protocol::{Fact, IssueStatus, Outcome, RunTriggerKind};
use vibevalley_runtime::oar::StopReason;

use super::board::Board;
use crate::modules::work::ledger::{BoardError, IssueChange, Result, now};
use crate::modules::work::session::{DraftEnd, Hire, trigger_of};
use crate::modules::work::workplace::Leave;

impl Board {
    /// Sends a drafting session to write the issue up from `words`.
    pub fn refine(&self, reference: &str, words: &str) -> Result<String> {
        self.refine_with(reference, words, "")
    }

    /// `refine`, with the issue's discussion so far for the drafting prompt.
    pub fn refine_with(&self, reference: &str, words: &str, discussion: &str) -> Result<String> {
        let _work = self.0.work.lock();
        let issue = self.stored(reference)?;
        if issue.status != IssueStatus::Backlog {
            return Err(BoardError::Other("only an issue in the backlog is drafted".into()));
        }
        if let Some(r) = &issue.refining {
            return Err(BoardError::Refused(Refusal::Drafting { name: r.name.clone() }));
        }
        let drive = self.0.drivers.drafter(&issue)?;
        let (space, repo) = self.room(&issue, "");
        if space == 0 || repo == 0 {
            return Err(BoardError::NoRoom("no room for a drafting session".into()));
        }
        let wp = &self.0.workplaces;
        // Each draft starts from the main branch; skip local worktrees for remote machines.
        let (cwd, branch, base) = if !drive.is_local {
            let branch = issue.repo.as_ref().map(|_| crate::modules::work::workplace::issue_branch(issue.number));
            let base = if let Some(repo) = issue.repo.as_deref() {
                wp.existing(repo)?
                    .and_then(|main| crate::modules::work::workplace::Workplace::main_branch(&main).ok())
                    .or_else(|| Some("main".to_string()))
            } else {
                None
            };
            (std::path::PathBuf::new(), branch, base)
        } else {
            match wp.main_repo(issue.repo.as_deref())? {
                Some(main) => {
                    let (dir, branch, base) = wp.fresh_worktree(&main, issue.number)?;
                    (dir, Some(branch), Some(base))
                }
                None => (wp.context(&issue.id)?, None, None),
            }
        };
        let word = words.trim();
        let prompt = vibevalley_core::refine::refinement_brief(
            &issue.title,
            &issue.description,
            &issue.criteria,
            &issue.questions,
            word,
            issue.repo.as_deref(),
            discussion,
        );
        let issue = if issue.assigned_agent().is_none() && !drive.agent.is_empty() {
            self.change(&issue.id, IssueChange::Assigned(drive.agent.clone()))?
        } else {
            issue
        };
        let name = format!("{} (draft #{})", drive.name, issue.number);
        self.0.sessions.hire(Hire {
            issue: &issue,
            name,
            brief: format!("Draft: {}", issue.title),
            drive,
            cwd,
            branch,
            base,
            drafting: true,
            prompt,
            trigger: trigger_of(RunTriggerKind::Refine, Some(word.to_string()).filter(|w| !w.is_empty())),
        })
    }

    /// A drafting round's end: the draft onto the issue, what the issue's
    /// thread is told as the drafter's report, and the drafter goes home.
    pub(super) fn finish_draft(&self, end: DraftEnd) {
        let DraftEnd {
            spent,
            session,
            issue,
            reason,
            said,
            asked,
        } = end;
        let read = if reason == StopReason::Completed {
            vibevalley_core::refine::parse_refinement(&said)
        } else {
            Err(format!("the draft did not finish ({reason:?})"))
        };
        let (outcome, said_back) = match &read {
            Ok(draft) => (Outcome::Completed, draft.title.clone()),
            Err(problem) => (
                if reason == StopReason::Aborted {
                    Outcome::Interrupted
                } else {
                    Outcome::Failed
                },
                problem.clone(),
            ),
        };
        let sessions = &self.0.sessions;
        let _ = sessions.end_run(&session.id, outcome, &said_back, spent.clone());
        // What the issue's thread is told (`handedBack`).
        let name = |key: &str, extra: (&str, String)| vibevalley_i18n::t(key, &[("name", session.name.clone().into()), (extra.0, extra.1.into())]);
        let told = match read {
            Ok(draft) => {
                let mut questions = vibevalley_core::text::questions_from_text(&said);
                questions.extend(asked.iter().cloned());
                let questions = vibevalley_core::refine::open_questions(&questions);
                let description = vibevalley_core::refine::refinement_description(&draft);
                let criteria = vibevalley_core::refine::kept(&draft.criteria);
                let mut parts = vec![draft.title.clone(), description.clone()];
                parts.extend(criteria.iter().cloned());
                parts.extend(questions.iter().map(|q| {
                    std::iter::once(q.question.clone())
                        .chain(q.options.iter().cloned())
                        .collect::<Vec<_>>()
                        .join("\n")
                }));
                let drafted = IssueChange::Drafted {
                    title: draft.title.clone(),
                    description,
                    criteria,
                    questions,
                };
                if let Err(e) = self.change(&issue.id, drafted) {
                    eprintln!("vibevalley: draft of issue {}: {e}", issue.id);
                }
                parts.join("\n\n")
            }
            Err(problem) if reason == StopReason::Completed => name("server.issue.refinement.unread", ("problem", problem)),
            Err(_) => name("server.issue.refinement.unfinished", ("summary", vibevalley_core::text::summary_of(&said))),
        };
        let _ = self.0.ledger.apply(vec![Fact::SessionReported(vibevalley_protocol::FactSessionReported {
            at: now(),
            id: session.id.clone(),
            run: None,
            outcome,
            phase: None,
            summary: told,
            runs: session.runs + 1,
            spent,
            questions: vec![],
            checks: vec![],
            answer: None,
        })]);
        // Not under `work`: a draft only touches its own issue and session.
        if let Err(e) = sessions.dismiss(&session.id, Leave::Discard) {
            eprintln!("vibevalley: draft session {}: {e}", session.id);
        }
    }
}
