use std::io::{self, SeekFrom};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::FromRef;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::Stream;
use tokio::io::AsyncSeekExt;
use tokio_util::sync::CancellationToken;
use vibevalley_kit::net::gateway::range::{RangeOutcome, bounded_range_stream, encode_rfc5987_filename, evaluate_range, unsatisfiable_content_range};
use vibevalley_protocol::{ApiError, BizCode, Envelope};

use crate::gateway::api::{GatewayPorts, Server};

const FILE_STREAM_CHUNK_BYTES: usize = 64 * 1024;

pub(super) type Shared = Arc<dyn Server>;

#[derive(Clone)]
pub(super) struct HttpState {
    pub(super) server: Shared,
    pub(super) ports: Option<GatewayPorts>,
    pub(super) shutdown: CancellationToken,
    pub(super) is_remote: bool,
}

impl HttpState {
    pub(super) fn ports(&self) -> GatewayPorts {
        self.ports.clone().unwrap_or_else(|| self.server.ports())
    }
}

impl FromRef<HttpState> for Shared {
    fn from_ref(state: &HttpState) -> Self {
        state.server.clone()
    }
}

/// The envelope as VibeValley sends it, with the HTTP status its code has.
pub(super) fn reply(envelope: Envelope) -> Response {
    let status = if envelope.biz_code == 0 {
        StatusCode::OK
    } else {
        BizCode::from_code(envelope.biz_code)
            .and_then(|c| StatusCode::from_u16(c.meta().status).ok())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    };
    let body = serde_json::to_vec(&envelope).unwrap_or_default();
    (status, [("content-type", "application/json; charset=utf-8")], body).into_response()
}

pub(super) fn refuse(code: BizCode, message: impl Into<String>) -> Response {
    reply(Envelope::failure(&ApiError::new(code, message)))
}

/// Streams exactly `length` bytes from `file` via [`vibevalley_kit::net::gateway::range::bounded_range_stream`],
/// surfacing `UnexpectedEof` if the file was truncated beneath `length`.
pub(super) fn file_range_stream(file: tokio::fs::File, length: u64, truncated_msg: &'static str) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static {
    bounded_range_stream(file, length, FILE_STREAM_CHUNK_BYTES, truncated_msg)
}

pub(super) fn is_media_input_uuid(id: &str) -> bool {
    id.len() == 36 && !id.bytes().any(|b| b.is_ascii_uppercase()) && uuid::Uuid::parse_str(id).is_ok()
}

#[cfg(test)]
pub(super) fn parse_byte_range(text: &str, size: u64) -> Option<(u64, u64)> {
    vibevalley_kit::net::gateway::range::parse_byte_range(text, size).map(|r| (r.start, r.end))
}

pub(super) struct FileRangeSpec<'a> {
    pub(super) path: &'a std::path::Path,
    pub(super) content_type: &'a str,
    pub(super) filename: &'a str,
    pub(super) cache_control: &'a str,
    pub(super) truncated_msg: &'static str,
}

pub(super) enum FileServeError {
    Open(io::Error),
    Seek(io::Error),
}

pub(super) async fn serve_file_range(headers: &HeaderMap, spec: FileRangeSpec<'_>) -> Result<Response, FileServeError> {
    let mut file = tokio::fs::File::open(spec.path).await.map_err(FileServeError::Open)?;
    let size = file.metadata().await.map_err(FileServeError::Open)?.len();
    let range_header = headers.get("range");
    let disposition = format!("inline; filename*=UTF-8''{}", encode_rfc5987_filename(spec.filename));

    let range_str = match range_header {
        Some(value) => match value.to_str() {
            Ok(s) => Some(s),
            Err(_) => {
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", unsatisfiable_content_range(size))]).into_response());
            }
        },
        None => None,
    };

    match evaluate_range(range_str, size) {
        RangeOutcome::Unsatisfiable { total } => {
            Ok((StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", unsatisfiable_content_range(total))]).into_response())
        }
        RangeOutcome::Full { total: 0 } => Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", spec.content_type)
            .header("content-length", 0)
            .header("accept-ranges", "bytes")
            .header("content-disposition", disposition)
            .header("cache-control", spec.cache_control)
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "sandbox")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())),
        RangeOutcome::Full { total } => {
            let stream = file_range_stream(file, total, spec.truncated_msg);
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("content-type", spec.content_type)
                .header("content-length", total)
                .header("accept-ranges", "bytes")
                .header("content-disposition", disposition)
                .header("cache-control", spec.cache_control)
                .header("x-content-type-options", "nosniff")
                .header("content-security-policy", "sandbox")
                .body(Body::from_stream(stream))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
        }
        RangeOutcome::Partial(range) => {
            if range.start > 0 {
                file.seek(SeekFrom::Start(range.start)).await.map_err(FileServeError::Seek)?;
            }
            let length = range.len();
            let stream = file_range_stream(file, length, spec.truncated_msg);
            Ok(Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("content-type", spec.content_type)
                .header("content-length", length)
                .header("accept-ranges", "bytes")
                .header("content-disposition", disposition)
                .header("cache-control", spec.cache_control)
                .header("x-content-type-options", "nosniff")
                .header("content-security-policy", "sandbox")
                .header("content-range", range.content_range_header())
                .body(Body::from_stream(stream))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
        }
    }
}
