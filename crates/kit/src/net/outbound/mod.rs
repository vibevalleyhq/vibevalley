//! Outbound HTTP client abstraction, idempotent `ring` TLS setup, bounded body
//! readers, SSRF-safe bound-DNS public HTTPS downloads, and an in-memory test twin.

pub mod client;
pub mod ssrf;

pub use client::{
    BoxFuture, Fetch, FetchError, Http, MemoryFetch, MemoryResponse, ReadError, RecordedRequest, Request, Response, install_tls, no_redirect_client,
    pooled_client, read_max, read_max_until,
};
pub use ssrf::{
    PublicBytes, PublicDownload, PublicDownloadError, is_forbidden_ip, is_public_v4, pinned_public_client, public_https, resolve_public_v4,
    validate_public_redirect, validate_resolved_addrs,
};
