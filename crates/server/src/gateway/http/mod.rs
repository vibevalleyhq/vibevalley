//! The HTTP API (`/api/v1`) over the in-process server, so the clients
//! work against it unchanged: its CLI (`VIBEVALLEY_SERVER=…
//! vibevalley issue list`), scripts, and later the LAN and phone paths.
//!
//! Wire:
//! - `POST /api/v1/<op with . as />` with a JSON body → the envelope, HTTP
//!   status from the business code's `bizCodeMeta`;
//! - `GET /api/v1/slice/<name>`: JSON snapshot when `Accept` contains
//!   `application/json` or `?once=1`, otherwise SSE (`id: <seq>\ndata: <json>\n\n`,
//!   `: ping` every 20 s) honoring `Last-Event-ID` or `?after=<seq>`;
//! - `GET /api/v1/live` (`/api/v1/events`) as server-sent events;
//! - `GET /api/v1/subscribe/<name>?payload=<JSON>`: a refusal before the
//!   first event is a plain JSON error, then events;
//! - `GET /api/v1/issue/watch/<id>`: the `issue.watch` subscription; an
//!   empty 404 when it is refused;
//! - `GET /api/v1/attachment/<id>`: the stored file (`attachment.file`);
//! - only the machine's own pages: a loopback `Host`, and an `Origin` (when
//!   sent) equal to it, `Sec-Fetch-Site` same-origin or none (`from_the_farm`).

mod auth;
mod machine_ws;
mod media;
mod server;
mod shared;

pub use auth::from_the_farm;
pub use server::{
    Listener, is_allowed_remote_ip, is_remote_allow_all, router, router_with_ports, serve, serve_remote, serve_remote_with_ports, serve_with_ports,
};
#[cfg(test)]
use shared::{Shared, file_range_stream, is_media_input_uuid};

#[cfg(test)]
mod tests;
