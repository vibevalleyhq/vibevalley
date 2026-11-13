use super::inputs::refused;
use std::path::Path;
use vibevalley_protocol::{ApiError, MediaInputKind, MediaInputRequest};

pub(super) fn declared(r: &MediaInputRequest) -> Result<(), ApiError> {
    let (mimes, max): (&[&str], i64) = match r.kind {
        MediaInputKind::Image => (&["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"], 30_000_000),
        MediaInputKind::Video => (
            &[
                "video/mp4",
                "video/x-m4v",
                "video/quicktime",
                "video/x-msvideo",
                "video/webm",
                "video/x-matroska",
            ],
            200_000_000,
        ),
        MediaInputKind::Audio => (&["audio/wav", "audio/mpeg", "audio/mp4", "audio/flac", "audio/ogg", "audio/webm"], 512_000_000),
    };
    if !(16..=max).contains(&r.size)
        || !mimes.contains(&r.mime.as_str())
        || !(1..=256).contains(&r.name.chars().count())
        || r.name.trim().is_empty()
        || r.name.chars().any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(refused("inputInvalid"));
    }
    Ok(())
}

pub(super) fn container(mime: &str, b: &[u8]) -> bool {
    let at = |n: usize, s: &[u8]| b.get(n..n + s.len()) == Some(s);
    match mime {
        "image/png" => at(0, b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => at(0, b"\xff\xd8\xff"),
        "image/webp" => at(0, b"RIFF") && at(8, b"WEBP"),
        "image/gif" => at(0, b"GIF87a") || at(0, b"GIF89a"),
        "image/bmp" => at(0, b"BM"),
        "image/tiff" => at(0, b"II\x2a\0") || at(0, b"MM\0\x2a"),
        "video/mp4" | "video/x-m4v" | "audio/mp4" => at(4, b"ftyp"),
        "video/quicktime" => [b"ftyp", b"moov", b"mdat", b"wide", b"free"].iter().any(|s| at(4, *s)),
        "video/x-msvideo" => at(0, b"RIFF") && at(8, b"AVI "),
        "video/webm" | "video/x-matroska" | "audio/webm" => at(0, b"\x1a\x45\xdf\xa3"),
        "audio/wav" => at(0, b"RIFF") && at(8, b"WAVE"),
        "audio/mpeg" => at(0, b"ID3") || (b.first() == Some(&255) && b.get(1).is_some_and(|v| v & 0xe0 == 0xe0)),
        "audio/flac" => at(0, b"fLaC"),
        "audio/ogg" => at(0, b"OggS"),
        _ => false,
    }
}

/// Inspect audio containers without loading the whole upload in memory.
/// Packet durations are counted when the container has no declared duration.
pub(super) fn audio(path: &Path, mime: &str) -> Result<(), ApiError> {
    use symphonia::core::{
        formats::{TrackType, probe::Hint},
        io::MediaSourceStream,
    };
    let bad = || refused("inputInvalid");
    if mime == "audio/wav" {
        wave(path)?;
    }
    let file = std::fs::File::open(path).map_err(|_| refused("inputStorage"))?;
    let mut format = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            MediaSourceStream::new(Box::new(file), Default::default()),
            Default::default(),
            Default::default(),
        )
        .map_err(|_| bad())?;
    if format.default_track(TrackType::Video).is_some() {
        return Err(bad());
    }
    let track = format.default_track(TrackType::Audio).ok_or_else(bad)?;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or_else(bad)?;
    if !params.sample_rate.is_some_and(|r| (8000..=384000).contains(&r))
        || !params.channels.as_ref().is_some_and(|c| (1..=32).contains(&c.count()))
        || params.bits_per_sample.is_some_and(|b| !(1..=64).contains(&b))
    {
        return Err(bad());
    }
    if params.codec == symphonia::core::codecs::audio::CODEC_ID_NULL_AUDIO
        || (mime == "audio/mpeg" && params.codec != symphonia::core::codecs::audio::well_known::CODEC_ID_MP3)
    {
        return Err(bad());
    }
    let id = track.id;
    let base = track.time_base.ok_or_else(bad)?;
    let mut seconds = 0.0;
    while let Some(packet) = format.next_packet().map_err(|_| bad())? {
        if packet.track_id != id {
            continue;
        }
        let t = base.calc_duration(packet.dur).ok_or_else(bad)?;
        seconds += t.as_secs_f64();
        if seconds > 3600.0 {
            return Err(bad());
        }
    }
    if seconds <= 0.0 || !seconds.is_finite() {
        return Err(bad());
    }
    Ok(())
}

/// VibeValley's inspectWave: RIFF lengths, PCM layout and data alignment.
fn wave(path: &Path) -> Result<(), ApiError> {
    use std::io::{Read, Seek, SeekFrom};
    let bad = || refused("inputInvalid");
    let mut file = std::fs::File::open(path).map_err(|_| bad())?;
    let size = file.metadata().map_err(|_| bad())?.len();
    let mut header = [0; 12];
    file.read_exact(&mut header).map_err(|_| bad())?;
    let u32_at = |b: &[u8], n: usize| u32::from_le_bytes(b[n..n + 4].try_into().unwrap());
    let u16_at = |b: &[u8], n: usize| u16::from_le_bytes(b[n..n + 2].try_into().unwrap());
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" || u32_at(&header, 4) as u64 + 8 != size {
        return Err(bad());
    }
    let mut offset = 12;
    let mut block = 0;
    let mut data = false;
    while offset < size {
        file.seek(SeekFrom::Start(offset)).map_err(|_| bad())?;
        let mut chunk = [0; 8];
        file.read_exact(&mut chunk).map_err(|_| bad())?;
        let len = u32_at(&chunk, 4) as u64;
        let end = offset + 8 + len + len % 2;
        if end > size {
            return Err(bad());
        }
        if &chunk[..4] == b"fmt " {
            if block != 0 || !(16..=40).contains(&len) {
                return Err(bad());
            }
            let mut fmt = vec![0; len as usize];
            file.read_exact(&mut fmt).map_err(|_| bad())?;
            if len != 16 && (len < 18 || u16_at(&fmt, 16) as u64 != len - 18) {
                return Err(bad());
            }
            let mut encoding = u16_at(&fmt, 0);
            let channels = u16_at(&fmt, 2);
            let rate = u32_at(&fmt, 4);
            let bits = u16_at(&fmt, 14);
            if encoding == 0xfffe {
                if len != 40 || u16_at(&fmt, 18) == 0 || u16_at(&fmt, 18) > bits || fmt[26..40] != [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113] {
                    return Err(bad());
                }
                encoding = u16_at(&fmt, 24);
            }
            if ![1, 3].contains(&encoding)
                || !(1..=8).contains(&channels)
                || !(8000..=192000).contains(&rate)
                || (encoding == 1 && ![8, 16, 24, 32].contains(&bits))
                || (encoding == 3 && bits != 32)
            {
                return Err(bad());
            }
            block = channels as u64 * bits as u64 / 8;
            if u16_at(&fmt, 12) as u64 != block || u32_at(&fmt, 8) as u64 != rate as u64 * block {
                return Err(bad());
            }
        } else if &chunk[..4] == b"data" {
            if data || block == 0 || len == 0 || !len.is_multiple_of(block) {
                return Err(bad());
            }
            data = true;
        }
        offset = end;
    }
    if !data {
        return Err(bad());
    }
    Ok(())
}
