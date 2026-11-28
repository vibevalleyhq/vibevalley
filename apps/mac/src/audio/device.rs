use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::Serialize;

use crate::platform::audio_ffi;

use super::synth;

pub use vibevalley_protocol::HostSoundName as SoundName;

type AudioWork = Box<dyn FnOnce() + Send>;

pub(super) fn worker() -> &'static std::sync::mpsc::SyncSender<AudioWork> {
    static WORKER: std::sync::OnceLock<std::sync::mpsc::SyncSender<AudioWork>> = std::sync::OnceLock::new();
    WORKER.get_or_init(|| {
        let (send, receive) = std::sync::mpsc::sync_channel::<AudioWork>(64);
        std::thread::Builder::new()
            .name("audio-commands".into())
            .spawn(move || {
                for work in receive {
                    work();
                }
            })
            .expect("start audio command worker");
        send
    })
}

static CAPTURE_RESERVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static OUTPUT_RESERVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct CaptureAudio;
impl Drop for CaptureAudio {
    fn drop(&mut self) {
        capture_stop();
        CAPTURE_RESERVED.store(false, std::sync::atomic::Ordering::Release);
    }
}

pub struct OutputAudio;
impl Drop for OutputAudio {
    fn drop(&mut self) {
        stop();
        OUTPUT_RESERVED.store(false, std::sync::atomic::Ordering::Release);
    }
}

pub struct CallAudio {
    _capture: CaptureAudio,
    _output: OutputAudio,
}

fn flush_worker() -> Result<(), String> {
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    worker()
        .send(Box::new(move || {
            let _ = sent.send(());
        }))
        .map_err(|_| "audio worker stopped")?;
    received.recv().map_err(|_| "audio worker stopped")?;
    Ok(())
}

pub fn reserve_capture() -> Result<CaptureAudio, String> {
    use std::sync::atomic::Ordering;
    if CAPTURE_RESERVED.swap(true, Ordering::AcqRel) {
        return Err("microphone capture is already active".into());
    }
    Ok(CaptureAudio)
}

pub fn reserve_output() -> Result<OutputAudio, String> {
    use std::sync::atomic::Ordering;
    if OUTPUT_RESERVED.swap(true, Ordering::AcqRel) {
        return Err("audio is already reserved by a call".into());
    }
    let lease = OutputAudio;
    flush_worker()?;
    Ok(lease)
}

pub fn reserve_for_call() -> Result<CallAudio, String> {
    let _output = reserve_output()?;
    let _capture = reserve_capture()?;
    Ok(CallAudio { _capture, _output })
}

pub fn output_reserved() -> bool {
    OUTPUT_RESERVED.load(std::sync::atomic::Ordering::Acquire)
}

/// Computes normalized RMS amplitude in `0.0..=1.0` from signed 16-bit little-endian PCM bytes.
pub fn pcm16_rms_level(bytes: &[u8]) -> f64 {
    let samples = bytes.len() / 2;
    if samples == 0 {
        return 0.0;
    }
    let mut sum_sq = 0.0_f64;
    for chunk in bytes.as_chunks::<2>().0 {
        let s = f64::from(i16::from_le_bytes(*chunk)) / 32_768.0;
        sum_sq += s * s;
    }
    let rms = (sum_sq / samples as f64).sqrt();
    (rms * 4.0).clamp(0.0, 1.0)
}

pub fn dispatch<T: Serialize + 'static>(reply: crate::host_types::Replier, run: impl FnOnce() -> Result<T, String> + Send + 'static) {
    use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};
    let answer = reply.clone();
    if worker()
        .try_send(Box::new(move || {
            answer.send(
                match if OUTPUT_RESERVED.load(std::sync::atomic::Ordering::Acquire) {
                    Err("audio is reserved by the voice call".into())
                } else {
                    run()
                } {
                    Ok(value) => Envelope::ok(serde_json::json!(value)),
                    Err(error) => refusal(BizCode::InvalidInput, error),
                },
            )
        }))
        .is_err()
    {
        reply.send(refusal(BizCode::Refused, "audio command queue is full"));
    }
}

pub fn stop_queued() {
    if worker().send(Box::new(stop)).is_err() {
        stop();
    }
}

#[derive(Debug)]
pub struct Playback {
    #[cfg_attr(not(test), expect(dead_code))]
    pub playing: bool,
    pub queued_seconds: f64,
}

pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u32,
}

impl PcmFormat {
    pub fn validate(&self) -> Result<(), String> {
        if !(8_000..=192_000).contains(&self.sample_rate) || !(1..=2).contains(&self.channels) {
            return Err("PCM requires 8000–192000 Hz, mono or stereo signed 16-bit little-endian samples".into());
        }
        Ok(())
    }
}

pub(super) fn position(seconds: f64) -> Result<f64, String> {
    if seconds.is_finite() && seconds >= 0.0 {
        Ok(seconds)
    } else {
        Err("audio position must be finite and non-negative".into())
    }
}

pub fn play(path: &Path, seconds: f64) -> Result<(), String> {
    let seconds = position(seconds)?;
    if !path.is_absolute() || !path.is_file() {
        return Err("audio requires an absolute path to a regular file".into());
    }
    audio_ffi::play_file(path, seconds)
}

pub fn state() -> Playback {
    let (playing, queued_seconds) = audio_ffi::playback_state();
    Playback { playing, queued_seconds }
}

pub fn stop() {
    audio_ffi::stop();
}

pub fn start_pcm(format: PcmFormat) -> Result<(), String> {
    format.validate()?;
    audio_ffi::pcm_start(format.sample_rate, format.channels)
}

pub fn append_bytes(bytes: &[u8]) -> Result<(), String> {
    audio_ffi::pcm_append(bytes)
}

pub fn completed_frames() -> u64 {
    audio_ffi::pcm_completed_frames()
}

pub fn capture_start() -> Result<(), String> {
    audio_ffi::capture_start()
}

pub fn capture_read() -> Result<Vec<u8>, String> {
    let mut bytes = vec![0; 640 * 10];
    let read = audio_ffi::capture_read(&mut bytes);
    if read < 0 {
        return Err("microphone audio overflowed or its format changed".into());
    }
    bytes.truncate(read as usize);
    Ok(bytes)
}

pub fn capture_stop() {
    audio_ffi::capture_stop();
}

/// Plays a named synthesized UI sound from the in-memory WAV cache without disk I/O.
pub fn play_sound(name: SoundName) -> Result<(), String> {
    let bytes = cached_sound_wav(name);
    audio_ffi::play_data(&bytes)
}

pub(super) fn cached_sound_wav(name: SoundName) -> Arc<[u8]> {
    static CACHE: OnceLock<Mutex<HashMap<SoundName, Arc<[u8]>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(existing) = cache.lock().get(&name).cloned() {
        return existing;
    }
    let seed = (name as u32 + 1).wrapping_mul(2_654_435_761);
    let wav: Arc<[u8]> = synth::render_wav(name, seed).into();
    let mut guard = cache.lock();
    guard.entry(name).or_insert_with(|| wav.clone()).clone()
}
