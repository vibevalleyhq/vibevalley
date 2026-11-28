use std::path::Path;
use std::sync::Arc;

use super::device::{cached_sound_wav, position, worker};
use super::synth;
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
    let (send, received) = std::sync::mpsc::channel();
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
    assert!(append_bytes(&[0, 0]).is_err());
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
        let again = cached_sound_wav(name);
        assert!(Arc::ptr_eq(&wav, &again), "{raw} should reuse cached buffer");
    }
}

#[test]
fn pcm16_rms_level_measures_silence_speech_and_clipping() {
    assert_eq!(pcm16_rms_level(&[]), 0.0);
    assert_eq!(pcm16_rms_level(&[0, 0, 0, 0]), 0.0);
    let mid = 4_096_i16.to_le_bytes();
    let level = pcm16_rms_level(&[mid[0], mid[1], mid[0], mid[1]]);
    assert!((level - 0.5).abs() < 1e-6, "got {level}");
    let peak = i16::MAX.to_le_bytes();
    assert_eq!(pcm16_rms_level(&[peak[0], peak[1]]), 1.0);
}

#[test]
fn capture_and_output_leases_only_conflict_when_call_holds_both() {
    let cap = reserve_capture().unwrap();
    assert!(reserve_capture().is_err());
    let out = reserve_output().unwrap();
    assert!(reserve_for_call().is_err());
    drop(out);
    drop(cap);
    let call = reserve_for_call().unwrap();
    assert!(reserve_capture().is_err());
    assert!(reserve_output().is_err());
    drop(call);
}
