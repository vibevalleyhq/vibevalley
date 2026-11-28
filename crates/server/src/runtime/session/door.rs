//! Per-session MCP door URL, bearer token registry, and in-flight opening
//! session snapshots extracted from [`super::engine::SessionEngine`].

use std::collections::HashMap;

use parking_lot::Mutex;
use vibevalley_protocol::Session;
use vibevalley_runtime::oar::McpServer;

#[derive(Default)]
struct DoorState {
    url: Option<String>,
    tokens: HashMap<String, String>,
    opening: HashMap<String, Session>,
}

/// Manages the farm's MCP HTTP door URL, per-session bearer tokens, and
/// pre-commit opening session snapshots.
#[derive(Default)]
pub(super) struct DoorRegistry {
    state: Mutex<DoorState>,
}

impl DoorRegistry {
    pub(super) fn set_url(&self, url: String) {
        self.state.lock().url = Some(url);
    }

    pub(super) fn url(&self) -> Option<String> {
        self.state.lock().url.clone()
    }

    pub(super) fn who(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        self.state.lock().tokens.get(token).cloned()
    }

    pub(super) fn opening_session(&self, session: &str) -> Option<Session> {
        self.state.lock().opening.get(session).cloned()
    }

    pub(super) fn begin_opening(&self, session: &Session) {
        self.state.lock().opening.insert(session.id.clone(), session.clone());
    }

    pub(super) fn finish_opening(&self, session_id: &str) {
        self.state.lock().opening.remove(session_id);
    }

    /// Mints (or reuses) the per-session MCP bearer token so remote sessions can
    /// authenticate over the WS MCP reverse tunnel even without a local HTTP MCP URL.
    pub(super) fn token_for(&self, session: &str) -> String {
        let mut state = self.state.lock();
        match state.tokens.iter().find(|(_, s)| s.as_str() == session) {
            Some((t, _)) => t.clone(),
            None => {
                let t = uuid::Uuid::new_v4().simple().to_string();
                state.tokens.insert(t.clone(), session.to_string());
                t
            }
        }
    }

    /// Returns the MCP HTTP server entry for `session` once the door URL is known.
    pub(super) fn server_for(&self, session: &str) -> Option<McpServer> {
        let url = self.url()?;
        let token = self.token_for(session);
        Some(McpServer::Http {
            name: "vibevalley".into(),
            url,
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
        })
    }

    pub(super) fn revoke_session(&self, session_id: &str) {
        let mut state = self.state.lock();
        state.tokens.retain(|_, s| s != session_id);
        state.opening.remove(session_id);
    }
}
