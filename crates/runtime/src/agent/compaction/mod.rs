//! Layer 2 context compaction: file-operation extraction, LLM summarization,
//! CJK-aware token estimation, and optimistic SQLite checkpoint commits.

pub mod file_ops;
pub mod summarizer;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;

use serde_json::json;
use tokio::sync::Notify;

use crate::agent::durable::{self, Entry, Store};

pub use file_ops::{FileOps, extract_file_ops, render_file_ops};
pub use summarizer::{DeterministicSummarizer, LlmSummarizer, Summarizer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Manual,
    Soft,
    Hard,
    Overflow,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Soft => "soft",
            Self::Hard => "hard",
            Self::Overflow => "overflow",
        }
    }
}

/// Estimates token count for a single UTF-8 string (~4 ASCII bytes/tok, ~1.5 non-ASCII chars/tok).
pub fn estimate_str_tokens(text: &str) -> usize {
    let mut ascii_bytes = 0usize;
    let mut non_ascii_chars = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii_bytes += 1;
        } else {
            non_ascii_chars += 1;
        }
    }
    ascii_bytes.div_ceil(4) + (non_ascii_chars * 2).div_ceil(3)
}

/// CJK-aware token count estimation over durable entries.
pub fn estimate_tokens(entries: &[Entry]) -> usize {
    entries.iter().map(|entry| 16 + estimate_str_tokens(&entry.payload.to_string())).sum()
}

#[derive(Clone)]
pub struct Compactor {
    store: Store,
    summarizer: Arc<dyn Summarizer>,
    active: Arc<(Mutex<HashSet<String>>, Notify)>,
    pub soft_tokens: usize,
    pub hard_tokens: usize,
    pub keep_recent: usize,
}

impl Compactor {
    pub fn new(store: Store, summarizer: Arc<dyn Summarizer>) -> Self {
        Self {
            store,
            summarizer,
            active: Arc::new((Mutex::new(HashSet::new()), Notify::new())),
            soft_tokens: 88_000,
            hard_tokens: 120_000,
            keep_recent: 4,
        }
    }

    pub fn deterministic(store: Store) -> Self {
        Self::new(store, Arc::new(DeterministicSummarizer))
    }

    pub fn with_llm(store: Store, client: Arc<dyn crate::agent::ai::ModelClient>, model: impl Into<String>) -> Self {
        Self::new(store, Arc::new(LlmSummarizer { client, model: model.into() }))
    }

    pub fn with_summarizer(mut self, summary: Arc<dyn Summarizer>) -> Self {
        self.summarizer = summary;
        self
    }

    pub async fn compact(&self, conv: &str, level: Level, explicit: Option<i64>) -> durable::Result<Option<Entry>> {
        let conv_read = conv.to_owned();
        let (current, entries) = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok((tx.conversation_async(&conv_read).await?, tx.visible_entries_async(&conv_read).await?)) }))
            .await?;
        let keep = if level == Level::Overflow {
            self.keep_recent.min(1)
        } else {
            self.keep_recent
        };
        let cut = match explicit {
            Some(seq) => seq,
            None if entries.len() > keep => {
                let target = &entries[entries.len() - keep - 1];
                if target.kind == "pi.compaction" {
                    return Ok(None);
                }
                target.seq
            }
            None => return Ok(None),
        };
        let selected: Vec<Entry> = entries.into_iter().filter(|e| e.kind == "pi.compaction" || e.seq <= cut).collect();
        if selected.is_empty() {
            return Ok(None);
        }
        let from = selected.iter().map(|e| e.seq).min().unwrap_or(cut);
        let ops = extract_file_ops(&selected);
        let summary = self.summarizer.summarize(level, &selected, &ops).await?;
        let token_count = estimate_str_tokens(&summary) as i64;
        let conv_write = conv.to_owned();
        let base_head = current.head_seq;
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    let committed = tx
                        .compact_async(
                            &conv_write,
                            durable::Compaction {
                                level: level.name(),
                                base_head,
                                from,
                                cut,
                                summary: &summary,
                                token_count,
                            },
                        )
                        .await?;
                    if committed.is_some() {
                        tx.put_document_async("conversation", &conv_write, "pi.file_ops", &json!(ops)).await?;
                    }
                    Ok(committed)
                })
            })
            .await
    }

    pub async fn before_request(&self, conv: &str) -> durable::Result<()> {
        let conv_read = conv.to_owned();
        let tokens = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok(estimate_tokens(&tx.visible_entries_async(&conv_read).await?)) }))
            .await?;
        if tokens >= self.hard_tokens {
            self.compact(conv, Level::Hard, None).await?;
        } else if tokens >= self.soft_tokens && self.active.0.lock().insert(conv.to_owned()) {
            let compactor = self.clone();
            let conv = conv.to_owned();
            crate::rt::current_or_global_handle().spawn(async move {
                let _ = compactor.compact(&conv, Level::Soft, None).await;
                compactor.active.0.lock().remove(&conv);
                compactor.active.1.notify_waiters();
            });
        }
        Ok(())
    }

    pub async fn wait(&self) {
        loop {
            let notified = self.active.1.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.0.lock().is_empty() {
                return;
            }
            notified.await;
        }
    }
}
