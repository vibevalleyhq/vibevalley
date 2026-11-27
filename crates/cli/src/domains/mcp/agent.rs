//! `vv_agent_list` and `vv_agent_register` MCP tools.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_mcp::{ToolCallResult, ToolDef};
use vibevalley_protocol::{Agent, AgentExecutionMode, AgentRegisterInput, AgentRole, ops};

use super::{McpServer, format_failure, non_empty_trimmed, redact_result, tool_def};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentListArgs {
    #[serde(default)]
    role: Option<AgentRole>,
    #[serde(default)]
    mode: Option<AgentExecutionMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentRegisterArgs {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub duty: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRosterItem {
    id: String,
    code: String,
    name: String,
    role: AgentRole,
    mode: AgentExecutionMode,
    runtime: String,
    avatar: Option<String>,
}

impl From<Agent> for AgentRosterItem {
    fn from(agent: Agent) -> Self {
        Self {
            id: agent.id,
            code: agent.code,
            name: agent.name,
            role: agent.role,
            mode: agent.mode,
            runtime: agent.runtime,
            avatar: agent.look.avatar,
        }
    }
}

pub(super) fn tool_definitions() -> Vec<ToolDef> {
    vec![
        tool_def(
            "vv_agent_list",
            "List teammates on the VibeValley roster with their permanent O-XX / W-XX code, role, execution mode (`managed` or `external`), runtime, and Papertrails avatar.",
            json!({
                "type": "object",
                "properties": {
                    "role": { "type": "string", "enum": ["orchestrator", "worker"], "description": "Optional role filter (`orchestrator` or `worker`)." },
                    "mode": { "type": "string", "enum": ["managed", "external"], "description": "Optional execution mode filter (`managed` for local OAR dispatch, `external` for registered IDE/coding agents)." }
                }
            }),
        ),
        tool_def(
            "vv_agent_register",
            "Idempotently register or update an `external` worker teammate with a permanent `W-XX` code, deterministic Papertrails avatar, and runtime badge. External teammates are not auto-dispatched to VibeValley's OAR queue and can be used directly as `owner` (`{ kind: 'agent', id }`) in `vv_issue_create`/`vv_issue_update` and `origin` (`agent:<id>`) in `vv_note_write`.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Optional stable teammate id (if omitted, derived deterministically from runtime and name)." },
                    "name": { "type": "string", "description": "Teammate display name (e.g. 'Antigravity', 'Cursor Composer')." },
                    "runtime": { "type": "string", "description": "Coding agent runtime badge id (e.g. 'antigravity', 'cursor', 'claude', 'codex')." },
                    "duty": { "type": "string", "description": "Optional one-sentence responsibility description." },
                    "avatar": { "type": "string", "description": "Optional Papertrails role portrait asset id (`avatar-*`); falls back deterministically by id when omitted." },
                    "code": { "type": "string", "description": "Optional explicit worker code (`W-XX`); auto-allocated permanently when omitted." },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional specialty tags." }
                },
                "required": ["name"]
            }),
        ),
    ]
}

impl McpServer {
    pub(super) async fn tool_agent_list(&self, raw_args: Value) -> ToolCallResult {
        let args: AgentListArgs = match Self::decode_args("vv_agent_list", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let client = self.client.read().await;
        let agents: Vec<Agent> = match client.ask::<ops::AgentList>(&()).await {
            Ok(list) => list,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
        };
        let items: Vec<AgentRosterItem> = agents
            .into_iter()
            .filter(|a| args.role.is_none_or(|r| a.role == r))
            .filter(|a| args.mode.is_none_or(|m| a.mode == m))
            .map(AgentRosterItem::from)
            .collect();
        redact_result(ToolCallResult::json(&items), &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_agent_register(&self, raw_args: Value) -> ToolCallResult {
        let args: AgentRegisterArgs = match Self::decode_args("vv_agent_register", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let name = args.name.trim().to_string();
        if name.is_empty() {
            return ToolCallResult::error("vv_agent_register requires a non-empty name");
        }
        let req = AgentRegisterInput {
            id: non_empty_trimmed(args.id),
            name,
            runtime: non_empty_trimmed(args.runtime),
            duty: args.duty.map(|d| d.trim().to_string()),
            avatar: non_empty_trimmed(args.avatar),
            code: non_empty_trimmed(args.code),
            tags: args.tags,
        };
        let client = self.client.read().await;
        let registered: Agent = match client.ask::<ops::AgentRegister>(&req).await {
            Ok(agent) => agent,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
        };
        redact_result(ToolCallResult::json(&AgentRosterItem::from(registered)), &Self::known_secrets(&client, None))
    }
}
