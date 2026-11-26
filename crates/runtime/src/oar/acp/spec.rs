use serde_json::Value;

use super::projector::str_of;
use crate::oar::{AgentError, ModelInfo, PermissionDecision, PermissionMode, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum AcpFlavor {
    #[default]
    Generic,
    Antigravity,
}

impl AcpFlavor {
    pub(crate) fn of(runtime_id: &str) -> Self {
        if matches!(runtime_id, "antigravity" | "acp:antigravity") {
            Self::Antigravity
        } else {
            Self::Generic
        }
    }
}

/// How to start one ACP agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpAgentSpec {
    /// Registry id; built-ins use `acp:<name>`.
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
}

impl AcpAgentSpec {
    pub fn new(id: impl Into<String>, display_name: impl Into<String>, command: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    /// From one command line (`"my-agent --acp"`); quotes group words.
    pub fn from_command_line(id: impl Into<String>, display_name: impl Into<String>, line: &str) -> Result<Self> {
        let mut words = split_command_line(line)?.into_iter();
        let command = words.next().ok_or_else(|| AgentError::Unsupported {
            option: "command".into(),
            reason: "the ACP command line is empty".into(),
        })?;
        Ok(Self {
            id: id.into(),
            display_name: display_name.into(),
            command,
            args: words.collect(),
        })
    }
}

fn split_command_line(line: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') | (None, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                    in_word = true;
                }
            }
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            (None, c) => {
                current.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err(AgentError::Unsupported {
            option: "command".into(),
            reason: "unterminated quote".into(),
        });
    }
    if in_word {
        words.push(current);
    }
    Ok(words)
}

/// The built-in ACP launch profiles.
pub fn builtin_agents() -> Vec<AcpAgentSpec> {
    vec![
        AcpAgentSpec::new("antigravity", "Antigravity CLI", "agy", ["acp"]),
        AcpAgentSpec::new("grok", "Grok CLI", "grok", ["agent", "stdio"]),
        AcpAgentSpec::new("kimi", "Kimi CLI", "kimi", ["acp"]),
        AcpAgentSpec::new("codebuddy", "CodeBuddy CLI", "codebuddy", ["--acp"]),
        AcpAgentSpec::new("opencode", "OpenCode (ACP)", "opencode", ["acp"]),
    ]
}

/// The agent's permission options, reduced to what a decision needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OptionSet {
    options: Vec<(String, String)>,
}

impl OptionSet {
    pub(crate) fn from_json(options: &Value) -> Self {
        Self {
            options: options
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| Some((str_of(o, "kind")?.to_string(), str_of(o, "optionId")?.to_string())))
                .collect(),
        }
    }

    fn of_kind(&self, kind: &str) -> Option<String> {
        self.options.iter().find(|(k, _)| k == kind).map(|(_, id)| id.clone())
    }

    /// The option id for a decision; `Ok(None)` answers "cancelled".
    pub(crate) fn pick(&self, decision: &PermissionDecision) -> Result<Option<String>> {
        match decision {
            PermissionDecision::AllowOnce => {
                self.of_kind("allow_once")
                    .or_else(|| self.of_kind("allow_always"))
                    .map(Some)
                    .ok_or_else(|| AgentError::Unsupported {
                        option: "AllowOnce".into(),
                        reason: "the agent offered no allow option for this request".into(),
                    })
            }
            PermissionDecision::AllowAlways => self.of_kind("allow_always").map(Some).ok_or_else(|| AgentError::Unsupported {
                option: "AllowAlways".into(),
                reason: "the agent offered no allow-always option for this request; answer AllowOnce".into(),
            }),
            PermissionDecision::Deny { .. } => Ok(self.of_kind("reject_once").or_else(|| self.of_kind("reject_always"))),
        }
    }
}

fn normalize(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

/// Mode ids that mean the same as a `PermissionMode`, across generic ACP agents.
pub(crate) fn matching_mode(mode: PermissionMode, available: &[String]) -> Option<&String> {
    let wanted: &[&str] = match mode {
        PermissionMode::Ask => return None,
        PermissionMode::AcceptEdits => &["acceptedits", "autoedit", "autoaccept", "autoacceptedits"],
        PermissionMode::Bypass => &["bypasspermissions", "bypass", "yolo", "fullaccess", "dontask"],
        PermissionMode::Plan => &["plan", "planmode", "readonly"],
    };
    available.iter().find(|id| wanted.contains(&normalize(id).as_str()))
}

pub(super) fn config_option_in<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    options
        .iter()
        .find(|o| str_of(o, "category") == Some(category) || str_of(o, "id") == Some(category))
}

fn config_option<'a>(session: &'a Value, category: &str) -> Option<&'a Value> {
    let options = session.get("configOptions").and_then(Value::as_array)?;
    config_option_in(options, category)
}

pub(super) fn select_values(option: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in option.get("options").and_then(Value::as_array).into_iter().flatten() {
        // Either a flat option or a group of them.
        let nested = entry.get("options").and_then(Value::as_array);
        for item in nested.map(|n| n.iter().collect::<Vec<_>>()).unwrap_or_else(|| vec![entry]) {
            if let Some(value) = str_of(item, "value") {
                out.push((value.to_string(), str_of(item, "name").unwrap_or(value).to_string()));
            }
        }
    }
    out
}

pub(crate) fn extract_effort_config(config_options: &[Value]) -> (Vec<String>, Option<String>) {
    let Some(opt) = config_option_in(config_options, "thought_level").or_else(|| config_option_in(config_options, "reasoning_effort")) else {
        return (Vec::new(), None);
    };
    let levels = select_values(opt).into_iter().map(|(v, _)| v).collect();
    let default_effort = str_of(opt, "currentValue").map(str::to_string);
    (levels, default_effort)
}

pub(crate) fn models_of(session: &Value) -> Vec<ModelInfo> {
    let current = current_model(session);
    let mut models = if let Some(option) = config_option(session, "model") {
        select_values(option)
            .into_iter()
            .map(|(id, display_name)| ModelInfo::new(id, display_name))
            .collect::<Vec<_>>()
    } else {
        session
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = str_of(m, "modelId")?.to_string();
                Some(ModelInfo::new(id.clone(), str_of(m, "name").unwrap_or(&id)))
            })
            .collect()
    };
    if let Some(cur) = current.as_deref() {
        for model in &mut models {
            if model.id == cur {
                model.is_default = true;
            }
        }
    }
    models
}

pub(super) fn current_model(session: &Value) -> Option<String> {
    config_option(session, "model")
        .and_then(|o| str_of(o, "currentValue"))
        .or_else(|| session.pointer("/models/currentModelId").and_then(Value::as_str))
        .map(str::to_string)
}

pub(super) fn session_config_options(reply: &Value) -> Option<Vec<Value>> {
    reply.get("configOptions").and_then(Value::as_array).cloned()
}
