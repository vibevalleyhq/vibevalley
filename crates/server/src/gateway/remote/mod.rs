//! `remote.*`: LAN-direct and optional Tailscale remote access listener,
//! single-use pairing codes, hashed persistent device Bearer tokens, scopes, and revocation.

pub mod lan;
mod service;
pub mod tailscale;

pub use service::{Remote, default_remote_port};

#[cfg(test)]
mod tests;
