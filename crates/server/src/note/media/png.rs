//! Generated PNG validation via `png` crate: CRC, dimensions, zlib stream, and trailing bytes.

pub fn valid(bytes: &[u8], width: i64, height: i64) -> bool {
    let (Ok(w), Ok(h)) = (u32::try_from(width), u32::try_from(height)) else {
        return false;
    };
    if w == 0 || h == 0 {
        return false;
    }
    let mut cursor = std::io::Cursor::new(bytes);
    let limits = png::Limits { bytes: 32 << 20 };
    let decoder = png::Decoder::new_with_limits(&mut cursor, limits);
    let Ok(mut reader) = decoder.read_info() else {
        return false;
    };
    let info = reader.info();
    if info.width != w || info.height != h {
        return false;
    }
    let Some(buf_len) = reader.output_buffer_size() else {
        return false;
    };
    if buf_len > (32 << 20) {
        return false;
    }
    let mut buf = vec![0; buf_len];
    if reader.next_frame(&mut buf).is_err() {
        return false;
    }
    if reader.finish().is_err() {
        return false;
    }
    drop(reader);
    cursor.position() == bytes.len() as u64
}

#[cfg(test)]
mod tests {
    use super::valid;

    #[test]
    fn original_png_dimensions_crc_and_complete_framing() {
        let bytes = include_bytes!("../../../tests/fixtures/media.png");
        assert!(valid(bytes, 256, 256));
        assert!(!valid(bytes, 512, 256));
        assert!(!valid(&bytes[..bytes.len() - 1], 256, 256));
        let mut trailing = bytes.to_vec();
        trailing.extend_from_slice(b"trailing");
        assert!(!valid(&trailing, 256, 256));
        let mut corrupt = bytes.to_vec();
        corrupt[50] ^= 1;
        assert!(!valid(&corrupt, 256, 256));
    }
}
