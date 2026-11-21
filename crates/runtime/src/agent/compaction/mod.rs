//! Layer 2 context compaction: file-operation extraction, LLM summarization,
//! CJK-aware token estimation, and optimistic SQLite checkpoint commits.

pub mod file_ops;
pub mod summarizer;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::json;

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
    active: Arc<(Mutex<HashSet<String>>, Condvar)>,
    pub soft_tokens: usize,
    pub hard_tokens: usize,
    pub keep_recent: usize,
}

impl Compactor {
    pub fn new(store: Store, summarizer: Arc<dyn Summarizer>) -> Self {
        Self {
            store,
            summarizer,
            active: Default::default(),
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

    pub fn compact(&self, conv: &str, level: Level, explicit: Option<i64>) -> durable::Result<Option<Entry>> {
        let (current, entries) = self.store.read(|tx| Ok((tx.conversation(conv)?, tx.visible_entries(conv)?)))?;
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
        let summary = self.summarizer.summarize(level, &selected, &ops)?;
        let token_count = estimate_str_tokens(&summary) as i64;
        self.store.write(|tx| {
            let committed = tx.compact(
                conv,
                durable::Compaction {
                    level: level.name(),
                    base_head: current.head_seq,
                    from,
                    cut,
                    summary: &summary,
                    token_count,
                },
            )?;
            if committed.is_some() {
                tx.put_document("conversation", conv, "pi.file_ops", &json!(ops))?;
            }
            Ok(committed)
        })
    }

    pub fn before_request(&self, conv: &str) -> durable::Result<()> {
        let tokens = self.store.read(|tx| Ok(estimate_tokens(&tx.visible_entries(conv)?)))?;
        if tokens >= self.hard_tokens {
            self.compact(conv, Level::Hard, None)?;
        } else if tokens >= self.soft_tokens && self.active.0.lock().unwrap().insert(conv.to_owned()) {
            let compactor = self.clone();
            let conv = conv.to_owned();
            std::thread::spawn(move || {
                let _ = compactor.compact(&conv, Level::Soft, None);
                compactor.active.0.lock().unwrap().remove(&conv);
                compactor.active.1.notify_all();
            });
        }
        Ok(())
    }

    pub fn wait(&self) {
        drop(self.active.1.wait_while(self.active.0.lock().unwrap(), |active| !active.is_empty()).unwrap());
    }
}
