//! Media binary inputs & speech streams: bounded streaming upload and ranged playback.
use super::auth::{Authenticated, AuthenticatedQuery};
use super::shared::{FileRangeSpec, HttpState, is_media_input_uuid, refuse, reply, serve_file_range};
use crate::gateway::api::{CallerContext, CallerPrincipal};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{Stream, StreamExt};
use std::{io, time::Duration};
use tokio_util::io::{StreamReader, SyncIoBridge};
use vibevalley_protocol::{BizCode, Envelope, SCOPE_REMOTE_MACHINE};

const MAX: u64 = 512_000_000;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);

fn is_remote_machine(ctx: &CallerContext) -> bool {
    matches!(&ctx.principal, CallerPrincipal::RemoteDevice { scope, .. } if scope == SCOPE_REMOTE_MACHINE)
}

pub(super) fn bounded_upload_stream(body: Body, max_bytes: u64, timeout: Duration) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static {
    let deadline = tokio::time::Instant::now() + timeout;
    futures_util::stream::unfold((body.into_data_stream(), 0u64, false), move |(mut stream, mut seen, done)| async move {
        if done {
            return None;
        }
        match tokio::time::timeout_at(deadline, stream.next()).await {
            Err(_) => Some((Err(io::Error::new(io::ErrorKind::TimedOut, "media upload deadline")), (stream, seen, true))),
            Ok(None) => None,
            Ok(Some(Err(err))) => Some((Err(io::Error::new(io::ErrorKind::UnexpectedEof, err)), (stream, seen, true))),
            Ok(Some(Ok(chunk))) => {
                seen = seen.saturating_add(chunk.len() as u64);
                if seen > max_bytes {
                    return Some((
                        Err(io::Error::new(io::ErrorKind::InvalidData, "media upload exceeds max size")),
                        (stream, seen, true),
                    ));
                }
                Some((Ok(chunk), (stream, seen, false)))
            }
        }
    })
}

pub(super) async fn upload(
    State(state): State<HttpState>,
    Authenticated(ctx): Authenticated,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if is_remote_machine(&ctx) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    if !headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/octet-stream"))
    {
        return refuse(BizCode::UnsupportedMediaType, "application/octet-stream required");
    }
    if headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .is_some_and(|n| n > MAX)
    {
        return refuse(BizCode::PayloadTooLarge, "the body exceeds 512000000 bytes");
    }
    if !is_media_input_uuid(&id) {
        return refuse(BizCode::MediaNotFound, "media input not found");
    }
    let Some(inputs) = state.ports().media_input else {
        return refuse(BizCode::ServiceUnavailable, "media inputs unavailable");
    };
    let stream = Box::pin(bounded_upload_stream(body, MAX, UPLOAD_TIMEOUT));
    let reader = SyncIoBridge::new(StreamReader::new(stream));
    match inputs.upload_async(id, Box::new(reader)).await {
        Ok(input) => reply(Envelope::of(Ok(input))),
        Err(e) => reply(Envelope::failure(&e)),
    }
}

pub(super) async fn content(
    State(state): State<HttpState>,
    AuthenticatedQuery(ctx): AuthenticatedQuery,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if is_remote_machine(&ctx) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !is_media_input_uuid(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(inputs) = state.ports().media_input else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(found) = inputs.content_async(id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let spec = FileRangeSpec {
        path: std::path::Path::new(&found.path),
        content_type: &found.r#type,
        filename: &found.name,
        cache_control: "private, no-store",
        truncated_msg: "media input truncated",
    };
    serve_file_range(&headers, spec).await.unwrap_or_else(|_| StatusCode::NOT_FOUND.into_response())
}

/// Calls `gone` when the response body is dropped: the page went away.
struct Gone(Option<Box<dyn FnOnce() + Send>>);

impl Drop for Gone {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// A streamed speech job's events as NDJSON, one line each, for the one page that claims them.
pub(super) async fn speech(State(state): State<HttpState>, AuthenticatedQuery(ctx): AuthenticatedQuery, Path(id): Path<String>) -> Response {
    if is_remote_machine(&ctx) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(streams) = state.ports().speech else {
        return refuse(BizCode::ServiceUnavailable, "no speech here");
    };
    let claim = match streams.claim(&id) {
        Ok(c) => c,
        Err(e) => return reply(Envelope::failure(&e)),
    };
    let gone = Gone(Some(claim.gone));
    let lines = tokio_stream::wrappers::ReceiverStream::new(claim.events).map(move |event| {
        let _keep = &gone;
        Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(format!("{event}\n")))
    });
    (
        [
            ("content-type", "application/x-ndjson"),
            ("cache-control", "no-store"),
            ("x-accel-buffering", "no"),
            ("x-content-type-options", "nosniff"),
        ],
        axum::body::Body::from_stream(lines),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::super::shared::parse_byte_range;
    #[test]
    fn byte_ranges() {
        for (s, want) in [
            ("bytes=2-4", Some((2, 4))),
            ("bytes=-3", Some((7, 9))),
            ("bytes=7-", Some((7, 9))),
            ("bytes=0-99", Some((0, 9))),
            ("bytes=-0", None),
            ("bytes=10-", None),
            ("bytes=5-2", None),
            ("bytes=0-1,2-3", None),
            ("bytes=+1-2", None),
        ] {
            assert_eq!(parse_byte_range(s, 10), want, "{s}");
        }
        assert_eq!(parse_byte_range("bytes=-0", 10), None);
        assert_eq!(parse_byte_range("bytes=0-0", 0), None);
    }
}
