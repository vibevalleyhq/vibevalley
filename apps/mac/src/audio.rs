use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

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

static CALL_RESERVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct CallAudio;
impl Drop for CallAudio {
    fn drop(&mut self) {
        capture_stop();
        stop();
        CALL_RESERVED.store(false, std::sync::atomic::Ordering::Release);
    }
}

pub fn reserve_for_call() -> Result<CallAudio, String> {
    use std::sync::atomic::Ordering;
    if CALL_RESERVED.swap(true, Ordering::AcqRel) {
        return Err("audio is already reserved by a call".into());
    }
    let lease = CallAudio;
    let (sent, received) = flume::bounded(1);
    worker()
        .send(Box::new(move || {
            let _ = sent.send(());
        }))
        .map_err(|_| "audio worker stopped")?;
    received.recv().map_err(|_| "audio worker stopped")?;
    Ok(lease)
}

pub fn dispatch<T: Serialize + 'static>(reply: crate::hosted::Replier, run: impl FnOnce() -> Result<T, String> + Send + 'static) {
    use vibevalley_server::transport::bridge::{BizCode, Envelope, refusal};
    let answer = reply.clone();
    if worker()
        .try_send(Box::new(move || {
            answer.send(
                match if CALL_RESERVED.load(std::sync::atomic::Ordering::Acquire) {
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
    // Shutdown waits for already accepted audio commands before stopping their output.
    if worker().send(Box::new(stop)).is_err() {
        stop();
    }
}

unsafe extern "C" {
    fn vv_audio_play(path: *const c_char, position: f64, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_play_data(bytes: *const u8, length: usize, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_seek(position: f64, error: *mut c_char, capacity: usize) -> bool;
    fn vv_audio_state(position: *mut f64, duration: *mut f64, playing: *mut bool, queued: *mut f64);
    fn vv_audio_stop();
    fn vv_pcm_start(rate: f64, channels: u32, error: *mut c_char, capacity: usize) -> bool;
    fn vv_pcm_append(bytes: *const u8, length: usize, error: *mut c_char, capacity: usize) -> bool;
    fn vv_pcm_completed() -> u64;
    fn vv_capture_start(error: *mut c_char, capacity: usize) -> bool;
    fn vv_capture_read(bytes: *mut u8, capacity: usize) -> isize;
    fn vv_capture_stop();
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    position: f64,
    duration: f64,
    playing: bool,
    pub queued_seconds: f64,
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
        queued_seconds: 0.0,
    };
    unsafe { vv_audio_state(&mut state.position, &mut state.duration, &mut state.playing, &mut state.queued_seconds) };
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

pub fn append_bytes(bytes: &[u8]) -> Result<(), String> {
    call(|error, capacity| unsafe { vv_pcm_append(bytes.as_ptr(), bytes.len(), error, capacity) })
}

pub fn completed_frames() -> u64 {
    unsafe { vv_pcm_completed() }
}

pub fn capture_start() -> Result<(), String> {
    call(|error, capacity| unsafe { vv_capture_start(error, capacity) })
}

pub fn capture_read() -> Result<Vec<u8>, String> {
    let mut bytes = vec![0; 640 * 10];
    let read = unsafe { vv_capture_read(bytes.as_mut_ptr(), bytes.len()) };
    if read < 0 {
        return Err("microphone audio overflowed or its format changed".into());
    }
    bytes.truncate(read as usize);
    Ok(bytes)
}

pub fn capture_stop() {
    unsafe { vv_capture_stop() };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundName {
    Tap,
    Nope,
    Pick,
    Open,
    Close,
    Water,
    Spray,
    Weed,
    Harvest,
    Shovel,
    Plant,
    Ripe,
    Bug,
    Coin,
    LevelUp,
    Achievement,
    Arrive,
    Rustle,
    Splash,
    Thud,
    Woof,
    Yip,
    Pant,
    Meow,
    Mew,
    Purr,
    VoiceOn,
    Ring,
    VoiceOff,
}

/// Plays a named synthesized UI sound from the in-memory WAV cache without disk I/O.
pub fn play_sound(name: SoundName) -> Result<(), String> {
    let bytes = cached_sound_wav(name);
    call(|error, capacity| unsafe { vv_audio_play_data(bytes.as_ptr(), bytes.len(), error, capacity) })
}

fn cached_sound_wav(name: SoundName) -> Arc<[u8]> {
    static CACHE: OnceLock<Mutex<HashMap<SoundName, Arc<[u8]>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(existing) = cache.lock().expect("sound cache lock").get(&name).cloned() {
        return existing;
    }
    let seed = (name as u32 + 1).wrapping_mul(2_654_435_761);
    let wav: Arc<[u8]> = synth::render_wav(name, seed).into();
    let mut guard = cache.lock().expect("sound cache lock");
    guard.entry(name).or_insert_with(|| wav.clone()).clone()
}

mod synth {
    use std::f64::consts::PI;

    use super::SoundName;

    pub(super) const RATE: u32 = 32_000;
    const RATE_F: f64 = RATE as f64;
    const START: f64 = 0.005;
    const VOLUME: f64 = 0.55;
    const BELL_PARTIALS: [(f64, f64); 4] = [(1.0, 1.0), (2.01, 0.42), (3.03, 0.18), (4.17, 0.09)];

    #[derive(Clone, Copy)]
    struct Shape {
        at: f64,
        dur: f64,
        gain: f64,
        attack: f64,
    }

    #[derive(Clone, Copy)]
    enum Wave {
        Sine,
        Square,
        Sawtooth,
        Triangle,
    }

    #[derive(Clone, Copy)]
    enum Filter {
        Lowpass,
        Highpass,
        Bandpass,
    }

    struct Tone {
        shape: Shape,
        freq: f64,
        to: Option<f64>,
        wave: Wave,
        lowpass: Option<f64>,
    }

    struct Noise {
        shape: Shape,
        filter: Filter,
        freq: f64,
        to: Option<f64>,
        q: f64,
        seed: u32,
    }

    struct GrainSpec {
        at: f64,
        span: f64,
        count: usize,
        freq: f64,
        gain: f64,
        q: f64,
        filter: Filter,
    }

    impl Shape {
        const fn new(at: f64, dur: f64, gain: f64) -> Self {
            Self { at, dur, gain, attack: 0.005 }
        }

        const fn with_attack(mut self, attack: f64) -> Self {
            self.attack = attack;
            self
        }
    }

    enum Voice {
        Tone(Tone),
        Noise(Noise),
    }

    struct Rng(u32);

    impl Rng {
        fn new(seed: u32) -> Self {
            Self(if seed == 0 { 1 } else { seed })
        }

        fn next_u32(&mut self) -> u32 {
            let mut s = self.0;
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            self.0 = s;
            s
        }

        fn unit(&mut self) -> f64 {
            f64::from(self.next_u32() % 10_000) / 10_000.0
        }

        fn bipolar(&mut self) -> f64 {
            (f64::from(self.next_u32()) / f64::from(u32::MAX)) * 2.0 - 1.0
        }
    }

    struct Biquad {
        kind: Filter,
        q: f64,
        x1: f64,
        x2: f64,
        y1: f64,
        y2: f64,
    }

    impl Biquad {
        fn new(kind: Filter, q: f64) -> Self {
            Self {
                kind,
                q,
                x1: 0.0,
                x2: 0.0,
                y1: 0.0,
                y2: 0.0,
            }
        }

        fn process(&mut self, x: f64, freq: f64) -> f64 {
            let w0 = (2.0 * PI * freq.min(RATE_F / 2.0 - 1.0)) / RATE_F;
            let cos = w0.cos();
            let sin = w0.sin();
            let alpha = match self.kind {
                Filter::Bandpass => sin / (2.0 * self.q),
                Filter::Lowpass | Filter::Highpass => sin / (2.0 * 10.0_f64.powf(self.q / 20.0)),
            };
            let (b0, b1, b2) = match self.kind {
                Filter::Lowpass => {
                    let b1 = 1.0 - cos;
                    (b1 / 2.0, b1, b1 / 2.0)
                }
                Filter::Highpass => {
                    let b1 = -(1.0 + cos);
                    ((1.0 + cos) / 2.0, b1, (1.0 + cos) / 2.0)
                }
                Filter::Bandpass => (alpha, 0.0, -alpha),
            };
            let a0 = 1.0 + alpha;
            let a1 = -2.0 * cos;
            let a2 = 1.0 - alpha;
            let y = (b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2) / a0;
            self.x2 = self.x1;
            self.x1 = x;
            self.y2 = self.y1;
            self.y1 = y;
            y
        }
    }

    fn envelope(t: f64, shape: Shape) -> f64 {
        let a = shape.attack.min(shape.dur * 0.5);
        let peak = shape.gain.max(0.0002);
        if t < 0.0 {
            0.0
        } else if t < a {
            0.0001 * (peak / 0.0001).powf(t / a)
        } else if t < shape.dur {
            peak * (0.0001 / peak).powf((t - a) / (shape.dur - a))
        } else {
            0.0001
        }
    }

    fn glide(from: f64, to: Option<f64>, t: f64, dur: f64) -> f64 {
        match to {
            Some(target) if target != 0.0 => {
                if t >= dur {
                    target
                } else {
                    from * (target / from).powf(t / dur)
                }
            }
            _ => from,
        }
    }

    fn wave_sample(kind: Wave, phase: f64) -> f64 {
        let p = phase - phase.floor();
        match kind {
            Wave::Sine => (2.0 * PI * p).sin(),
            Wave::Square => {
                if p < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            Wave::Sawtooth => 2.0 * p - 1.0,
            Wave::Triangle => 1.0 - 4.0 * (p - 0.5).abs(),
        }
    }

    struct Pen {
        voices: Vec<Voice>,
        end: f64,
        rng: Rng,
    }

    impl Pen {
        fn new(seed: u32) -> Self {
            Self {
                voices: Vec::new(),
                end: 0.0,
                rng: Rng::new(seed),
            }
        }

        fn tone(&mut self, shape: Shape, freq: f64, to: Option<f64>, wave: Wave, lowpass: Option<f64>) {
            let stop = START + shape.at + shape.dur + 0.05;
            self.end = self.end.max(stop);
            self.voices.push(Voice::Tone(Tone {
                shape,
                freq,
                to,
                wave,
                lowpass,
            }));
        }

        fn noise(&mut self, shape: Shape, filter: Filter, freq: f64, to: Option<f64>, q: f64) {
            let stop = START + shape.at + shape.dur + 0.05;
            self.end = self.end.max(stop);
            // Advance recipe RNG once per noise voice to preserve draw order, and seed the voice's white noise.
            let _ = self.rng.unit();
            let seed = self.rng.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223) | 1;
            self.voices.push(Voice::Noise(Noise {
                shape,
                filter,
                freq,
                to,
                q,
                seed,
            }));
        }

        fn bell(&mut self, at: f64, freq: f64, dur: f64, gain: f64) {
            for (ratio, weight) in BELL_PARTIALS {
                self.tone(
                    Shape::new(at, dur / ratio.sqrt(), gain * weight).with_attack(0.002),
                    freq * ratio,
                    None,
                    Wave::Sine,
                    None,
                );
            }
        }

        fn grains(&mut self, spec: GrainSpec) {
            for _ in 0..spec.count {
                let f = spec.freq * (0.8 + self.rng.unit() * 0.5);
                let start = spec.at + self.rng.unit() * spec.span;
                let dur = 0.03 + self.rng.unit() * 0.05;
                let g = spec.gain * (0.6 + self.rng.unit() * 0.4);
                self.noise(Shape::new(start, dur, g), spec.filter, f, None, spec.q);
            }
        }
    }

    fn compose(name: SoundName, pen: &mut Pen) {
        match name {
            SoundName::Tap => {
                pen.tone(Shape::new(0.0, 0.06, 1.9), 620.0, Some(480.0), Wave::Triangle, None);
                pen.noise(Shape::new(0.0, 0.025, 0.59), Filter::Highpass, 3000.0, None, 1.0);
            }
            SoundName::Nope => {
                pen.tone(Shape::new(0.0, 0.09, 0.42), 180.0, Some(140.0), Wave::Sine, None);
                pen.noise(Shape::new(0.0, 0.06, 0.23), Filter::Lowpass, 500.0, None, 1.0);
                pen.tone(Shape::new(0.11, 0.11, 0.38), 150.0, Some(115.0), Wave::Sine, None);
                pen.noise(Shape::new(0.11, 0.07, 0.19), Filter::Lowpass, 420.0, None, 1.0);
            }
            SoundName::Pick => {
                pen.noise(Shape::new(0.0, 0.035, 4.24), Filter::Bandpass, 1900.0, None, 5.0);
                pen.tone(Shape::new(0.0, 0.05, 1.55), 880.0, Some(700.0), Wave::Sine, None);
                pen.noise(Shape::new(0.05, 0.03, 1.93), Filter::Bandpass, 1500.0, None, 5.0);
            }
            SoundName::Open => {
                pen.noise(Shape::new(0.0, 0.22, 0.72).with_attack(0.08), Filter::Bandpass, 700.0, Some(2600.0), 1.4);
            }
            SoundName::Close => {
                pen.noise(Shape::new(0.0, 0.2, 0.62).with_attack(0.05), Filter::Bandpass, 2400.0, Some(650.0), 1.4);
            }
            SoundName::Water => {
                pen.noise(Shape::new(0.0, 0.75, 0.53).with_attack(0.12), Filter::Bandpass, 900.0, Some(1500.0), 1.1);
                pen.noise(Shape::new(0.0, 0.6, 0.1).with_attack(0.1), Filter::Highpass, 5000.0, None, 1.0);
                for _ in 0..6 {
                    let at = 0.15 + pen.rng.unit() * 0.6;
                    let freq = 1100.0 + pen.rng.unit() * 900.0;
                    pen.tone(Shape::new(at, 0.06, 0.23), freq, Some(freq * 0.55), Wave::Sine, None);
                }
            }
            SoundName::Spray => {
                for at in [0.0, 0.22] {
                    pen.noise(Shape::new(at, 0.17, 0.23).with_attack(0.01), Filter::Highpass, 3800.0, None, 1.0);
                    pen.noise(Shape::new(at, 0.12, 0.1), Filter::Bandpass, 6500.0, None, 2.0);
                }
            }
            SoundName::Weed => {
                pen.tone(Shape::new(0.0, 0.12, 1.61), 210.0, Some(90.0), Wave::Sine, None);
                pen.grains(GrainSpec {
                    at: 0.04,
                    span: 0.22,
                    count: 7,
                    freq: 2600.0,
                    gain: 0.56,
                    q: 2.0,
                    filter: Filter::Bandpass,
                });
            }
            SoundName::Harvest => {
                pen.grains(GrainSpec {
                    at: 0.0,
                    span: 0.25,
                    count: 9,
                    freq: 3200.0,
                    gain: 0.16,
                    q: 2.0,
                    filter: Filter::Bandpass,
                });
                pen.bell(0.18, 1047.0, 0.6, 0.19);
                pen.bell(0.28, 1319.0, 0.7, 0.16);
            }
            SoundName::Shovel => {
                pen.noise(Shape::new(0.0, 0.16, 1.79).with_attack(0.004), Filter::Lowpass, 450.0, None, 1.0);
                pen.tone(Shape::new(0.0, 0.16, 1.49), 120.0, Some(55.0), Wave::Sine, None);
                pen.grains(GrainSpec {
                    at: 0.1,
                    span: 0.3,
                    count: 8,
                    freq: 900.0,
                    gain: 0.48,
                    q: 2.0,
                    filter: Filter::Lowpass,
                });
            }
            SoundName::Plant => {
                pen.tone(Shape::new(0.0, 0.09, 1.34), 320.0, Some(760.0), Wave::Sine, None);
                pen.noise(Shape::new(0.03, 0.06, 0.68), Filter::Lowpass, 600.0, None, 1.0);
            }
            SoundName::Ripe => {
                for (i, freq) in [1568.0, 2093.0, 2637.0].into_iter().enumerate() {
                    pen.bell(i as f64 * 0.07, freq, 0.45, 0.12);
                }
            }
            SoundName::Bug => {
                pen.tone(Shape::new(0.0, 0.32, 0.48).with_attack(0.02), 190.0, None, Wave::Sawtooth, Some(1100.0));
                pen.tone(Shape::new(0.0, 0.32, 0.38).with_attack(0.02), 196.0, None, Wave::Sawtooth, Some(1100.0));
                pen.tone(Shape::new(0.36, 0.2, 0.38).with_attack(0.02), 210.0, None, Wave::Sawtooth, Some(1000.0));
            }
            SoundName::Coin => {
                pen.tone(Shape::new(0.0, 0.08, 0.23), 988.0, None, Wave::Square, Some(4000.0));
                pen.tone(Shape::new(0.07, 0.25, 0.23), 1319.0, None, Wave::Square, Some(4500.0));
                pen.bell(0.07, 2637.0, 0.3, 0.11);
            }
            SoundName::LevelUp => {
                for (i, freq) in [523.0, 659.0, 784.0, 1047.0].into_iter().enumerate() {
                    pen.tone(Shape::new(i as f64 * 0.09, 0.24, 0.23), freq, None, Wave::Triangle, None);
                }
                pen.bell(0.38, 1047.0, 1.1, 0.16);
                pen.bell(0.38, 1319.0, 1.1, 0.12);
                pen.bell(0.38, 1568.0, 1.1, 0.1);
            }
            SoundName::Achievement => {
                pen.bell(0.0, 784.0, 0.6, 0.21);
                pen.bell(0.12, 1175.0, 0.9, 0.21);
                pen.grains(GrainSpec {
                    at: 0.15,
                    span: 0.35,
                    count: 6,
                    freq: 7000.0,
                    gain: 0.064,
                    q: 4.0,
                    filter: Filter::Bandpass,
                });
            }
            SoundName::Arrive => {
                pen.tone(Shape::new(0.0, 0.08, 0.48), 440.0, Some(520.0), Wave::Triangle, None);
                pen.tone(Shape::new(0.09, 0.1, 0.43), 660.0, Some(760.0), Wave::Triangle, None);
            }
            SoundName::Rustle => {
                pen.grains(GrainSpec {
                    at: 0.0,
                    span: 0.18,
                    count: 8,
                    freq: 3000.0,
                    gain: 0.5,
                    q: 2.0,
                    filter: Filter::Bandpass,
                });
                pen.grains(GrainSpec {
                    at: 0.05,
                    span: 0.15,
                    count: 4,
                    freq: 1800.0,
                    gain: 0.3,
                    q: 2.0,
                    filter: Filter::Bandpass,
                });
            }
            SoundName::Splash => {
                pen.tone(Shape::new(0.0, 0.09, 1.1), 720.0, Some(260.0), Wave::Sine, None);
                pen.noise(Shape::new(0.0, 0.12, 0.43), Filter::Bandpass, 1400.0, None, 1.2);
                pen.tone(Shape::new(0.12, 0.05, 0.3), 1300.0, Some(800.0), Wave::Sine, None);
                pen.tone(Shape::new(0.19, 0.05, 0.24), 1100.0, Some(700.0), Wave::Sine, None);
            }
            SoundName::Thud => {
                pen.tone(Shape::new(0.0, 0.09, 1.3), 150.0, Some(80.0), Wave::Sine, None);
                pen.noise(Shape::new(0.0, 0.08, 0.56), Filter::Lowpass, 700.0, None, 1.0);
            }
            SoundName::Woof => {
                pen.tone(Shape::new(0.0, 0.08, 0.44).with_attack(0.008), 560.0, Some(360.0), Wave::Sawtooth, Some(1500.0));
                pen.tone(Shape::new(0.13, 0.1, 0.41).with_attack(0.008), 620.0, Some(380.0), Wave::Sawtooth, Some(1500.0));
            }
            SoundName::Yip => {
                pen.tone(Shape::new(0.0, 0.09, 1.45), 900.0, Some(620.0), Wave::Sawtooth, Some(2400.0));
            }
            SoundName::Pant => {
                for (i, at) in [0.0, 0.12, 0.24].into_iter().enumerate() {
                    pen.noise(Shape::new(at, 0.08, 1.4), Filter::Bandpass, 1500.0 - i as f64 * 120.0, None, 1.6);
                }
            }
            SoundName::Meow => {
                pen.tone(Shape::new(0.0, 0.14, 0.5).with_attack(0.02), 620.0, Some(980.0), Wave::Triangle, Some(2600.0));
                pen.tone(Shape::new(0.13, 0.22, 0.45), 980.0, Some(560.0), Wave::Triangle, Some(2400.0));
            }
            SoundName::Mew => {
                pen.tone(Shape::new(0.0, 0.1, 0.5).with_attack(0.01), 1100.0, Some(1400.0), Wave::Triangle, Some(3000.0));
            }
            SoundName::Purr => {
                for i in 0..12 {
                    pen.noise(Shape::new(i as f64 * 0.045, 0.035, 1.6), Filter::Lowpass, 260.0, None, 1.0);
                }
            }
            SoundName::VoiceOn => {
                pen.bell(0.0, 659.0, 0.35, 0.19);
                pen.bell(0.12, 988.0, 0.5, 0.19);
            }
            SoundName::Ring => {
                for at in [0.0, 0.42] {
                    for i in 0..8 {
                        pen.bell(at + i as f64 * 0.04, if i % 2 == 1 { 1320.0 } else { 1480.0 }, 0.05, 0.07);
                    }
                }
            }
            SoundName::VoiceOff => {
                pen.bell(0.0, 988.0, 0.3, 0.19);
                pen.bell(0.12, 587.0, 0.45, 0.19);
            }
        }
    }

    pub(super) fn render_wav(name: SoundName, seed: u32) -> Vec<u8> {
        let mut pen = Pen::new(seed);
        compose(name, &mut pen);
        let len = ((pen.end + 0.02) * RATE_F).ceil() as usize;
        let mut out = vec![0.0_f64; len];

        for voice in pen.voices {
            match voice {
                Voice::Tone(tone) => {
                    let t0 = START + tone.shape.at;
                    let stop = t0 + tone.shape.dur + 0.05;
                    let from = (t0 * RATE_F).floor() as usize;
                    let to = ((stop * RATE_F).floor() as usize).min(out.len());
                    let mut filter = tone.lowpass.filter(|&lp| lp != 0.0).map(|lp| (Biquad::new(Filter::Lowpass, 1.0), lp));
                    let mut phase = 0.0_f64;
                    for (i, slot) in out.iter_mut().enumerate().take(to).skip(from) {
                        let t = i as f64 / RATE_F - t0;
                        phase += glide(tone.freq, tone.to, t, tone.shape.dur) / RATE_F;
                        let sample = wave_sample(tone.wave, phase);
                        let shaped = match &mut filter {
                            Some((f, lp)) => f.process(sample, *lp),
                            None => sample,
                        };
                        *slot += shaped * envelope(t, tone.shape);
                    }
                }
                Voice::Noise(noise) => {
                    let t0 = START + noise.shape.at;
                    let stop = t0 + noise.shape.dur + 0.05;
                    let from = (t0 * RATE_F).floor() as usize;
                    let to = ((stop * RATE_F).floor() as usize).min(out.len());
                    let mut filter = Biquad::new(noise.filter, noise.q);
                    let mut rng = Rng::new(noise.seed);
                    for (i, slot) in out.iter_mut().enumerate().take(to).skip(from) {
                        let t = i as f64 / RATE_F - t0;
                        let freq = glide(noise.freq, noise.to, t, noise.shape.dur);
                        *slot += filter.process(rng.bipolar(), freq) * envelope(t, noise.shape);
                    }
                }
            }
        }

        // Peak-follower soft limiter (-10 dB threshold, 6:1 ratio, 3 ms attack, 120 ms release).
        let threshold = 10.0_f64.powf(-10.0 / 20.0);
        let attack = (-1.0 / (0.003 * RATE_F)).exp();
        let release = (-1.0 / (0.12 * RATE_F)).exp();
        let mut level = 0.0_f64;

        let data_bytes = (out.len() * 2) as u32;
        let mut wav = Vec::with_capacity(44 + out.len() * 2);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&RATE.to_le_bytes());
        wav.extend_from_slice(&(RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());

        for sample in out {
            let x = sample * VOLUME;
            let a = x.abs();
            level = if a > level {
                attack * level + (1.0 - attack) * a
            } else {
                release * level + (1.0 - release) * a
            };
            let over = if level > threshold {
                (threshold * (level / threshold).powf(1.0 / 6.0)) / level
            } else {
                1.0
            };
            let clamped = (x * over).clamp(-1.0, 1.0);
            let pcm = (clamped * f64::from(i16::MAX)).round() as i16;
            wav.extend_from_slice(&pcm.to_le_bytes());
        }
        wav
    }
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

    #[test]
    fn synthesizes_and_caches_all_29_ui_sounds_as_valid_32khz_wavs() {
        let names = [
            "tap",
            "nope",
            "pick",
            "open",
            "close",
            "water",
            "spray",
            "weed",
            "harvest",
            "shovel",
            "plant",
            "ripe",
            "bug",
            "coin",
            "levelUp",
            "achievement",
            "arrive",
            "rustle",
            "splash",
            "thud",
            "woof",
            "yip",
            "pant",
            "meow",
            "mew",
            "purr",
            "voiceOn",
            "ring",
            "voiceOff",
        ];
        for raw in names {
            let name: SoundName = serde_json::from_value(serde_json::json!(raw)).unwrap_or_else(|e| panic!("{raw}: {e}"));
            let wav = cached_sound_wav(name);
            assert!(wav.len() > 44, "{raw} has samples");
            assert_eq!(&wav[0..4], b"RIFF", "{raw} RIFF header");
            assert_eq!(&wav[8..12], b"WAVE", "{raw} WAVE header");
            assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), synth::RATE, "{raw} 32kHz");
            let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize;
            assert_eq!(data_len + 44, wav.len(), "{raw} payload size matches header");
            let has_nonzero = wav[44..].as_chunks::<2>().0.iter().any(|&c| i16::from_le_bytes(c) != 0);
            assert!(has_nonzero, "{raw} should not be silent");
            // Second lookup hits the in-memory Arc cache.
            let again = cached_sound_wav(name);
            assert!(Arc::ptr_eq(&wav, &again), "{raw} should reuse cached buffer");
        }
    }
}
