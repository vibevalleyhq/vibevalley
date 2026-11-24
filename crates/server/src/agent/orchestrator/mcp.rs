use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::OnceCell;
use vibevalley_protocol::{Agent, MCPServer};
use vibevalley_runtime::agent::Tool;
use vibevalley_runtime::agent::resources::mcp::{McpConfig, McpHub, McpServerConfig};

#[derive(Default)]
pub(super) struct ProfileServers(Mutex<HashMap<String, Arc<Connection>>>);

struct Connection {
    servers: Vec<MCPServer>,
    hub: OnceCell<McpHub>,
}

impl ProfileServers {
    pub(super) async fn tools(&self, profile: &Agent) -> Vec<Box<dyn Tool>> {
        let connection = {
            let mut all = self.0.lock();
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
                    hub: OnceCell::new(),
                });
                all.insert(profile.id.clone(), new.clone());
                new
            }
        };
        let hub = connection
            .hub
            .get_or_init(|| async {
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
                let hub = McpHub::connect(&McpConfig { servers }).await;
                for (_, why) in &hub.failures {
                    eprintln!("vibevalley: {}: {why}", profile.id);
                }
                hub
            })
            .await;
        hub.tools()
            .into_iter()
            .filter(|tool| !profile.disallowed_tools.contains(&tool.spec().name))
            .collect()
    }

    pub(super) fn forget(&self, id: &str) {
        self.0.lock().remove(id);
    }

    pub(super) fn close(&self) {
        self.0.lock().clear();
    }
}
