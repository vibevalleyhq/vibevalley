use vibevalley_protocol::{Health, ops};

use crate::Hub;

pub(crate) mod column;
pub mod debug;
pub mod http;
pub mod provider;
pub mod remote;
pub mod setting;
pub mod text;

pub fn install_health(hub: &Hub) {
    install_health_version(hub, env!("CARGO_PKG_VERSION"));
}

pub fn install_health_version(hub: &Hub, version: &str) {
    let version = version.to_string();
    hub.on::<ops::ServerHealthGet>(move |_, ()| {
        Ok(Health {
            ok: true,
            version: version.clone(),
        })
    });
}
