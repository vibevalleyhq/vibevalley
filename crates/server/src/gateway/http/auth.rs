//! Typed Axum authentication extractors for the HTTP gateway.
//!
//! Every route handler declares its security requirement in its parameter list so
//! missing authentication or loopback checks fail to compile rather than slipping
//! through at runtime.

use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use vibevalley_protocol::{ApiError, BizCode, Caller, Envelope, SCOPE_REMOTE_MACHINE};

use crate::gateway::api::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, RemoteDeviceIdentity};

use super::shared::{HttpState, refuse, reply};

#[derive(serde::Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

pub(super) fn is_loopback(host: &str) -> bool {
    let Some(rest) = host
        .strip_prefix("127.0.0.1")
        .or_else(|| host.strip_prefix("localhost"))
        .or_else(|| host.strip_prefix("[::1]"))
    else {
        return false;
    };
    match rest.strip_prefix(':') {
        None => rest.is_empty(),
        Some(port) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// Only this machine's own pages and tools.
pub fn from_the_farm(headers: &HeaderMap) -> bool {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let host = header("host").unwrap_or("");
    let origin_ok = header("origin").is_none_or(|o| o == format!("http://{host}"));
    let site_ok = header("sec-fetch-site").is_none_or(|s| s == "same-origin" || s == "none");
    is_loopback(host) && origin_ok && site_ok
}

pub(super) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get("authorization")?.to_str().ok()?.trim();
    if raw.eq_ignore_ascii_case("bearer") {
        return Some("");
    }
    let (scheme, token) = raw.split_once(char::is_whitespace)?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

fn query_token(uri: &Uri) -> Option<String> {
    Query::<TokenQuery>::try_from_uri(uri).ok().and_then(|Query(q)| q.token)
}

fn http_caller_context(headers: &HeaderMap) -> CallerContext {
    let is_cli = headers
        .get("x-vibevalley-client")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("cli"));
    let (id, kind, label) = if is_cli {
        ("cli", ClientKind::Cli, "CLI")
    } else {
        ("http-loopback", ClientKind::HttpLoopback, "HTTP loopback")
    };
    CallerContext {
        caller: Caller::User,
        principal: CallerPrincipal::LocalOwner,
        client: Some(ClientIdentity {
            id: id.into(),
            kind,
            label: label.into(),
        }),
        trace_id: 0,
    }
}

async fn authenticate_parts(state: &HttpState, parts: &Parts, allow_query_token: bool) -> Result<CallerContext, ApiError> {
    let query_tok = allow_query_token.then(|| query_token(&parts.uri)).flatten();
    let token = bearer_token(&parts.headers).or_else(|| query_tok.as_deref().map(str::trim).filter(|t| !t.is_empty()));
    let remote_auth = state.ports().remote;
    if let Some(token) = token {
        let Some(auth) = remote_auth else {
            return Err(ApiError::new(BizCode::Unauthorized, vibevalley_i18n::t("server.remote.unauthorized", &[])));
        };
        let identity = auth.verify_bearer_async(token.to_string()).await?;
        return Ok(CallerContext {
            caller: Caller::Remote,
            principal: CallerPrincipal::RemoteDevice {
                device_id: identity.device_id.clone(),
                scope: identity.scope,
            },
            client: Some(ClientIdentity {
                id: identity.device_id,
                kind: ClientKind::RemoteDevice,
                label: identity.name,
            }),
            trace_id: 0,
        });
    }
    if parts.uri.path().trim_end_matches('/') == "/api/v1/remote/pair/exchange" && remote_auth.is_some_and(|a| a.is_enabled()) {
        return Ok(CallerContext {
            caller: Caller::Remote,
            principal: CallerPrincipal::RemoteDevice {
                device_id: String::new(),
                scope: String::new(),
            },
            client: Some(ClientIdentity {
                id: "remote-pairing".into(),
                kind: ClientKind::RemoteDevice,
                label: "Remote pairing".into(),
            }),
            trace_id: 0,
        });
    }
    if !state.is_remote && from_the_farm(&parts.headers) {
        return Ok(http_caller_context(&parts.headers));
    }
    Err(ApiError::new(BizCode::Forbidden, "forbidden"))
}

/// Authenticated caller via `Authorization: Bearer`, the `/api/v1/remote/pair/exchange`
/// pairing handshake, or loopback `from_the_farm` origin validation.
pub(super) struct Authenticated(pub(super) CallerContext);

impl FromRequestParts<HttpState> for Authenticated {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &HttpState) -> Result<Self, Self::Rejection> {
        authenticate_parts(state, parts, false)
            .await
            .map(Self)
            .map_err(|err| reply(Envelope::failure(&err)))
    }
}

/// Like [`Authenticated`], also accepting a `?token=` query parameter for routes
/// loaded directly by browser tags (`<img>`, `<a>`, etc.) where custom headers cannot be attached.
pub(super) struct AuthenticatedQuery(pub(super) CallerContext);

impl FromRequestParts<HttpState> for AuthenticatedQuery {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &HttpState) -> Result<Self, Self::Rejection> {
        authenticate_parts(state, parts, true)
            .await
            .map(Self)
            .map_err(|err| reply(Envelope::failure(&err)))
    }
}

/// Enforces loopback listener and `from_the_farm` headers, rejecting with a JSON
/// `BizCode::Forbidden` envelope.
pub(super) struct LocalOnly;

impl FromRequestParts<HttpState> for LocalOnly {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &HttpState) -> Result<Self, Self::Rejection> {
        if state.is_remote || !from_the_farm(&parts.headers) {
            return Err(refuse(BizCode::Forbidden, "forbidden"));
        }
        Ok(Self)
    }
}

/// Enforces strict Bearer or `?token=` authentication with [`SCOPE_REMOTE_MACHINE`].
/// Never falls back to `LocalOwner`, even on loopback.
pub(super) struct MachineAuth(pub(super) RemoteDeviceIdentity);

impl FromRequestParts<HttpState> for MachineAuth {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &HttpState) -> Result<Self, Self::Rejection> {
        let query_tok = query_token(&parts.uri);
        let token = bearer_token(&parts.headers)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .or_else(|| query_tok.as_deref().map(str::trim).filter(|t| !t.is_empty()));

        let Some(token) = token else {
            return Err(refuse(BizCode::Unauthorized, vibevalley_i18n::t("server.remote.unauthorized", &[])));
        };

        let Some(auth) = state.ports().remote else {
            return Err(refuse(BizCode::Unauthorized, vibevalley_i18n::t("server.remote.unauthorized", &[])));
        };

        let identity = auth
            .verify_bearer_async(token.to_string())
            .await
            .map_err(|err| reply(Envelope::failure(&err)))?;

        if identity.scope != SCOPE_REMOTE_MACHINE {
            return Err(refuse(BizCode::Forbidden, format!("machine WebSocket requires `{SCOPE_REMOTE_MACHINE}` scope")));
        }

        Ok(Self(identity))
    }
}
