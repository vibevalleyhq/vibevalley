use std::io::{self, SeekFrom};
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;

use axum::body::{Body, Bytes};
use axum::extract::FromRef;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::Stream;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;
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

/// Streams exactly `length` bytes from `file` using `tokio_util::io::ReaderStream`,
/// surfacing `UnexpectedEof` if the file was truncated beneath `length`.
pub(super) fn file_range_stream(file: tokio::fs::File, length: u64, truncated_msg: &'static str) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static {
    let mut reader = ReaderStream::with_capacity(file.take(length), FILE_STREAM_CHUNK_BYTES);
    let mut remaining = length;
    futures_util::stream::poll_fn(move |cx| match Pin::new(&mut reader).poll_next(cx) {
        Poll::Ready(Some(Ok(chunk))) => {
            remaining = remaining.saturating_sub(chunk.len() as u64);
            Poll::Ready(Some(Ok(chunk)))
        }
        Poll::Ready(Some(Err(err))) => Poll::Ready(Some(Err(err))),
        Poll::Ready(None) if remaining > 0 => {
            remaining = 0;
            Poll::Ready(Some(Err(io::Error::new(io::ErrorKind::UnexpectedEof, truncated_msg))))
        }
        Poll::Ready(None) => Poll::Ready(None),
        Poll::Pending => Poll::Pending,
    })
}

pub(super) fn is_media_input_uuid(id: &str) -> bool {
    id.len() == 36 && !id.bytes().any(|b| b.is_ascii_uppercase()) && uuid::Uuid::parse_str(id).is_ok()
}

pub(super) fn parse_byte_range(text: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let (a, b) = text.trim().strip_prefix("bytes=")?.split_once('-')?;
    let parse_u64 = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<u64>().ok()
        } else {
            None
        }
    };
    let (start, end) = if a.is_empty() {
        let suffix = parse_u64(b)?;
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = parse_u64(a)?;
        let end = if b.is_empty() { size - 1 } else { parse_u64(b)?.min(size - 1) };
        (start, end)
    };
    (start <= end && start < size).then_some((start, end))
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

const RFC5987_ENCODE_SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

fn rfc5987_encode(name: &str) -> String {
    percent_encoding::utf8_percent_encode(name, RFC5987_ENCODE_SET).to_string()
}

pub(super) async fn serve_file_range(headers: &HeaderMap, spec: FileRangeSpec<'_>) -> Result<Response, FileServeError> {
    let mut file = tokio::fs::File::open(spec.path).await.map_err(FileServeError::Open)?;
    let size = file.metadata().await.map_err(FileServeError::Open)?.len();
    let range_header = headers.get("range");
    let disposition = format!("inline; filename*=UTF-8''{}", rfc5987_encode(spec.filename));

    if size == 0 {
        if range_header.is_some() {
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", "bytes */0")]).into_response());
        }
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", spec.content_type)
            .header("content-length", 0)
            .header("accept-ranges", "bytes")
            .header("content-disposition", disposition)
            .header("cache-control", spec.cache_control)
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "sandbox")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()));
    }

    let (status, start, end) = match range_header {
        Some(value) => {
            let Some((start, end)) = value.to_str().ok().and_then(|s| parse_byte_range(s, size)) else {
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", format!("bytes */{size}"))]).into_response());
            };
            (StatusCode::PARTIAL_CONTENT, start, end)
        }
        None => (StatusCode::OK, 0, size - 1),
    };

    if start > 0 {
        file.seek(SeekFrom::Start(start)).await.map_err(FileServeError::Seek)?;
    }
    let length = end - start + 1;
    let stream = file_range_stream(file, length, spec.truncated_msg);
    let mut response = Response::builder()
        .status(status)
        .header("content-type", spec.content_type)
        .header("content-length", length)
        .header("accept-ranges", "bytes")
        .header("content-disposition", disposition)
        .header("cache-control", spec.cache_control)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    Ok(response
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}
