//! `core/api.ts`: the server's health.

use vibevalley_protocol::{Health, ops};

use crate::Hub;

pub fn install(hub: &Hub) {
    hub.on::<ops::ServerHealthGet>(|_, ()| {
        Ok(Health {
            ok: true,
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    });
}
