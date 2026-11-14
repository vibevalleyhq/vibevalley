//! The runs of each issue (`Run` in VibeValley's `session/shapes.ts`): one
//! per round a session works, with what set it off and how it ended. The
//! timeline and `issue.run.list` read them.

use vibevalley_protocol::{Millis, Outcome, Run, RunTrigger, RunTriggerKind, Spent};

use super::sessions::Sessions;
use crate::modules::ledger::{Result, Step, now};

const RUN: &str = "issue-run";

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
    pub(super) fn begin_run(&self, session: &str, issue: &str, trigger: RunTrigger) -> Result<()> {
        // A round still open (the agent never said it ended) ends here.
        self.end_run(session, Outcome::Interrupted, "", None)?;
        let id = format!("r{}", self.0.ledger.next("run", 0)?);
        let run = Run {
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
        self.0.ledger.store().put_doc(RUN, &id, &serde_json::to_value(&run).unwrap_or_default())?;
        self.set_extra(session, |e| e.run = Some(id.clone()))?;
        self.0.ledger.log(session, Step::RunStarted { run: id });
        Ok(())
    }

    /// The open round of `session`, if any, ends with `outcome`.
    pub fn end_run(&self, session: &str, outcome: Outcome, summary: &str, spent: Option<Spent>) -> Result<()> {
        let Some(id) = self.extra(session).run else { return Ok(()) };
        if let Some(mut run) = self.0.ledger.store().doc(RUN, &id)?.and_then(|v| serde_json::from_value::<Run>(v).ok()) {
            run.ended_at = Some(now());
            run.outcome = Some(outcome);
            run.summary = summary.to_string();
            run.spent = spent;
            self.0.ledger.store().put_doc(RUN, &id, &serde_json::to_value(&run).unwrap_or_default())?;
        }
        self.set_extra(session, |e| e.run = None)?;
        self.0.ledger.log(session, Step::RunEnded { run: id, outcome });
        Ok(())
    }

    /// The issue's runs, oldest first.
    pub fn runs(&self, issue: &str) -> Result<Vec<Run>> {
        let mut runs: Vec<Run> = self
            .0
            .ledger
            .store()
            .docs(RUN)?
            .into_iter()
            .filter_map(|(_, v)| serde_json::from_value::<Run>(v).ok())
            .filter(|r| r.issue.as_deref() == Some(issue))
            .collect();
        runs.sort_by_key(|r| (r.started_at, run_number(&r.id)));
        Ok(runs)
    }
}

fn run_number(id: &str) -> Millis {
    id.trim_start_matches('r').parse().unwrap_or(0)
}
