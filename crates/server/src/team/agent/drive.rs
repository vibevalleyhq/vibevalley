//! Pure profile instruction formatting and agent-key resolution (L1).
//! Session `Drivers` implementation lives in `work::session::drivers` (L2).

use vibevalley_protocol::{Agent, Skill};

use super::AgentStore;

/// `instructions`: the persona, then each of its skills.
pub fn instructions(agent: &Agent, library: &[Skill]) -> String {
    let mut parts = vec![agent.persona.trim().to_string()];
    for id in &agent.skills {
        if let Some(skill) = library.iter().find(|s| &s.id == id) {
            parts.push(format!("## {}\n{}", skill.name, skill.body.trim()));
        }
    }
    parts.retain(|p| !p.is_empty());
    parts.join("\n\n")
}

impl AgentStore {
    /// An issue's agent as the user wrote it: a profile's name becomes its
    /// id; anything else is kept as written.
    pub fn agent_key(&self, written: &str) -> String {
        let key = written.trim();
        if key.is_empty() {
            return String::new();
        }
        self.profiles.named(key).map(|a| a.id).unwrap_or_else(|| key.to_string())
    }
}
