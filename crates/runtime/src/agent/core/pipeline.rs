use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::ai::types::{Message, Role, ToolCall, ToolSpec};
use crate::agent::core::events::AgentMessage;
use crate::agent::core::extension::{DurableHookCtx, ExtensionRunner};
use crate::agent::durable::{Entry, Result, Store};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptSection {
    pub key: String,
    pub content: String,
}

impl PromptSection {
    pub fn new(key: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            content: content.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Transcript {
    pub conversation_id: String,
    pub provider_affinity: String,
    pub entries: Vec<Entry>,
    pub prefix_hash: String,
}

impl Transcript {
    pub async fn load(store: &Store, conv: &str) -> Result<Self> {
        let conv_owned = conv.to_owned();
        let (conversation, entries) = store
            .read_async(move |tx| Box::pin(async move { Ok((tx.conversation_async(&conv_owned).await?, tx.visible_entries_async(&conv_owned).await?)) }))
            .await?;
        Ok(Self {
            conversation_id: conv.into(),
            provider_affinity: conversation.provider_affinity,
            entries,
            prefix_hash: String::new(),
        })
    }

    pub fn agent_messages(&self) -> Vec<AgentMessage> {
        self.entries
            .iter()
            .filter_map(|e| {
                let p = &e.payload;
                let text = || p.as_str().or_else(|| p["text"].as_str()).unwrap_or_default().to_owned();
                let mut msg = match e.kind.as_str() {
                    "pi.system" => {
                        let is_delta = p["delta"].as_bool().unwrap_or(false);
                        let mut m = AgentMessage::new("pi.system", Message::system(text()));
                        m.is_delta_system = is_delta;
                        m
                    }
                    "pi.user" => AgentMessage::new("pi.user", Message::user(text())),
                    "pi.compaction" => AgentMessage::new(
                        "pi.compaction",
                        Message::user(format!(
                            "Summary of the conversation before this point:\n\n{}",
                            p["summary"].as_str().unwrap_or_default()
                        )),
                    ),
                    "pi.assistant" => {
                        let tool_calls: Vec<ToolCall> = p["toolCalls"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| {
                                let args = c
                                    .get("rawArguments")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| c["argsJson"].to_string());
                                Some(ToolCall {
                                    id: c["id"].as_str()?.into(),
                                    name: c["toolName"].as_str()?.into(),
                                    arguments: args,
                                })
                            })
                            .collect();
                        let content = p["text"].as_str().map(str::to_owned).filter(|s| tool_calls.is_empty() || !s.is_empty());
                        let mut m = AgentMessage::new(
                            "pi.assistant",
                            Message {
                                role: Role::Assistant,
                                content,
                                reasoning: p["reasoning"].as_str().map(str::to_owned),
                                tool_calls,
                                tool_call_id: None,
                            },
                        );
                        m.generation_task = p["generationTask"].as_str().map(str::to_owned);
                        m
                    }
                    "pi.tool_result" => {
                        let call_id = p["toolCallId"].as_str()?;
                        let body = if p["ok"] == false {
                            format!("ERROR: {}", p["error"].as_str().unwrap_or_default())
                        } else {
                            p["output"].as_str().map(str::to_owned).unwrap_or_else(|| p["output"].to_string())
                        };
                        AgentMessage::new("pi.tool_result", Message::tool(call_id, body))
                    }
                    _ => return None,
                };
                msg.seq = Some(e.seq);
                Some(msg)
            })
            .collect()
    }

    pub fn messages(&self) -> Vec<Message> {
        convert_to_llm(self.agent_messages())
    }
}

pub async fn system_delta(store: &Store, conversation: &str, text: &str, tools: &[ToolSpec]) -> Result<Entry> {
    let conversation = conversation.to_owned();
    let payload = json!({"text": text, "delta": true, "tools": tools});
    store
        .write_async(move |tx| Box::pin(async move { tx.append_entry_async(&conversation, "pi.system", &payload).await }))
        .await
}

pub fn model_payload(message: &Message) -> Value {
    let calls: Vec<_> = message
        .tool_calls
        .iter()
        .map(|call| {
            let args = serde_json::from_str(&call.arguments).unwrap_or_else(|_| Value::String(call.arguments.clone()));
            json!({
                "id": call.id,
                "toolName": call.name,
                "argsJson": args,
                "rawArguments": call.arguments,
            })
        })
        .collect();
    json!({
        "text": message.content,
        "reasoning": message.reasoning,
        "toolCalls": calls,
    })
}

pub async fn transform_context(mut messages: Vec<AgentMessage>, extensions: &ExtensionRunner, ctx: &DurableHookCtx<'_>) -> Result<Vec<AgentMessage>> {
    extensions.run_context(ctx, &mut messages).await?;
    Ok(messages)
}

/// Converts transcript messages to DeepSeek/OpenAI wire messages:
/// preserves chronological position of `pi.system` deltas (protecting prefix cache),
/// preserves `reasoning` (`reasoning_content`) on assistant tool calls,
/// sets `content: None` when assistant has `tool_calls` and empty text,
/// and enforces strict `tool_call_id` pairing before any subsequent non-tool message.
pub fn convert_to_llm(messages: Vec<AgentMessage>) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    let mut pending_call_ids: Vec<String> = Vec::new();
    let mut tail_deltas: Vec<Message> = Vec::new();

    let flush_missing_tools = |pending: &mut Vec<String>, out: &mut Vec<Message>| {
        for missing_id in pending.drain(..) {
            out.push(Message::tool(missing_id, "ERROR: missing tool result"));
        }
    };

    for entry in messages {
        let mut msg = entry.message;
        match msg.role {
            Role::System => {
                if !pending_call_ids.is_empty() {
                    // Defer system deltas until the open tool_call sequence finishes.
                    tail_deltas.push(msg);
                    continue;
                }
                // Preserve exact chronological placement for base prompts and appended deltas.
                out.push(msg);
            }
            Role::Assistant => {
                flush_missing_tools(&mut pending_call_ids, &mut out);
                for delta in tail_deltas.drain(..) {
                    out.push(delta);
                }
                if !msg.tool_calls.is_empty() {
                    if msg.content.as_deref().is_some_and(str::is_empty) {
                        msg.content = None;
                    }
                    pending_call_ids.extend(msg.tool_calls.iter().map(|c| c.id.clone()));
                }
                out.push(msg);
            }
            Role::Tool => {
                let Some(call_id) = msg.tool_call_id.as_deref() else {
                    continue;
                };
                if let Some(pos) = pending_call_ids.iter().position(|id| id == call_id) {
                    pending_call_ids.remove(pos);
                    out.push(msg);
                    if pending_call_ids.is_empty() {
                        for delta in tail_deltas.drain(..) {
                            out.push(delta);
                        }
                    }
                }
            }
            Role::User => {
                flush_missing_tools(&mut pending_call_ids, &mut out);
                for delta in tail_deltas.drain(..) {
                    out.push(delta);
                }
                out.push(msg);
            }
        }
    }

    flush_missing_tools(&mut pending_call_ids, &mut out);
    for delta in tail_deltas.drain(..) {
        out.push(delta);
    }
    out
}
