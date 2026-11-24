use super::{SessionStore, db};
use crate::work::ledger::Result;
use serde_json::{Value, json};
use vibevalley_protocol::{Millis, Outcome, Run, RunTriggerKind, Session};
use vibevalley_runtime::agent::durable::{Error, Result as DurableResult, Store, Submission, SubmissionStatus, Tx};

use super::sessions::Extra;

pub(crate) fn delivery_conversation(issue: &str) -> String {
    format!("issue:{issue}")
}

impl SessionStore {
    pub(super) async fn graded_output_async(&self, session: &Session, extra: &Extra) -> Result<Option<String>> {
        if session.runtime != vibevalley_runtime::agent::runtime::ID {
            return Ok(None);
        }
        let (Some(run), Some(vendor)) = (&extra.run, &extra.agent_session) else {
            return Ok(None);
        };
        let conv = vibevalley_runtime::agent::harness::worker_conversation(vendor);
        let req = format!("work:{run}");
        Ok(self
            .0
            .durable
            .read_with_async((conv.as_str(), req.as_str()), |tx, &(conv, req)| {
                Box::pin(async move {
                    let sub = tx.submission_by_request_async(conv, req).await?;
                    Ok(sub
                        .filter(|s| s.status == SubmissionStatus::Done && s.result["rubricVerdict"]["satisfied"] == true)
                        .and_then(|s| s.result["output"].as_str().map(str::to_owned)))
                })
            })
            .await?)
    }

    pub fn durable_store(&self) -> &Store {
        &self.0.durable
    }

    pub(crate) async fn submit_words_async(&self, issue: &str, request: &str, words: &str) -> Result<Submission> {
        let conv = delivery_conversation(issue);
        Ok(self
            .0
            .durable
            .write_with_async((conv.as_str(), request, words), |tx, &(conv, request, words)| {
                Box::pin(async move {
                    match tx.conversation_async(conv).await {
                        Err(Error::Missing(_)) => {
                            tx.create_conversation_async(conv, "").await?;
                        }
                        Ok(_) => (),
                        Err(e) => return Err(e),
                    }
                    let (s, _) = tx.submit_async(conv, request, "issue.message", &json!({"text": words}), None).await?;
                    Ok(s)
                })
            })
            .await?)
    }

    pub(crate) async fn queued_words_async(&self, issue: &str) -> Result<Vec<Submission>> {
        let conv = delivery_conversation(issue);
        Ok(self
            .0
            .durable
            .read_with_async(conv.as_str(), |tx, &conv| {
                Box::pin(async move {
                    Ok(tx
                        .submissions_async(conv)
                        .await?
                        .into_iter()
                        .filter(|s| s.status == SubmissionStatus::Queued)
                        .collect())
                })
            })
            .await?)
    }

    /// Reserve input against a running external process before writing to its protocol stream.
    /// An unknown outcome is reconciled from this run on recovery.
    pub(crate) async fn bind_to_active_run_async(&self, session: &str, submission: &Submission) -> Result<bool> {
        let Some(id) = self.0.extras.lock().get(session).and_then(|e| e.run.clone()) else {
            return Ok(false);
        };
        Ok(self
            .0
            .durable
            .write_with_async((id.as_str(), submission), |tx, &(id, submission)| {
                Box::pin(async move {
                    let Some(mut run) = db::run(tx.transaction(), id).await? else {
                        return Ok(false);
                    };
                    if run.outcome.is_some() {
                        return Ok(false);
                    }
                    bind(tx, &mut run, submission).await?;
                    db::put_run(tx.transaction(), &run).await?;
                    Ok(true)
                })
            })
            .await?)
    }

    pub(crate) async fn settle_words_async(&self, id: &str, ok: bool, payload: &Value) -> Result<()> {
        self.0
            .durable
            .write_with_async((id, ok, payload), |tx, &(id, ok, payload)| {
                Box::pin(async move {
                    let status = if ok { SubmissionStatus::Done } else { SubmissionStatus::Unanswered };
                    tx.settle_async(id, status, payload).await
                })
            })
            .await?;
        Ok(())
    }
}

pub(super) async fn bind(tx: &mut Tx<'_>, run: &mut Run, sub: &Submission) -> DurableResult<()> {
    if !run.heard.contains(&sub.request_id) {
        run.heard.push(sub.request_id.clone());
    }
    tx.set_submission_status_async(&sub.id, SubmissionStatus::Placed).await?;
    Ok(())
}

pub(super) async fn settle_run(tx: &mut Tx<'_>, run: &Run) -> DurableResult<()> {
    let Some(issue) = &run.issue else { return Ok(()) };
    let status = if run.outcome == Some(Outcome::Completed) {
        SubmissionStatus::Done
    } else {
        SubmissionStatus::Unanswered
    };
    let payload = json!({"issueId":issue,"sessionId":run.session,"runId":run.id,"outcome":run.outcome,"summary":run.summary,"spent":run.spent});
    let conv = delivery_conversation(issue);
    for key in &run.heard {
        if let Some(sub) = tx.submission_by_request_async(&conv, key).await? {
            tx.settle_async(&sub.id, status, &payload).await?;
        }
    }
    if run.outcome != Some(Outcome::Interrupted) && run.triggered_by.kind != RunTriggerKind::Refine {
        tx.put_document_async("run", &run.id, "issue.report", &payload).await?;
    }
    Ok(())
}

pub(crate) async fn interrupt_on_reopen(
    tx: &mut Tx<'_>,
    session: &Session,
    extra: Option<&Extra>,
    at: Millis,
    summary: &str,
) -> DurableResult<Option<(String, bool)>> {
    let Some(mut extra) = extra.cloned() else { return Ok(None) };
    let Some(id) = extra.run.take() else { return Ok(None) };
    let mut needs_reconciliation = false;
    if let Some(mut run) = db::run(tx.transaction(), &id).await? {
        if run.outcome.is_none() {
            run.ended_at = Some(at);
            run.outcome = Some(Outcome::Interrupted);
            run.summary = summary.into();
            if !session.is_refining() && session.runtime != vibevalley_runtime::agent::runtime::ID && run.issue.is_some() {
                tx.put_document_async(
                    "run",
                    &id,
                    "workspace.reconciliation",
                    &json!({"worktree":session.cwd,"branch":session.worktree_branch()}),
                )
                .await?;
                run.needs_reconciliation = true;
            }
            db::put_run(tx.transaction(), &run).await?;
            settle_run(tx, &run).await?;
        }
        needs_reconciliation = run.needs_reconciliation;
    }
    db::put_extra(tx.transaction(), &session.id, &extra).await?;
    Ok(Some((id, needs_reconciliation)))
}
