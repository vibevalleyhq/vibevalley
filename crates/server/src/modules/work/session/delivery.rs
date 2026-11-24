use super::{Sessions, db};
use crate::modules::work::ledger::Result;
use serde_json::{Value, json};
use vibevalley_protocol::{Millis, Outcome, Run, RunTriggerKind, Session};
use vibevalley_runtime::agent::durable::{Error, Result as DurableResult, Store, Submission, SubmissionStatus, Tx};

use super::sessions::Extra;

pub(crate) fn delivery_conversation(issue: &str) -> String {
    format!("issue:{issue}")
}

impl Sessions {
    pub(super) fn graded_output(&self, session: &Session, extra: &Extra) -> Result<Option<String>> {
        if session.runtime != vibevalley_runtime::agent::runtime::ID {
            return Ok(None);
        }
        let (Some(run), Some(vendor)) = (&extra.run, &extra.agent_session) else {
            return Ok(None);
        };
        Ok(self.0.durable.read(|tx| {
            let sub = tx.submission_by_request(&vibevalley_runtime::agent::harness::worker_conversation(vendor), &format!("work:{run}"))?;
            Ok(sub
                .filter(|s| s.status == SubmissionStatus::Done && s.result["rubricVerdict"]["satisfied"] == true)
                .and_then(|s| s.result["output"].as_str().map(str::to_owned)))
        })?)
    }

    pub fn durable_store(&self) -> &Store {
        &self.0.durable
    }

    pub(crate) fn submit_words(&self, issue: &str, request: &str, words: &str) -> Result<Submission> {
        let conv = delivery_conversation(issue);
        Ok(self.0.durable.write(|tx| {
            match tx.conversation(&conv) {
                Err(Error::Missing(_)) => {
                    tx.create_conversation(&conv, "")?;
                }
                Ok(_) => (),
                Err(e) => return Err(e),
            }
            let (s, _) = tx.submit(&conv, request, "issue.message", &json!({"text":words}), None)?;
            Ok(s)
        })?)
    }

    pub(crate) fn queued_words(&self, issue: &str) -> Result<Vec<Submission>> {
        Ok(self.0.durable.read(|tx| {
            Ok(tx
                .submissions(&delivery_conversation(issue))?
                .into_iter()
                .filter(|s| s.status == SubmissionStatus::Queued)
                .collect())
        })?)
    }

    /// Reserve input against a running external process before writing to its protocol stream.
    /// An unknown outcome is reconciled from this run on recovery.
    pub(crate) fn bind_to_active_run(&self, session: &str, submission: &Submission) -> Result<bool> {
        let extras = self.0.extras.lock();
        let Some(id) = extras.get(session).and_then(|e| e.run.as_deref()) else {
            return Ok(false);
        };
        Ok(self.0.durable.write(|tx| {
            let Some(mut run) = crate::modules::work::block_on(db::run(tx.transaction(), id))? else {
                return Ok(false);
            };
            if run.outcome.is_some() {
                return Ok(false);
            }
            bind(tx, &mut run, submission)?;
            crate::modules::work::block_on(db::put_run(tx.transaction(), &run))?;
            Ok(true)
        })?)
    }

    pub(crate) fn settle_words(&self, id: &str, ok: bool, payload: &Value) -> Result<()> {
        self.0
            .durable
            .write(|tx| tx.settle(id, if ok { SubmissionStatus::Done } else { SubmissionStatus::Unanswered }, payload))?;
        Ok(())
    }
}

pub(super) fn bind(tx: &mut Tx<'_>, run: &mut Run, sub: &Submission) -> DurableResult<()> {
    if !run.heard.contains(&sub.request_id) {
        run.heard.push(sub.request_id.clone());
    }
    tx.set_submission_status(&sub.id, SubmissionStatus::Placed)?;
    Ok(())
}

pub(super) fn settle_run(tx: &mut Tx<'_>, run: &Run) -> DurableResult<()> {
    let Some(issue) = &run.issue else { return Ok(()) };
    let status = if run.outcome == Some(Outcome::Completed) {
        SubmissionStatus::Done
    } else {
        SubmissionStatus::Unanswered
    };
    let payload = json!({"issueId":issue,"sessionId":run.session,"runId":run.id,"outcome":run.outcome,"summary":run.summary,"spent":run.spent});
    for key in &run.heard {
        if let Some(sub) = tx.submission_by_request(&delivery_conversation(issue), key)? {
            tx.settle(&sub.id, status, &payload)?;
        }
    }
    if run.outcome != Some(Outcome::Interrupted) && run.triggered_by.kind != RunTriggerKind::Refine {
        tx.put_document("run", &run.id, "issue.report", &payload)?;
    }
    Ok(())
}

pub(crate) fn interrupt_on_reopen(
    tx: &mut Tx<'_>,
    session: &Session,
    extra: Option<&Extra>,
    at: Millis,
    summary: &str,
) -> DurableResult<Option<(String, bool)>> {
    let Some(mut extra) = extra.cloned() else { return Ok(None) };
    let Some(id) = extra.run.take() else { return Ok(None) };
    let mut needs_reconciliation = false;
    if let Some(mut run) = crate::modules::work::block_on(db::run(tx.transaction(), &id))? {
        if run.outcome.is_none() {
            run.ended_at = Some(at);
            run.outcome = Some(Outcome::Interrupted);
            run.summary = summary.into();
            if !session.is_refining() && session.runtime != vibevalley_runtime::agent::runtime::ID && run.issue.is_some() {
                tx.put_document(
                    "run",
                    &id,
                    "workspace.reconciliation",
                    &json!({"worktree":session.cwd,"branch":session.worktree_branch()}),
                )?;
                run.needs_reconciliation = true;
            }
            crate::modules::work::block_on(db::put_run(tx.transaction(), &run))?;
            settle_run(tx, &run)?;
        }
        needs_reconciliation = run.needs_reconciliation;
    }
    crate::modules::work::block_on(db::put_extra(tx.transaction(), &session.id, &extra))?;
    Ok(Some((id, needs_reconciliation)))
}
