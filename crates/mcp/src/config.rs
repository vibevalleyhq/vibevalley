//! Pure, agent-agnostic MCP server configuration specification types.
//!
//! Coding-agent-specific installation and probing live outside this crate (in OAR).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Transport configuration describing how an MCP client reaches a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpTransportSpec {
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    #[serde(rename_all = "camelCase")]
    StreamableHttp {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
        #[serde(default)]
        stateless: bool,
    },
}

/// Named MCP server configuration entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransportSpec,
}

impl McpServerConfig {
    pub fn stdio(name: impl Into<String>, command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            name: name.into(),
            transport: McpTransportSpec::Stdio {
                command: command.into(),
                args,
                env: BTreeMap::new(),
            },
        }
    }

    pub fn streamable_http(name: impl Into<String>, url: impl Into<String>, stateless: bool) -> Self {
        Self {
            name: name.into(),
            transport: McpTransportSpec::StreamableHttp {
                url: url.into(),
                headers: BTreeMap::new(),
                stateless,
            },
        }
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        if let McpTransportSpec::Stdio { ref mut env, .. } = self.transport {
            env.insert(key.into(), value.into());
        }
        self
    }

    pub fn with_header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        if let McpTransportSpec::StreamableHttp { ref mut headers, .. } = self.transport {
            headers.insert(key.into(), value.into());
        }
        self
    }
}
