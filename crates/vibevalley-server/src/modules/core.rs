//! `core/api.ts`: the server's health.

use vibevalley_protocol::{Health, ops};

use crate::Hub;

pub fn install(hub: &Hub) {
    install_version(hub, env!("CARGO_PKG_VERSION"));
}

pub fn install_version(hub: &Hub, version: &str) {
    let version = version.to_string();
    hub.on::<ops::ServerHealthGet>(move |_, ()| {
        Ok(Health {
            ok: true,
            version: version.clone(),
        })
    });
}
