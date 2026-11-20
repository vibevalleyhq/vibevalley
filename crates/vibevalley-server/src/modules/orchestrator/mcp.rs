use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use vibevalley_agent::Tool;
use vibevalley_agent::resources::mcp::{McpConfig, McpHub, McpServerConfig};
use vibevalley_protocol::{Agent, MCPServer};

use crate::lock;

#[derive(Default)]
pub(super) struct ProfileServers(Mutex<HashMap<String, Arc<Connection>>>);

struct Connection {
    servers: Vec<MCPServer>,
    hub: OnceLock<McpHub>,
}

impl ProfileServers {
    pub(super) fn tools(&self, profile: &Agent) -> Vec<Box<dyn Tool>> {
        let connection = {
            let mut all = lock(&self.0);
            if profile.mcp_servers.is_empty() {
                all.remove(&profile.id);
                return vec![];
            }
            if let Some(saved) = all.get(&profile.id)
                && saved.servers == profile.mcp_servers
            {
                saved.clone()
            } else {
                let new = Arc::new(Connection {
                    servers: profile.mcp_servers.clone(),
                    hub: OnceLock::new(),
                });
                all.insert(profile.id.clone(), new.clone());
                new
            }
        };
        let hub = connection.hub.get_or_init(|| {
            let servers = connection
                .servers
                .iter()
                .map(|entry| match entry {
                    MCPServer::Http(s) => (
                        s.name.clone(),
                        McpServerConfig::Http {
                            url: s.url.clone(),
                            headers: s.headers.clone(),
                        },
                    ),
                    MCPServer::Stdio(s) => (
                        s.name.clone(),
                        McpServerConfig::Stdio {
                            command: s.command.clone(),
                            args: s.args.clone(),
                            env: s.env.clone(),
                            cwd: None,
                        },
                    ),
                })
                .collect();
            let hub = McpHub::connect(&McpConfig { servers });
            for (_, why) in &hub.failures {
                eprintln!("vibevalley: {}: {why}", profile.id);
            }
            hub
        });
        hub.tools()
            .into_iter()
            .filter(|tool| !profile.disallowed_tools.contains(&tool.spec().name))
            .collect()
    }

    pub(super) fn forget(&self, id: &str) {
        lock(&self.0).remove(id);
    }

    pub(super) fn close(&self) {
        lock(&self.0).clear();
    }
}
