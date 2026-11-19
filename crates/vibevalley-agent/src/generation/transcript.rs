use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vibevalley_durable::{Entry, Result, Store};

use crate::{Message, Role, ToolCall};

#[derive(Clone, Debug)]
pub struct Transcript {
    pub conversation_id: String,
    pub provider_affinity: String,
    pub entries: Vec<Entry>,
    pub prefix_hash: String,
}

impl Transcript {
    pub fn load(store: &Store, conv: &str) -> Result<Self> {
        let (conversation, entries) = store.read(|tx| Ok((tx.conversation(conv)?, tx.visible_entries(conv)?)))?;
        let mut hash = Sha256::new();
        for entry in &entries {
            hash.update(format!("{}|{}|{}\n", entry.seq, entry.kind, entry.payload));
        }
        Ok(Self {
            conversation_id: conv.into(),
            provider_affinity: conversation.provider_affinity,
            entries,
            prefix_hash: hash.finalize().iter().map(|b| format!("{b:02x}")).collect(),
        })
    }

    pub fn messages(&self) -> Vec<Message> {
        self.entries
            .iter()
            .filter_map(|e| {
                let p = &e.payload;
                let text = || p.as_str().or_else(|| p["text"].as_str()).unwrap_or_default().to_owned();
                match e.kind.as_str() {
                    "pi.system" => Some(Message::system(text())),
                    "pi.user" => Some(Message::user(text())),
                    "pi.compaction" => Some(Message::user(format!(
                        "Summary of the conversation before this point:\n\n{}",
                        p["summary"].as_str().unwrap_or_default()
                    ))),
                    "pi.assistant" => Some(Message {
                        role: Role::Assistant,
                        content: Some(text()),
                        reasoning: p["reasoning"].as_str().map(str::to_owned),
                        tool_calls: p["toolCalls"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| {
                                Some(ToolCall {
                                    id: c["id"].as_str()?.into(),
                                    name: c["toolName"].as_str()?.into(),
                                    arguments: c["argsJson"].to_string(),
                                })
                            })
                            .collect(),
                        tool_call_id: None,
                    }),
                    "pi.tool_result" => Some(Message::tool(
                        p["toolCallId"].as_str()?,
                        if p["ok"] == false {
                            format!("ERROR: {}", p["error"].as_str().unwrap_or_default())
                        } else {
                            p["output"].as_str().map(str::to_owned).unwrap_or_else(|| p["output"].to_string())
                        },
                    )),
                    _ => None,
                }
            })
            .collect()
    }
}

pub fn system_delta(store: &Store, conversation: &str, text: &str, tools: &[crate::ToolSpec]) -> Result<Entry> {
    store.write(|tx| tx.append_entry(conversation, "pi.system", &json!({"text":text,"delta":true,"tools":tools})))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Manual,
    Soft,
    Hard,
    Overflow,
}
impl Level {
    fn name(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Soft => "soft",
            Self::Hard => "hard",
            Self::Overflow => "overflow",
        }
    }
}

pub trait Summarizer: Send + Sync {
    fn summarize(&self, level: Level, entries: &[Entry]) -> Result<String>;
}

struct Deterministic;
impl Summarizer for Deterministic {
    fn summarize(&self, level: Level, entries: &[Entry]) -> Result<String> {
        let mut text = format!("[compaction:{} seq={}..{}]", level.name(), entries[0].seq, entries.last().unwrap().seq);
        for e in entries {
            text.push_str(&format!("\n{}:{}={}", e.seq, e.kind, e.payload))
        }
        Ok(text)
    }
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
    pub fn new(store: Store) -> Self {
        Self {
            store,
            summarizer: Arc::new(Deterministic),
            active: Default::default(),
            soft_tokens: 88_000,
            hard_tokens: 120_000,
            keep_recent: 4,
        }
    }

    pub fn with_summarizer(mut self, summary: Arc<dyn Summarizer>) -> Self {
        self.summarizer = summary;
        self
    }

    pub fn compact(&self, conv: &str, level: Level, explicit: Option<i64>) -> Result<Option<Entry>> {
        let (current, entries) = self.store.read(|tx| Ok((tx.conversation(conv)?, tx.visible_entries(conv)?)))?;
        let keep = if level == Level::Overflow {
            self.keep_recent.min(1)
        } else {
            self.keep_recent
        };
        let cut = match explicit {
            Some(seq) => seq,
            None if entries.len() > keep => entries[entries.len() - keep - 1].seq,
            None => return Ok(None),
        };
        let selected: Vec<Entry> = entries.into_iter().filter(|e| e.seq <= cut).collect();
        if selected.is_empty() {
            return Ok(None);
        }
        let from = selected[0].seq;
        let summary = self.summarizer.summarize(level, &selected)?;
        self.store.write(|tx| {
            tx.compact(
                conv,
                vibevalley_durable::Compaction {
                    level: level.name(),
                    base_head: current.head_seq,
                    from,
                    cut,
                    summary: &summary,
                    token_count: summary.len().div_ceil(4) as i64,
                },
            )
        })
    }

    pub fn before_request(&self, conv: &str) -> Result<()> {
        let tokens = self.store.read(|tx| {
            Ok(tx
                .visible_entries(conv)?
                .iter()
                .map(|e| 16 + e.payload.to_string().len().div_ceil(4))
                .sum::<usize>())
        })?;
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

pub(crate) fn model_payload(message: &Message) -> Value {
    let calls: Vec<_> = message
        .tool_calls
        .iter()
        .map(|call| {
            let args = serde_json::from_str(&call.arguments).unwrap_or_else(|_| Value::String(call.arguments.clone()));
            json!({"id":call.id,"toolName":call.name,"argsJson":args,"rawArguments":call.arguments})
        })
        .collect();
    json!({"text":message.content,"reasoning":message.reasoning,"toolCalls":calls})
}
