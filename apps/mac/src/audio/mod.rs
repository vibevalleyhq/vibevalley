//! Host audio playback, microphone capture leases, and synthesized UI sound effects.
//!
//! Raw CoreAudio/AVAudioEngine FFI lives in `crate::platform::audio_ffi`.

#![forbid(unsafe_code)]

mod device;
mod synth;
#[cfg(test)]
mod tests;

pub use device::{
    CallAudio, CaptureAudio, PcmFormat, SoundName, append_bytes, capture_read, capture_start, capture_stop, completed_frames, dispatch, output_reserved,
    pcm16_rms_level, play, play_sound, reserve_capture, reserve_for_call, reserve_output, start_pcm, state, stop, stop_queued,
};
