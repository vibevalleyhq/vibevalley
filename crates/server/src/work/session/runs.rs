//! The runs of each issue (`Run` in VibeValley's `session/shapes.ts`): one
//! per round a session works, with what set it off and how it ended. The
//! timeline and `issue.run.list` read them.

use vibevalley_protocol::{Outcome, Run, RunTrigger, RunTriggerKind, Spent};

use super::sessions::Sessions;
use crate::work::ledger::{Result, Step, now};

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

impl Sessions {
    /// A round of `session` on `issue` starts now.
    pub(super) async fn begin_run_async(&self, session: &str, issue: &str, trigger: RunTrigger) -> Result<String> {
        // A round still open (the agent never said it ended) ends here.
        self.end_run_async(session, Outcome::Interrupted, "", None).await?;
        let id = format!("r{}", self.0.ledger.next_async("run", 0).await?);
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
        let saved_extra = self
            .0
            .durable
            .write_with_async((session, issue, run, extra), |tx, ctx| {
                let (session, issue, mut run, extra) = (ctx.0, ctx.1, ctx.2.clone(), ctx.3.clone());
                Box::pin(async move {
                    if run.triggered_by.kind != RunTriggerKind::Refine {
                        for sub in tx
                            .submissions_async(&super::delivery::delivery_conversation(issue))
                            .await?
                            .into_iter()
                            .filter(|s| s.status == vibevalley_runtime::agent::durable::SubmissionStatus::Queued)
                        {
                            super::delivery::bind(tx, &mut run, &sub).await?;
                        }
                    }
                    super::db::put_run(tx.transaction(), &run).await?;
                    super::db::put_extra(tx.transaction(), session, &extra).await?;
                    Ok(extra)
                })
            })
            .await?;
        self.0.extras.lock().insert(session.into(), saved_extra);
        self.record(session, Step::RunStarted { run: id.clone() });
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
        let saved_extra = self
            .0
            .durable
            .write_with_async((session, id.as_str(), outcome, summary, spent, extra), |tx, ctx| {
                let (session, id, outcome, summary, spent, extra) = (ctx.0, ctx.1, ctx.2, ctx.3, ctx.4.clone(), ctx.5.clone());
                Box::pin(async move {
                    if let Some(mut run) = super::db::run(tx.transaction(), id).await? {
                        run.ended_at = Some(now());
                        run.outcome = Some(outcome);
                        run.summary = summary.into();
                        run.spent = spent;
                        super::db::put_run(tx.transaction(), &run).await?;
                        super::delivery::settle_run(tx, &run).await?;
                    }
                    super::db::put_extra(tx.transaction(), session, &extra).await?;
                    Ok(extra)
                })
            })
            .await?;
        {
            let mut extras = self.0.extras.lock();
            let current = extras.entry(session.into()).or_default();
            if current.run.as_deref() == Some(&id) {
                current.run = saved_extra.run;
            }
        }
        self.record(session, Step::RunEnded { run: id, outcome });
        Ok(())
    }

    /// The issue's runs, oldest first.
    pub async fn runs_async(&self, issue: &str) -> Result<Vec<Run>> {
        self.0.ledger.read_db_async(async |db| super::db::runs(db, issue).await).await
    }
}
