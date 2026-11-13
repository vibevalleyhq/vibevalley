//! `lan.get` until the LAN listener is ported (phase 4): the farm is not
//! open on the network, and nothing is wrong with that. Ported from
//! VibeValley `gateway/lan/lan.ts` `status`.

use vibevalley_protocol::{LanStatus, ops};

use crate::Hub;

/// `hostName`: this machine's name without `.local`.
pub fn host_name() -> String {
    let name = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let name = name.strip_suffix(".local").unwrap_or(&name).to_string();
    if name.is_empty() { "vibevalley".into() } else { name }
}

pub fn install(hub: &Hub) {
    let host = host_name();
    hub.on::<ops::LanGet>(move |_, ()| {
        Ok(LanStatus {
            open: false,
            host_name: host.clone(),
            url: None,
            problem: String::new(),
            pairing: None,
        })
    });
}
