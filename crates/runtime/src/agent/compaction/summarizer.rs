use std::sync::Arc;

use crate::agent::ai::ModelClient;
use crate::agent::ai::types::{ChatRequest, Message};
use crate::agent::compaction::Level;
use crate::agent::compaction::file_ops::{FileOps, render_file_ops};
use crate::agent::durable::{self, Entry, Error};

const SUMMARIZE_SYSTEM: &str = "\
You summarize an agent conversation for lossless continuation.
Produce a concise, factual Markdown summary with exactly these sections:
## Goal
## Decisions
## Progress
## Remaining
## User Constraints
Keep file paths, symbol names, command outcomes, and unresolved items exact. Do not invent facts.";

pub trait Summarizer: Send + Sync {
    fn summarize(&self, level: Level, entries: &[Entry], file_ops: &FileOps) -> durable::Result<String>;
}

pub struct LlmSummarizer {
    pub client: Arc<dyn ModelClient>,
    pub model: String,
}

impl Summarizer for LlmSummarizer {
    fn summarize(&self, level: Level, entries: &[Entry], file_ops: &FileOps) -> durable::Result<String> {
        let mut transcript = format!("Compaction level: {}\n\n", level.name());
        for entry in entries {
            transcript.push_str(&format!("[#{}] {}: {}\n", entry.seq, entry.kind, entry.payload));
        }
        let response = self
            .client
            .complete(
                &ChatRequest {
                    model: self.model.clone(),
                    messages: vec![Message::system(SUMMARIZE_SYSTEM), Message::user(transcript)],
                    ..Default::default()
                },
                &mut |_| {},
            )
            .map_err(|e| Error::Invalid(format!("compaction summarization failed: {e}")))?;
        let mut summary = response.message.content.unwrap_or_default().trim().to_string();
        let ops_block = render_file_ops(file_ops);
        if !ops_block.is_empty() {
            if !summary.is_empty() {
                summary.push_str("\n\n");
            }
            summary.push_str(&ops_block);
        }
        Ok(summary)
    }
}

/// Deterministic offline placeholder summarizer for unit tests without a `ModelClient`.
pub struct DeterministicSummarizer;

impl Summarizer for DeterministicSummarizer {
    fn summarize(&self, level: Level, entries: &[Entry], file_ops: &FileOps) -> durable::Result<String> {
        let first = entries.first().map_or(0, |e| e.seq);
        let last = entries.last().map_or(0, |e| e.seq);
        let mut text = format!("[compaction:{} seq={}..{}]", level.name(), first, last);
        for e in entries {
            text.push_str(&format!("\n{}:{}={}", e.seq, e.kind, e.payload));
        }
        let ops_block = render_file_ops(file_ops);
        if !ops_block.is_empty() {
            text.push_str("\n\n");
            text.push_str(&ops_block);
        }
        Ok(text)
    }
}
