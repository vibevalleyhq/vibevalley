use std::sync::Arc;

use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, OrchestratorEval, SessionEventType};
use vibevalley_runtime::agent::Message;

use super::execution;
use super::state::Orchestrator;
use crate::agent::memory::By;
use crate::context::error::{LookIn, missing, refused};

/// One turn the user marked wrong (`<home>/evals/<id>.json`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalCase {
    id: String,
    created_at: i64,
    model: String,
    want: String,
    memory: String,
    tools: Vec<String>,
    before: Vec<Message>,
    input: String,
    did: Vec<Message>,
    expect: Vec<String>,
}

/// What the model had in front of it before a turn: the last summary, then every message since.
fn told_before(entries: &[execution::EvalEntry]) -> Vec<Message> {
    let from = entries.iter().rposition(|e| matches!(e, execution::EvalEntry::Compacted { .. })).unwrap_or(0);
    entries[from..]
        .iter()
        .map(|e| match e {
            execution::EvalEntry::Compacted { summary } => Message::system(summary.clone()),
            execution::EvalEntry::Message(message) => message.clone(),
            execution::EvalEntry::TurnStarted { input } => Message::user(input.clone()),
        })
        .collect()
}

/// A turn's own messages, up to where the next turn starts.
fn message_of_turn(entry: &execution::EvalEntry) -> Option<Option<Message>> {
    match entry {
        execution::EvalEntry::TurnStarted { .. } => None,
        execution::EvalEntry::Message(message) => Some(Some(message.clone())),
        execution::EvalEntry::Compacted { .. } => Some(None),
    }
}

impl Orchestrator {
    /// Keeps the turn that answered step `on` of its log as a case to replay: what it had been told before, what it was
    /// asked, what it did, and what the user says it should have done.
    pub async fn mark_wrong_async(self: &Arc<Self>, agent: Option<&str>, on: i64, want: &str) -> Result<OrchestratorEval, ApiError> {
        let want = want.trim().to_string();
        if want.is_empty() {
            return Err(refused(BizCode::Refused, t("server.session.host.markNeedsWords", &[])));
        }
        let id = self.target(agent);
        let label = self.profile.agent(&id).map(|a| a.name).unwrap_or_else(|| id.clone());
        let log = self.runtime.trajectory().events_async(&id, None).await.unwrap_or_default();
        let Some(asked) = log.iter().find(|e| e.seq == on) else {
            return Err(missing(
                t("server.session.host.noStep", &[("label", label.into()), ("on", on.into())]),
                LookIn::Session,
            ));
        };
        if asked.r#type != SessionEventType::UserMessage {
            return Err(refused(
                BizCode::Refused,
                t("server.session.host.notAsked", &[("on", on.into()), ("label", label.into())]),
            ));
        }
        // The same words asked twice are two turns: the one meant is as far along among them as its step is in the log.
        let nth = log
            .iter()
            .filter(|e| e.seq < on && e.r#type == SessionEventType::UserMessage && e.text == asked.text)
            .count();
        let entries = self.execution.entries_async(&id).await.map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        let turns = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| matches!(e, execution::EvalEntry::TurnStarted { input } if input.contains(&asked.text)));
        let Some((at, execution::EvalEntry::TurnStarted { input })) = turns.clone().nth(nth).or_else(|| turns.clone().next_back()) else {
            return Err(refused(
                BizCode::Refused,
                t("server.session.host.notInConversation", &[("on", on.into()), ("label", label.into())]),
            ));
        };
        let model = self.model_of(&id).map_err(|e| refused(BizCode::Refused, e))?;
        let route = self.route_of(&id);
        let memory = self.memory.port_async(&id, By::Orchestrator).await;
        let case = EvalCase {
            id: uuid::Uuid::now_v7().to_string(),
            created_at: self.ctx.now(),
            model,
            want,
            memory: memory.prompt(),
            tools: self
                .tools_for_async(&id, &route, self.home.join("agent").join(&id).join("skills"), memory)
                .await
                .iter()
                .map(|tool| tool.spec().name)
                .collect(),
            before: told_before(&entries[..at]),
            input: input.clone(),
            did: entries[at + 1..].iter().map_while(message_of_turn).flatten().collect(),
            expect: vec![],
        };
        let dir = self.home.join("evals");
        let file = dir.join(format!("{}.json", case.id));
        let case_id = case.id.clone();
        tokio::fs::create_dir_all(&dir).await.map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        let mut out = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .await
            .map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        use tokio::io::AsyncWriteExt;
        out.write_all(format!("{}\n", serde_json::to_string_pretty(&case).unwrap_or_default()).as_bytes())
            .await
            .map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        Ok(OrchestratorEval {
            id: case_id,
            file: file.to_string_lossy().into_owned(),
        })
    }
}
