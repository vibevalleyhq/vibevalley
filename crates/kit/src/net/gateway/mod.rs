//! Domain-agnostic gateway primitives: single-flight dirty-mask [`feed`], pure-async
//! traced [`rpc`], RFC 9110 HTTP [`range`] slicing, [`bridge`] wire frames, and
//! [`remote`] pairing/bearer-token/LAN-probe helpers.

pub mod bridge;
pub mod feed;
pub mod range;
pub mod remote;
pub mod rpc;
