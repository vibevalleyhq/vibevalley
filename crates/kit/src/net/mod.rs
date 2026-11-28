//! Network I/O primitives: outbound HTTP with SSRF guards (`net-client`) and
//! domain-agnostic gateway feed, RPC, HTTP range, bridge, and remote auth primitives (`net-gateway`).

#[cfg(feature = "net-gateway")]
pub mod gateway;
#[cfg(feature = "net-client")]
pub mod outbound;
