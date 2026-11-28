//! RFC 9110 HTTP `Range` header parsing, `206 Partial Content` / `416 Range Not Satisfiable`
//! calculation, RFC 5987 filename encoding, and bounded async byte-range streaming.

use std::io;
use std::pin::Pin;
use std::task::Poll;

use futures_util::Stream;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::bytes::Bytes;
use tokio_util::io::ReaderStream;

/// Validated inclusive HTTP byte range (`start..=end`) within a resource of `total` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
    pub total: u64,
}

impl ByteRange {
    /// Number of bytes covered by this inclusive range.
    pub const fn len(&self) -> u64 {
        self.end - self.start + 1
    }

    pub const fn is_empty(&self) -> bool {
        false
    }

    /// Formats the RFC 9110 `Content-Range` header value (`bytes <start>-<end>/<total>`).
    pub fn content_range_header(&self) -> String {
        format!("bytes {}-{}/{}", self.start, self.end, self.total)
    }
}

/// Outcome of evaluating an optional HTTP `Range` header against a resource size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// No `Range` header was supplied (`200 OK` full representation).
    Full { total: u64 },
    /// Valid satisfiable byte range (`206 Partial Content`).
    Partial(ByteRange),
    /// Invalid or unsatisfiable `Range` header (`416 Range Not Satisfiable`).
    Unsatisfiable { total: u64 },
}

/// Formats the RFC 9110 `Content-Range` header value for a `416 Range Not Satisfiable` reply.
pub fn unsatisfiable_content_range(total: u64) -> String {
    format!("bytes */{total}")
}

/// Parses a single RFC 9110 `bytes=` range specification against a resource of `total` bytes.
///
/// Rejects empty resources, multi-range headers, signed digits, suffix `-0`, and out-of-bounds ranges.
pub fn parse_byte_range(text: &str, total: u64) -> Option<ByteRange> {
    if total == 0 {
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
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start = parse_u64(a)?;
        let end = if b.is_empty() { total - 1 } else { parse_u64(b)?.min(total - 1) };
        (start, end)
    };
    (start <= end && start < total).then_some(ByteRange { start, end, total })
}

/// Evaluates an optional HTTP `Range` header string into `200`, `206`, or `416`.
pub fn evaluate_range(range_header: Option<&str>, total: u64) -> RangeOutcome {
    match range_header {
        None => RangeOutcome::Full { total },
        Some(raw) => match parse_byte_range(raw, total) {
            Some(range) => RangeOutcome::Partial(range),
            None => RangeOutcome::Unsatisfiable { total },
        },
    }
}

const RFC5987_ENCODE_SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// Percent-encodes a filename for `Content-Disposition: inline; filename*=UTF-8''...`.
pub fn encode_rfc5987_filename(name: &str) -> String {
    percent_encoding::utf8_percent_encode(name, RFC5987_ENCODE_SET).to_string()
}

/// Streams exactly `length` bytes from `reader`, surfacing `UnexpectedEof` if the
/// underlying source terminates before yielding `length` bytes.
pub fn bounded_range_stream<R>(
    reader: R,
    length: u64,
    chunk_bytes: usize,
    truncated_msg: &'static str,
) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut reader = ReaderStream::with_capacity(reader.take(length), chunk_bytes);
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

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::*;

    #[test]
    fn parses_rfc9110_single_byte_ranges_and_rejects_invalid_specs() {
        for (raw, want) in [
            ("bytes=2-4", Some((2, 4, 3))),
            ("bytes=-3", Some((7, 9, 3))),
            ("bytes=-99", Some((0, 9, 10))),
            ("bytes=7-", Some((7, 9, 3))),
            ("bytes=0-99", Some((0, 9, 10))),
            ("  bytes=0-0  ", Some((0, 0, 1))),
            ("bytes=-0", None),
            ("bytes=10-", None),
            ("bytes=5-2", None),
            ("bytes=0-1,2-3", None),
            ("bytes=+1-2", None),
            ("bytes=-1-2", None),
            ("items=0-5", None),
            ("bytes=abc-def", None),
            ("bytes=", None),
        ] {
            let parsed = parse_byte_range(raw, 10);
            assert_eq!(parsed.map(|r| (r.start, r.end, r.len())), want, "range={raw}");
        }
        assert_eq!(parse_byte_range("bytes=0-0", 0), None);
    }

    #[test]
    fn evaluates_full_partial_and_unsatisfiable_outcomes() {
        assert_eq!(evaluate_range(None, 100), RangeOutcome::Full { total: 100 });
        assert_eq!(evaluate_range(None, 0), RangeOutcome::Full { total: 0 });
        assert_eq!(evaluate_range(Some("bytes=0-0"), 0), RangeOutcome::Unsatisfiable { total: 0 });
        assert_eq!(unsatisfiable_content_range(0), "bytes */0");

        let partial = evaluate_range(Some("bytes=10-19"), 100);
        assert_eq!(
            partial,
            RangeOutcome::Partial(ByteRange {
                start: 10,
                end: 19,
                total: 100,
            })
        );
        if let RangeOutcome::Partial(r) = partial {
            assert_eq!(r.len(), 10);
            assert_eq!(r.content_range_header(), "bytes 10-19/100");
        }
    }

    #[tokio::test]
    async fn bounded_range_stream_reads_exact_length_and_detects_truncation() {
        let mut ok_stream = Box::pin(bounded_range_stream(std::io::Cursor::new(b"hello world".to_vec()), 5, 4, "truncated"));
        let mut collected = Vec::new();
        while let Some(chunk) = ok_stream.next().await {
            collected.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(collected, b"hello");

        let mut short_stream = Box::pin(bounded_range_stream(std::io::Cursor::new(b"hi".to_vec()), 5, 4, "file truncated"));
        let first = short_stream.next().await.unwrap().unwrap();
        assert_eq!(&first[..], b"hi");
        let err = short_stream.next().await.unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }
}
