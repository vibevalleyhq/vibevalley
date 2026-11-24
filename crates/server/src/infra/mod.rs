use vibevalley_protocol::Health;

pub mod debug;
pub mod http;
pub mod machine;
pub mod provider;
pub mod remote;
pub mod setting;
pub mod text;

pub fn health(version: &str) -> Health {
    Health {
        ok: true,
        version: version.to_string(),
    }
}
