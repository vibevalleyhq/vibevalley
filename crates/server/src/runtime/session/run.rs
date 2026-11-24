//! The runs of each issue (`Run` in VibeValley's `session/shapes.ts`): one
//! per round a session works, with what set it off and how it ended. The
//! timeline and `issue.run.list` read them.

use vibevalley_protocol::{Outcome, Run, RunTrigger, RunTriggerKind, Spent};

use super::engine::SessionEngine;
use crate::context::now;
use crate::db::DbError;
use crate::runtime::{Result, Step};

pub fn trigger_of(kind: RunTriggerKind, message: Option<String>) -> RunTrigger {
    let message = message.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    RunTrigger {
        kind,
        message,
        channel: None,
        cron: None,
        missed: None,
    }
}

impl SessionEngine {
    /// A round of `session` on `issue` starts now.
    pub(super) async fn begin_run_async(&self, session: &str, issue: &str, trigger: RunTrigger) -> Result<String> {
        // A round still open (the agent never said it ended) ends here.
        self.end_run_async(session, Outcome::Interrupted, "", None).await?;
        let next_num = {
            let _write = self.0.write_lock.lock().await;
            self.0.ctx.service.next_seq("run", 0).await?
        };
        let id = format!("r{next_num}");
        let run = Run {
            needs_reconciliation: false,
            subagents: None,
            id: id.clone(),
            session: session.into(),
            issue: Some(issue.into()),
            triggered_by: trigger,
            heard: vec![],
            started_at: now(),
            ended_at: None,
            outcome: None,
            summary: String::new(),
            spent: None,
        };
        let mut extra = self.extra(session);
        extra.run = Some(id.clone());
        let session_svc = self.0.ctx.service.session.clone();
        let saved_extra = self
            .0
            .durable
            .write_with_async((session_svc, session.to_string(), issue.to_string(), run, extra), |tx, ctx| {
                let (session_svc, session, issue, mut run, extra) = (ctx.0.clone(), ctx.1.clone(), ctx.2.clone(), ctx.3.clone(), ctx.4.clone());
                Box::pin(async move {
                    if run.triggered_by.kind != RunTriggerKind::Refine {
                        for sub in tx
                            .submissions_async(&super::delivery::delivery_conversation(&issue))
                            .await?
                            .into_iter()
                            .filter(|s| s.status == vibevalley_runtime::agent::durable::SubmissionStatus::Queued)
                        {
                            super::delivery::bind(tx, &mut run, &sub).await?;
                        }
                    }
                    session_svc.put_run_in_tx(tx.transaction(), &run).await.map_err(DbError::into_durable_error)?;
                    session_svc
                        .put_extra_in_tx(tx.transaction(), &session, &extra)
                        .await
                        .map_err(DbError::into_durable_error)?;
                    Ok(extra)
                })
            })
            .await?;
        self.0.extras.lock().insert(session.into(), saved_extra);
        self.record_async(session, Step::RunStarted { run: id.clone() }).await;
        Ok(id)
    }

    /// The open round of `session`, if any, ends with `outcome`.
    pub async fn end_run_async(&self, session: &str, outcome: Outcome, summary: &str, spent: Option<Spent>) -> Result<()> {
        let Some((id, extra)) = ({
            let extras = self.0.extras.lock();
            let mut extra = extras.get(session).cloned().unwrap_or_default();
            extra.run.take().map(|id| (id, extra))
        }) else {
            return Ok(());
        };
        let session_svc = self.0.ctx.service.session.clone();
        let saved_extra = self
            .0
            .durable
            .write_with_async(
                (session_svc, session.to_string(), id.clone(), outcome, summary.to_string(), spent, extra),
                |tx, ctx| {
                    let (session_svc, session, id, outcome, summary, spent, extra) =
                        (ctx.0.clone(), ctx.1.clone(), ctx.2.clone(), ctx.3, ctx.4.clone(), ctx.5.clone(), ctx.6.clone());
                    Box::pin(async move {
                        if let Some(mut run) = session_svc.run_in_tx(tx.transaction(), &id).await.map_err(DbError::into_durable_error)? {
                            run.ended_at = Some(now());
                            run.outcome = Some(outcome);
                            run.summary = summary;
                            run.spent = spent;
                            session_svc.put_run_in_tx(tx.transaction(), &run).await.map_err(DbError::into_durable_error)?;
                            super::delivery::settle_run(tx, &run).await?;
                        }
                        session_svc
                            .put_extra_in_tx(tx.transaction(), &session, &extra)
                            .await
                            .map_err(DbError::into_durable_error)?;
                        Ok(extra)
                    })
                },
            )
            .await?;
        {
            let mut extras = self.0.extras.lock();
            let current = extras.entry(session.into()).or_default();
            if current.run.as_deref() == Some(&id) {
                current.run = saved_extra.run;
            }
        }
        self.record_async(session, Step::RunEnded { run: id, outcome }).await;
        Ok(())
    }

    /// The issue's runs, oldest first.
    pub async fn runs_async(&self, issue: &str) -> Result<Vec<Run>> {
        Ok(self.0.ctx.service.session.runs(issue).await?)
    }
}
