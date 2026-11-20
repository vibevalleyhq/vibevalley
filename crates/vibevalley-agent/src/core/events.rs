use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ai::ModelClient;
use crate::ai::types::{Message, Usage};
use crate::core::tool::{Tool, ToolOutput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Completed,
    Aborted,
    Failed,
    TooLong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessage {
    pub seq: Option<i64>,
    pub kind: String,
    pub message: Message,
    #[serde(default)]
    pub is_delta_system: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_task: Option<String>,
}

impl AgentMessage {
    pub fn new(kind: impl Into<String>, message: Message) -> Self {
        Self {
            seq: None,
            kind: kind.into(),
            message,
            is_delta_system: false,
            generation_task: None,
        }
    }

    pub fn system(text: impl Into<String>) -> Self {
        Self::new("pi.system", Message::system(text))
    }

    pub fn system_delta(text: impl Into<String>) -> Self {
        Self {
            is_delta_system: true,
            ..Self::system(text)
        }
    }

    pub fn user(text: impl Into<String>) -> Self {
        Self::new("pi.user", Message::user(text))
    }

    pub fn assistant(message: Message) -> Self {
        Self::new("pi.assistant", message)
    }

    pub fn tool_result(call_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self::new("pi.tool_result", Message::tool(call_id, text))
    }
}

impl From<Message> for AgentMessage {
    fn from(message: Message) -> Self {
        let kind = match message.role {
            crate::ai::types::Role::System => "pi.system",
            crate::ai::types::Role::User => "pi.user",
            crate::ai::types::Role::Assistant => "pi.assistant",
            crate::ai::types::Role::Tool => "pi.tool_result",
        };
        Self::new(kind, message)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    AgentStart,
    TurnStart {
        step: usize,
    },
    TextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolStart {
        id: String,
        name: String,
        arguments: String,
    },
    ToolUpdate {
        id: String,
        name: String,
        text: String,
    },
    ToolEnd {
        id: String,
        name: String,
        output: ToolOutput,
    },
    PermissionRequested {
        task_id: String,
        tool_call_id: String,
        tool_name: String,
        arguments: String,
        reason: String,
    },
    SubagentSpawned {
        parent_conversation_id: String,
        child_conversation_id: String,
        task_id: String,
        label: String,
        brief: String,
    },
    SubagentStatusChanged {
        child_conversation_id: String,
        task_id: String,
        status: String,
        message: String,
    },
    Compacted {
        level: String,
        summary: String,
    },
    TurnEnd {
        step: usize,
        usage: Usage,
    },
    AgentEnd {
        outcome: TurnOutcome,
        usage: Usage,
        text: String,
    },
    Error {
        message: String,
    },
}

pub struct Brain {
    pub client: Arc<dyn ModelClient>,
    pub model: String,
    pub system: String,
    pub tools: Vec<Box<dyn Tool>>,
    pub max_steps: usize,
    pub effort: Option<String>,
    pub cwd: Option<PathBuf>,
}

impl Brain {
    pub fn new(client: Arc<dyn ModelClient>, model: impl Into<String>, system: impl Into<String>) -> Self {
        Self {
            client,
            model: model.into(),
            system: system.into(),
            tools: Vec::new(),
            max_steps: 200,
            effort: None,
            cwd: None,
        }
    }

    pub fn tool(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.iter().map(|t| t.as_ref()).find(|t| t.spec().name == name)
    }
}
