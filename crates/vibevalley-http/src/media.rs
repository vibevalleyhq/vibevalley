//! Local binary inputs: bounded streaming upload and ranged playback.
use super::{Shared, from_the_farm, refuse, reply};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::{
    io::{self, Read, Seek},
    time::{Duration, Instant},
};
use vibevalley_protocol::{BizCode, Envelope};
const MAX: u64 = 512_000_000;
enum Chunk {
    Data(Bytes),
    End,
}
struct UploadReader {
    chunks: flume::Receiver<Chunk>,
    current: io::Cursor<Bytes>,
    deadline: Instant,
}
impl Read for UploadReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            let n = self.current.read(out)?;
            if n > 0 {
                return Ok(n);
            }
            let left = self.deadline.saturating_duration_since(Instant::now());
            match self.chunks.recv_timeout(left) {
                Ok(Chunk::Data(b)) => self.current = io::Cursor::new(b),
                Ok(Chunk::End) => return Ok(0),
                Err(flume::RecvTimeoutError::Timeout) => return Err(io::Error::new(io::ErrorKind::TimedOut, "media upload deadline")),
                Err(e) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, e)),
            }
        }
    }
}
pub(super) async fn upload(State(server): State<Shared>, Path(id): Path<String>, headers: HeaderMap, body: Body) -> Response {
    if !from_the_farm(&headers) {
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
    if !super::artifact_id().is_match(&id) {
        return refuse(BizCode::MediaNotFound, "media input not found");
    }
    let Some(inputs) = server.media_inputs() else {
        return refuse(BizCode::ServiceUnavailable, "media inputs unavailable");
    };
    let (tx, rx) = flume::bounded(2);
    let reader = UploadReader {
        chunks: rx,
        current: io::Cursor::new(Bytes::new()),
        deadline: Instant::now() + Duration::from_secs(300),
    };
    let mut work = tokio::task::spawn_blocking(move || inputs.upload(&id, Box::new(reader)));
    let pump = async move {
        let mut stream = body.into_data_stream();
        let mut size = 0u64;
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                return;
            };
            size += chunk.len() as u64;
            if size > MAX {
                return;
            }
            // Slice oversized transport chunks so at most 128 KiB is queued.
            for offset in (0..chunk.len()).step_by(64 * 1024) {
                if tx
                    .send_async(Chunk::Data(chunk.slice(offset..(offset + 64 * 1024).min(chunk.len()))))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
        let _ = tx.send_async(Chunk::End).await;
    };
    let result = tokio::select! {
        r=&mut work => r,
        _=tokio::time::timeout(Duration::from_secs(300),pump) => work.await,
    };
    match result {
        Ok(Ok(input)) => reply(Envelope::of(Ok(input))),
        Ok(Err(e)) => reply(Envelope::failure(&e)),
        Err(e) => refuse(BizCode::InternalError, e.to_string()),
    }
}
fn range(text: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let Some(text) = text else {
        return Some((0, size - 1));
    };
    let (a, b) = text.strip_prefix("bytes=")?.split_once('-')?;
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<u64>().ok()
        } else {
            None
        }
    };
    let start = if a.is_empty() { size.saturating_sub(number(b)?) } else { number(a)? };
    let end = if !a.is_empty() && !b.is_empty() { number(b)?.min(size - 1) } else { size - 1 };
    (start <= end && start < size).then_some((start, end))
}
pub(super) async fn content(State(server): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !from_the_farm(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !super::artifact_id().is_match(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(inputs) = server.media_inputs() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let found = tokio::task::spawn_blocking(move || {
        let found = inputs.content(&id).map_err(|_| ())?;
        let file = std::fs::File::open(&found.path).map_err(|_| ())?;
        let size = file.metadata().map_err(|_| ())?.len();
        Ok::<_, ()>((found, file, size))
    })
    .await;
    let Ok(Ok((found, mut file, size))) = found else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let text = headers.get("range");
    let bounds = match text {
        Some(v) => v.to_str().ok().and_then(|v| range(Some(v), size)),
        None => range(None, size),
    };
    let Some((start, end)) = bounds else {
        return (StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", format!("bytes */{size}"))]).into_response();
    };
    if file.seek(io::SeekFrom::Start(start)).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let length = end - start + 1;
    let stream = futures_util::stream::try_unfold((file, length), |(mut file, left)| async move {
        if left == 0 {
            return Ok::<_, io::Error>(None);
        }
        tokio::task::spawn_blocking(move || {
            let mut bytes = vec![0; left.min(64 * 1024) as usize];
            let n = file.read(&mut bytes)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "media input truncated"));
            }
            bytes.truncate(n);
            Ok(Some((Bytes::from(bytes), (file, left - n as u64))))
        })
        .await
        .map_err(io::Error::other)?
    });
    let filename = found.name.as_bytes().iter().map(|b| format!("%{b:02X}")).collect::<String>();
    let mut response = Response::builder()
        .status(if text.is_some() { 206 } else { 200 })
        .header("content-type", found.r#type)
        .header("content-length", length)
        .header("accept-ranges", "bytes")
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox")
        .header("content-disposition", format!("inline; filename*=UTF-8''{filename}"));
    if text.is_some() {
        response = response.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
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
pub async fn speech(State(server): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(streams) = server.speech_streams() else {
        return refuse(BizCode::ServiceUnavailable, "no speech here");
    };
    let claim = match tokio::task::spawn_blocking(move || streams.claim(&id)).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => return reply(Envelope::failure(&e)),
        Err(_) => return refuse(BizCode::InternalError, "speech stream"),
    };
    let gone = Gone(Some(claim.gone));
    let lines = claim.events.into_stream().map(move |event| {
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
    use super::range;
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
            assert_eq!(range(Some(s), 10), want, "{s}");
        }
    }
}
