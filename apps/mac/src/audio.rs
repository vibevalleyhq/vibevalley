use std::ffi::{CStr, CString, c_char};
use std::path::Path;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

type AudioWork = Box<dyn FnOnce() + Send>;

fn worker() -> &'static flume::Sender<AudioWork> {
    static WORKER: std::sync::OnceLock<flume::Sender<AudioWork>> = std::sync::OnceLock::new();
    WORKER.get_or_init(|| {
        let (send, receive) = flume::bounded::<AudioWork>(64);
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

pub fn dispatch<T: Serialize + 'static>(reply: crate::hosted::Replier, run: impl FnOnce() -> Result<T, String> + Send + 'static) {
    use vibevalley_bridge::{BizCode, Envelope, refusal};
    let answer = reply.clone();
    if worker()
        .try_send(Box::new(move || {
            answer.send(match run() {
                Ok(value) => Envelope::ok(serde_json::json!(value)),
                Err(error) => refusal(BizCode::InvalidInput, error),
            })
        }))
        .is_err()
    {
        reply.send(refusal(BizCode::Refused, "audio command queue is full"));
    }
}

pub fn stop_queued() {
    // Shutdown waits for already accepted audio commands before stopping their output.
    if worker().send(Box::new(stop)).is_err() {
        stop();
    }
}

unsafe extern "C" {
    fn vv_audio_play(path: *const c_char, position: f64, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_seek(position: f64, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_state(position: *mut f64, duration: *mut f64, playing: *mut bool);
    fn vv_audio_stop();
    fn vv_pcm_start(rate: f64, channels: u32, error: *mut c_char, capacity: usize) -> bool;
    fn vv_pcm_append(bytes: *const u8, length: usize, error: *mut c_char, capacity: usize) -> bool;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    position: f64,
    duration: f64,
    playing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

fn call(run: impl FnOnce(*mut c_char, usize) -> bool) -> Result<(), String> {
    let mut error = [0 as c_char; 1024];
    if run(error.as_mut_ptr(), error.len()) {
        return Ok(());
    }
    // The native adapter always NUL-terminates this caller-owned buffer.
    Err(unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned())
}

fn position(seconds: f64) -> Result<f64, String> {
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
    let path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    call(|error, capacity| unsafe { vv_audio_play(path.as_ptr(), seconds, error, capacity) })
}

pub fn seek(seconds: f64) -> Result<(), String> {
    let seconds = position(seconds)?;
    call(|error, capacity| unsafe { vv_audio_seek(seconds, error, capacity) })
}

pub fn state() -> Playback {
    let mut state = Playback {
        position: 0.0,
        duration: 0.0,
        playing: false,
    };
    unsafe { vv_audio_state(&mut state.position, &mut state.duration, &mut state.playing) };
    state
}

pub fn stop() {
    unsafe { vv_audio_stop() };
}

pub fn start_pcm(format: PcmFormat) -> Result<(), String> {
    format.validate()?;
    call(|error, capacity| unsafe { vv_pcm_start(f64::from(format.sample_rate), format.channels, error, capacity) })
}

pub fn append_pcm(data: &str) -> Result<(), String> {
    if data.len() > 2 << 20 {
        return Err("PCM chunk exceeds 2 MB of base64".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    call(|error, capacity| unsafe { vv_pcm_append(bytes.as_ptr(), bytes.len(), error, capacity) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regression_audio_positions_and_pcm_formats_are_validated_before_native_calls() {
        for n in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(position(n).is_err());
        }
        assert_eq!(position(1.25).unwrap(), 1.25);
        assert!(
            PcmFormat {
                sample_rate: 24_000,
                channels: 1
            }
            .validate()
            .is_ok()
        );
        for format in [
            PcmFormat { sample_rate: 0, channels: 1 },
            PcmFormat {
                sample_rate: 24_000,
                channels: 0,
            },
            PcmFormat {
                sample_rate: 24_000,
                channels: 3,
            },
        ] {
            assert!(format.validate().is_err());
        }
        assert!(play(Path::new("relative.wav"), 0.0).is_err());
    }

    #[test]
    fn regression_audio_commands_keep_the_order_the_host_accepted_them() {
        let (send, received) = flume::unbounded();
        for command in ["play", "stop", "play", "seek", "stop"] {
            let send = send.clone();
            worker()
                .send(Box::new(move || {
                    send.send(command).unwrap();
                }))
                .unwrap();
        }
        let got: Vec<_> = (0..5).map(|_| received.recv_timeout(std::time::Duration::from_secs(5)).unwrap()).collect();
        assert_eq!(got, ["play", "stop", "play", "seek", "stop"]);
    }

    #[test]
    fn regression_pcm_requires_start_and_complete_sample_frames() {
        stop();
        assert!(append_pcm("AA==").is_err());
        assert!(seek(0.0).is_err());
        assert!(!state().playing);
    }
}
