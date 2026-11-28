//! Safe wrappers around VibeValley's native macOS CoreAudio/AVAudioEngine C shim.

use std::ffi::{CStr, CString, c_char};
use std::path::Path;

// SAFETY: Symbols are compiled and statically linked from `apps/mac/src/audio.m` via `build.rs`.
// Every error-returning entry writes a NUL-terminated UTF-8 message into `error[..capacity]`
// whenever it returns `false`.
unsafe extern "C" {
    fn vv_audio_play(path: *const c_char, position: f64, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_play_data(bytes: *const u8, length: usize, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_state(playing: *mut bool, queued: *mut f64);
    fn vv_audio_stop();
    fn vv_pcm_start(rate: f64, channels: u32, error: *mut c_char, capacity: usize) -> bool;
    fn vv_pcm_append(bytes: *const u8, length: usize, error: *mut c_char, capacity: usize) -> bool;
    fn vv_pcm_completed() -> u64;
    fn vv_capture_start(error: *mut c_char, capacity: usize) -> bool;
    fn vv_capture_read(bytes: *mut u8, capacity: usize) -> isize;
    fn vv_capture_stop();
}

fn call_with_error_buf(run: impl FnOnce(*mut c_char, usize) -> bool) -> Result<(), String> {
    let mut error = [0 as c_char; 1024];
    if run(error.as_mut_ptr(), error.len()) {
        return Ok(());
    }
    // SAFETY: The native audio shim always NUL-terminates this caller-owned `error` buffer on failure.
    Err(unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned())
}

pub fn play_file(path: &Path, seconds: f64) -> Result<(), String> {
    let c_path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    call_with_error_buf(|error, capacity| {
        // SAFETY: `c_path` is NUL-terminated and lives for the call; `error` points to `capacity` writable bytes.
        unsafe { vv_audio_play(c_path.as_ptr(), seconds, error, capacity) }
    })
}

pub fn play_data(bytes: &[u8]) -> Result<(), String> {
    call_with_error_buf(|error, capacity| {
        // SAFETY: `bytes` is a valid readable slice of length `bytes.len()`; `error` has `capacity` writable bytes.
        unsafe { vv_audio_play_data(bytes.as_ptr(), bytes.len(), error, capacity) }
    })
}

pub fn playback_state() -> (bool, f64) {
    let mut playing = false;
    let mut queued_seconds = 0.0;
    // SAFETY: Both out-pointers point to valid stack locals for the duration of the synchronous call.
    unsafe { vv_audio_state(&mut playing, &mut queued_seconds) };
    (playing, queued_seconds)
}

pub fn stop() {
    // SAFETY: Thread-safe native shim call requiring no caller pointers.
    unsafe { vv_audio_stop() };
}

pub fn pcm_start(sample_rate: u32, channels: u32) -> Result<(), String> {
    call_with_error_buf(|error, capacity| {
        // SAFETY: `error` points to `capacity` writable bytes for the duration of the call.
        unsafe { vv_pcm_start(f64::from(sample_rate), channels, error, capacity) }
    })
}

pub fn pcm_append(bytes: &[u8]) -> Result<(), String> {
    call_with_error_buf(|error, capacity| {
        // SAFETY: `bytes` is a valid readable slice of length `bytes.len()`; `error` has `capacity` writable bytes.
        unsafe { vv_pcm_append(bytes.as_ptr(), bytes.len(), error, capacity) }
    })
}

pub fn pcm_completed_frames() -> u64 {
    // SAFETY: Thread-safe atomic/locked counter read in the native audio shim.
    unsafe { vv_pcm_completed() }
}

pub fn capture_start() -> Result<(), String> {
    call_with_error_buf(|error, capacity| {
        // SAFETY: `error` points to `capacity` writable bytes for the duration of the call.
        unsafe { vv_capture_start(error, capacity) }
    })
}

pub fn capture_read(buf: &mut [u8]) -> isize {
    // SAFETY: `buf` is uniquely borrowed and writable for `buf.len()` bytes for the duration of the call.
    unsafe { vv_capture_read(buf.as_mut_ptr(), buf.len()) }
}

pub fn capture_stop() {
    // SAFETY: Thread-safe native shim call requiring no caller pointers.
    unsafe { vv_capture_stop() };
}
