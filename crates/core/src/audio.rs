//! Shared PCM-16 WAV/RIFF container helpers.

/// Builds the 44-byte RIFF/WAVE header for uncompressed 16-bit signed PCM audio.
pub fn wav_header_pcm16(sample_rate: u32, channels: u16, data_bytes: u32) -> [u8; 44] {
    let block_align = channels.saturating_mul(2);
    let byte_rate = sample_rate.saturating_mul(u32::from(block_align));
    let riff_size = 36u32.saturating_add(data_bytes);
    let mut header = [0u8; 44];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&riff_size.to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes());
    header[22..24].copy_from_slice(&channels.to_le_bytes());
    header[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    header[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    header[32..34].copy_from_slice(&block_align.to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

/// Allocates a WAV buffer initialized with the 44-byte PCM16 header and room for `data_bytes` of PCM payload.
pub fn wav_with_header_pcm16(sample_rate: u32, channels: u16, data_bytes: u32) -> Vec<u8> {
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(&wav_header_pcm16(sample_rate, channels, data_bytes));
    wav
}

/// Encodes interleaved 16-bit signed PCM samples into a complete RIFF/WAVE buffer.
pub fn encode_wav_pcm16(sample_rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
    let data_bytes = (samples.len() * 2) as u32;
    let mut wav = wav_with_header_pcm16(sample_rate, channels, data_bytes);
    for &sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_pcm16_wav_header_and_samples() {
        let wav = encode_wav_pcm16(24_000, 1, &[0, 1000, -1000]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 50);
    }
}
