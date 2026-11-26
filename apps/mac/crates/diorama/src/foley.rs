use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundKind {
    FoldUp,
    CardTap,
    HarvestStamp,
    PaperStep,
    HarvestChime,
    AlertSoft,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoleySpec {
    pub sample_rate: u32,
    pub master_gain: f32,
    pub sounds: BTreeMap<String, SoundRecipe>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundRecipe {
    pub duration_sec: f32,
    pub brush_center_hz: f32,
    pub brush_q: f32,
    pub crackle_count: usize,
    pub resonances_hz: [f32; 3],
    pub low_thump_hz: f32,
    pub low_thump_gain: f32,
}

impl Default for FoleySpec {
    fn default() -> Self {
        let mut sounds = BTreeMap::new();
        sounds.insert(
            "foldUp".into(),
            SoundRecipe {
                duration_sec: 0.24,
                brush_center_hz: 1150.0,
                brush_q: 0.95,
                crackle_count: 34,
                resonances_hz: [1480.0, 2650.0, 4100.0],
                low_thump_hz: 135.0,
                low_thump_gain: 0.18,
            },
        );
        sounds.insert(
            "cardTap".into(),
            SoundRecipe {
                duration_sec: 0.11,
                brush_center_hz: 1750.0,
                brush_q: 1.4,
                crackle_count: 14,
                resonances_hz: [1950.0, 3200.0, 4850.0],
                low_thump_hz: 180.0,
                low_thump_gain: 0.10,
            },
        );
        sounds.insert(
            "harvestStamp".into(),
            SoundRecipe {
                duration_sec: 0.18,
                brush_center_hz: 920.0,
                brush_q: 1.1,
                crackle_count: 22,
                resonances_hz: [1120.0, 2240.0, 3600.0],
                low_thump_hz: 110.0,
                low_thump_gain: 0.28,
            },
        );
        sounds.insert(
            "paperStep".into(),
            SoundRecipe {
                duration_sec: 0.08,
                brush_center_hz: 1450.0,
                brush_q: 1.2,
                crackle_count: 10,
                resonances_hz: [1680.0, 2900.0, 4400.0],
                low_thump_hz: 160.0,
                low_thump_gain: 0.06,
            },
        );
        sounds.insert(
            "harvestChime".into(),
            SoundRecipe {
                duration_sec: 0.36,
                brush_center_hz: 1200.0,
                brush_q: 1.3,
                crackle_count: 14,
                resonances_hz: [523.25, 659.25, 783.99],
                low_thump_hz: 140.0,
                low_thump_gain: 0.14,
            },
        );
        sounds.insert(
            "alertSoft".into(),
            SoundRecipe {
                duration_sec: 0.14,
                brush_center_hz: 620.0,
                brush_q: 1.6,
                crackle_count: 8,
                resonances_hz: [260.0, 390.0, 620.0],
                low_thump_hz: 115.0,
                low_thump_gain: 0.30,
            },
        );
        Self {
            sample_rate: 44100,
            master_gain: 0.72,
            sounds,
        }
    }
}

struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn bandpass(freq: f32, q: f32, sr: f32) -> Self {
        let w0 = std::f32::consts::TAU * freq.clamp(40.0, sr * 0.44) / sr;
        let cs = w0.cos();
        let al = w0.sin() / (2.0 * q.max(0.2));
        let a0 = 1.0 + al;
        Self {
            b0: al / a0,
            b1: 0.0,
            b2: -al / a0,
            a1: (-2.0 * cs) / a0,
            a2: (1.0 - al) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn lowpass(freq: f32, q: f32, sr: f32) -> Self {
        let w0 = std::f32::consts::TAU * freq.clamp(40.0, sr * 0.44) / sr;
        let cs = w0.cos();
        let al = w0.sin() / (2.0 * q.max(0.2));
        let a0 = 1.0 + al;
        let b0 = (1.0 - cs) * 0.5;
        Self {
            b0: b0 / a0,
            b1: (1.0 - cs) / a0,
            b2: b0 / a0,
            a1: (-2.0 * cs) / a0,
            a2: (1.0 - al) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Synthesizes a mono 16-bit PCM WAV file in memory: noise brush + fibre crackle bursts + 3 body resonances.
pub fn synthesize_wav(spec: &FoleySpec, kind: SoundKind, seed: u64) -> Vec<u8> {
    let key = match kind {
        SoundKind::FoldUp => "foldUp",
        SoundKind::CardTap => "cardTap",
        SoundKind::HarvestStamp => "harvestStamp",
        SoundKind::PaperStep => "paperStep",
        SoundKind::HarvestChime => "harvestChime",
        SoundKind::AlertSoft => "alertSoft",
    };
    let recipe = spec
        .sounds
        .get(key)
        .cloned()
        .or_else(|| FoleySpec::default().sounds.get(key).cloned())
        .unwrap_or_else(|| FoleySpec::default().sounds["cardTap"].clone());

    let sr = spec.sample_rate.max(8000);
    let n = ((recipe.duration_sec * sr as f32).round() as usize).max(256);

    let mut state = seed ^ 0xA5A5_1337_DEAD_BEEFu64;
    let mut rand_f = || -> f32 {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^= z >> 31;
        ((z >> 40) as f32 / ((1u64 << 24) as f32)) * 2.0 - 1.0
    };

    let pitch = 1.0 + rand_f() * 0.09;
    let mut crackle = vec![0.0f32; n];
    for _ in 0..recipe.crackle_count {
        let t_norm = ((rand_f() * 0.5 + 0.5).powf(1.5)) * 0.85;
        let idx = ((t_norm * n as f32) as usize).min(n - 1);
        let burst_len = (((0.0003 + (rand_f() * 0.5 + 0.5) * 0.0011) * sr as f32) as usize).max(4);
        let amp = 0.5 + (rand_f() * 0.5 + 0.5) * 0.7;
        for k in 0..burst_len {
            if idx + k >= n {
                break;
            }
            let env = (k as f32 / burst_len as f32 * std::f32::consts::PI).sin();
            crackle[idx + k] += rand_f() * env * amp;
        }
    }

    let mut bp_brush = Biquad::bandpass(recipe.brush_center_hz * pitch, recipe.brush_q, sr as f32);
    let mut bp_r0 = Biquad::bandpass(recipe.resonances_hz[0] * pitch, 2.6, sr as f32);
    let mut bp_r1 = Biquad::bandpass(recipe.resonances_hz[1] * pitch, 2.8, sr as f32);
    let mut bp_r2 = Biquad::bandpass(recipe.resonances_hz[2] * pitch, 3.0, sr as f32);
    let mut lp_low = Biquad::lowpass(recipe.low_thump_hz * pitch, 1.4, sr as f32);
    let mut lp_out = Biquad::lowpass(6200.0, 0.7, sr as f32);

    let mut samples = Vec::with_capacity(n);
    for (i, &cr) in crackle.iter().enumerate().take(n) {
        let t = i as f32 / n as f32;
        let t_sec = i as f32 / sr as f32;
        let atk = (i as f32 / (sr as f32 * 0.004)).min(1.0);
        let decay = (1.0 - t).powf(1.65);
        let env = atk * decay;
        let noise = rand_f();
        let brush = bp_brush.process(noise) * env * 0.52;
        let body = (bp_r0.process(cr) * 0.55 + bp_r1.process(cr) * 0.35 + bp_r2.process(cr) * 0.25) + cr * 0.14;
        let thump_env = (-t * 24.0).exp() * atk;
        let thump = lp_low.process(noise) * thump_env * recipe.low_thump_gain * 3.0;
        let melodic = match kind {
            SoundKind::HarvestChime => {
                // Warm Jiangnan pentatonic bamboo-marimba double chime (G5 -> C6)
                let note1 = (std::f32::consts::TAU * 783.99 * pitch * t_sec).sin() * (-t_sec * 11.5).exp() * atk;
                let t2 = (t_sec - 0.075).max(0.0);
                let gate2 = if t_sec >= 0.075 { 1.0 } else { 0.0 };
                let note2 = (std::f32::consts::TAU * 1046.50 * pitch * t2).sin() * (-t2 * 9.5).exp() * gate2;
                let overtone = (std::f32::consts::TAU * 1567.98 * pitch * t2).sin() * (-t2 * 16.0).exp() * gate2 * 0.22;
                note1 * 0.34 + note2 * 0.38 + overtone
            }
            SoundKind::AlertSoft => {
                // Soft muted woodblock double-knock for invalid editor placement
                let k1 = (std::f32::consts::TAU * 235.0 * t_sec).sin() * (-t_sec * 34.0).exp() * atk;
                let t2 = (t_sec - 0.055).max(0.0);
                let gate2 = if t_sec >= 0.055 { 1.0 } else { 0.0 };
                let k2 = (std::f32::consts::TAU * 196.0 * t2).sin() * (-t2 * 30.0).exp() * gate2;
                k1 * 0.32 + k2 * 0.28
            }
            _ => 0.0,
        };
        let raw = lp_out.process(brush + body + thump + melodic) * spec.master_gain;
        let clipped = (raw / (1.0 + raw.abs() * 0.65)).clamp(-0.98, 0.98);
        samples.push((clipped * i16::MAX as f32).round() as i16);
    }

    let data_bytes = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    wav.extend_from_slice(&1u16.to_le_bytes()); // Mono
    wav.extend_from_slice(&sr.to_le_bytes());
    wav.extend_from_slice(&(sr * 2).to_le_bytes()); // Byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // Block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // Bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    for s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_valid_wav_header_and_nonzero_pcm() {
        for kind in [SoundKind::FoldUp, SoundKind::HarvestChime, SoundKind::AlertSoft] {
            let wav = synthesize_wav(&FoleySpec::default(), kind, 123);
            assert_eq!(&wav[0..4], b"RIFF");
            assert_eq!(&wav[8..12], b"WAVE");
            assert!(wav.len() > 2000);
            let peak = wav[44..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes([c[0], c[1]]).abs())
                .max()
                .unwrap_or(0);
            assert!(peak > 500, "paper foley too quiet for {kind:?}: peak={peak}");
        }
    }
}
