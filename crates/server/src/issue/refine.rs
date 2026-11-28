//! Drafting: a session reads the code read-only and writes the issue up
//! from the user's words: a title, description, criteria and questions,
//! which go onto the issue when its round ends.

use vibevalley_core::Refusal;
use vibevalley_protocol::{IssueStatus, Outcome, RunTriggerKind};
use vibevalley_runtime::oar::StopReason;

use super::board::Board;
use super::store::{BoardError, IssueChange, Result};
use crate::runtime::{DraftEnd, Hire, trigger_of};

impl Board {
    /// Sends a drafting session to write the issue up from `words`.
    pub async fn refine_words_async(&self, reference: &str, words: &str) -> Result<String> {
        self.refine_with_async(reference, words, "").await
    }

    /// `refine`, with the issue's discussion so far for the drafting prompt.
    pub async fn refine_with_async(&self, reference: &str, words: &str, discussion: &str) -> Result<String> {
        let _work = self.work.lock().await;
        let issue = self.stored_async(reference).await?;
        if issue.status != IssueStatus::Backlog {
            return Err(BoardError::Other("only an issue in the backlog is drafted".into()));
        }
        if let Some(r) = &issue.refining {
            return Err(BoardError::Refused(Refusal::Drafting { name: r.name.clone() }));
        }
        let drive = self.runtime.driver().drafter(&issue).await?;
        let (space, repo) = self.room_async(&issue, "").await;
        if space == 0 || repo == 0 {
            return Err(BoardError::NoRoom("no room for a drafting session".into()));
        }
        let cwd = self.resolve_issue_cwd_async(&issue, drive.is_local).await;
        let word = words.trim();
        let mut prompt = vibevalley_core::refine::refinement_brief(
            &issue.title,
            &issue.description,
            &issue.criteria,
            &issue.questions,
            word,
            issue.repo.as_deref(),
            discussion,
        );
        let attachments = super::board::attachments_brief(&issue, self.storage().map(std::sync::Arc::as_ref));
        if !attachments.is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(&attachments);
        }
        let issue = if issue.assigned_agent().is_none() && !drive.agent.is_empty() {
            self.change_async(&issue.id, IssueChange::Assigned(drive.agent.clone())).await?
        } else {
            issue
        };
        let name = format!("{} (draft #{})", drive.name, issue.number);
        let state = self.state.clone();
        let issue_id = issue.id.clone();
        self.session_engine()
            .hire_async(Hire {
                issue: &issue,
                name,
                brief: format!("Draft: {}", issue.title),
                drive,
                cwd,
                drafting: true,
                prompt,
                trigger: trigger_of(RunTriggerKind::Refine, Some(word.to_string()).filter(|w| !w.is_empty())),
                on_start: Some(Box::new(move |sid| {
                    state.issue_change_hook(
                        issue_id,
                        IssueChange::Started {
                            session: sid.to_string(),
                            worker: false,
                        },
                    )
                })),
            })
            .await
            .map_err(Into::into)
    }

    /// A drafting round's end: the draft onto the issue, what the issue's
    /// thread is told as the drafter's report, and the drafter goes home.
    pub(super) async fn finish_draft_async(&self, end: DraftEnd) {
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
        let sessions = self.session_engine();
        if let Err(err) = sessions.end_run_async(&session.id, outcome, &said_back, spent.clone()).await {
            tracing::warn!(issue_id = %issue.id, session_id = %session.id, error = %err, "issue.refine failed to record run end");
        }
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
                if let Err(e) = self.change_async(&issue.id, drafted).await {
                    eprintln!("vibevalley: draft of issue {}: {e}", issue.id);
                }
                parts.join("\n\n")
            }
            Err(problem) if reason == StopReason::Completed => name("server.issue.refinement.unread", ("problem", problem)),
            Err(_) => name("server.issue.refinement.unfinished", ("summary", vibevalley_core::text::summary_of(&said))),
        };
        if let Err(err) = sessions.settle_report_async(&session, outcome, told, spent, None, None, None).await {
            tracing::warn!(issue_id = %issue.id, session_id = %session.id, error = %err, "issue.refine failed to settle report");
        }
        // Not under `work`: a draft only touches its own issue and session.
        if let Err(e) = sessions.dismiss_async(&session.id).await {
            eprintln!("vibevalley: draft session {}: {e}", session.id);
        }
    }
}
