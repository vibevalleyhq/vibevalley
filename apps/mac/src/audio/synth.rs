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

    let threshold = 10.0_f64.powf(-10.0 / 20.0);
    let attack = (-1.0 / (0.003 * RATE_F)).exp();
    let release = (-1.0 / (0.12 * RATE_F)).exp();
    let mut level = 0.0_f64;

    let data_bytes = (out.len() * 2) as u32;
    let mut wav = vibevalley_core::audio::wav_with_header_pcm16(RATE, 1, data_bytes);

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
