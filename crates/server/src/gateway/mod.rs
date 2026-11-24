//! External gateway layer: in-process server contract (`api`), GPUI view bridge
//! (`bridge`), loopback and remote HTTP/SSE/WS gateway (`http`), and controlled
//! remote access pairing and device authentication (`remote`).

pub mod api;
pub mod bridge;
pub mod http;
pub mod remote;

pub use http::{Listener, serve, serve_remote, serve_remote_with_ports, serve_with_ports};
