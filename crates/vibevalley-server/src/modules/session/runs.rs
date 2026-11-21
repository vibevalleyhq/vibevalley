//! The runs of each issue (`Run` in VibeValley's `session/shapes.ts`): one
//! per round a session works, with what set it off and how it ended. The
//! timeline and `issue.run.list` read them.

use vibevalley_protocol::{Outcome, Run, RunTrigger, RunTriggerKind, Spent};

use super::sessions::Sessions;
use crate::modules::ledger::{Result, Step, now};

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
    pub(super) fn begin_run(&self, session: &str, issue: &str, trigger: RunTrigger) -> Result<String> {
        // A round still open (the agent never said it ended) ends here.
        self.end_run(session, Outcome::Interrupted, "", None)?;
        let id = format!("r{}", self.0.ledger.next("run", 0)?);
        let mut run = Run {
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
        {
            let mut extras = self.0.extras.lock().unwrap_or_else(|e| e.into_inner());
            let mut extra = extras.get(session).cloned().unwrap_or_default();
            extra.run = Some(id.clone());
            self.0.durable.write(|tx| {
                if run.triggered_by.kind != RunTriggerKind::Refine {
                    for sub in tx
                        .submissions(&super::delivery::delivery_conversation(issue))?
                        .into_iter()
                        .filter(|s| s.status == vibevalley_agent::durable::SubmissionStatus::Queued)
                    {
                        super::delivery::bind(tx, &mut run, &sub)?;
                    }
                }
                super::db::put_run(tx.connection(), &run)?;
                super::db::put_extra(tx.connection(), session, &extra)?;
                Ok(())
            })?;
            extras.insert(session.into(), extra);
        }
        self.record(session, Step::RunStarted { run: id.clone() });
        Ok(id)
    }

    /// The open round of `session`, if any, ends with `outcome`.
    pub fn end_run(&self, session: &str, outcome: Outcome, summary: &str, spent: Option<Spent>) -> Result<()> {
        let mut extras = self.0.extras.lock().unwrap_or_else(|e| e.into_inner());
        let mut extra = extras.get(session).cloned().unwrap_or_default();
        let Some(id) = extra.run.take() else { return Ok(()) };
        self.0.durable.write(|tx| {
            if let Some(mut run) = super::db::run(tx.connection(), &id)? {
                run.ended_at = Some(now());
                run.outcome = Some(outcome);
                run.summary = summary.into();
                run.spent = spent;
                super::db::put_run(tx.connection(), &run)?;
                super::delivery::settle_run(tx, &run)?;
            }
            super::db::put_extra(tx.connection(), session, &extra)?;
            Ok(())
        })?;
        extras.insert(session.into(), extra);
        drop(extras);
        self.record(session, Step::RunEnded { run: id, outcome });
        Ok(())
    }

    /// The issue's runs, oldest first.
    pub fn runs(&self, issue: &str) -> Result<Vec<Run>> {
        self.0.ledger.database(|db| super::db::runs(db, issue))
    }
}
