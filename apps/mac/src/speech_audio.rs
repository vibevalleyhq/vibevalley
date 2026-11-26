use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::HostSpeechAudioPhase as Phase;
pub use vibevalley_protocol::HostSpeechAudioState as State;
use vibevalley_protocol::MediaSpeechEvent;
use vibevalley_server::gateway::api::media::{SharedSpeechStreams, SpeechClaim};

#[derive(Default)]
struct Playback {
    state: State,
    cancel: Option<CancellationToken>,
    owner: String,
}
fn playback() -> &'static Mutex<Playback> {
    static PLAYBACK: OnceLock<Mutex<Playback>> = OnceLock::new();
    PLAYBACK.get_or_init(Default::default)
}
pub fn state(owner: &str) -> State {
    let current = playback().lock();
    if current.owner == owner { current.state.clone() } else { State::default() }
}

struct Claim(SpeechClaim);
impl Drop for Claim {
    fn drop(&mut self) {
        let gone = std::mem::replace(&mut self.0.gone, Box::new(|| {}));
        gone();
    }
}

pub fn start(streams: SharedSpeechStreams, id: &str) -> Result<State, String> {
    let mut current = playback().lock();
    if current.state.phase != Phase::Idle {
        if current.owner == id {
            return Ok(current.state.clone());
        }
        return Err("speech playback is already active".into());
    }
    let claim = Claim(streams.claim(id).map_err(|e| e.message)?);
    let cancel = CancellationToken::new();
    current.cancel = Some(cancel.clone());
    current.owner = id.to_string();
    current.state = State {
        phase: Phase::Playing,
        problem: None,
    };
    let initial = current.state.clone();
    drop(current);
    vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
        let reserved = tokio::task::spawn_blocking(crate::audio::reserve_for_call)
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
        let result = match reserved {
            Ok(lease) => {
                let outcome = play(claim, cancel, &mut Native, || {
                    playback().lock().state.phase = Phase::Draining;
                })
                .await;
                // Release CoreAudio lease off the Tokio worker thread.
                let _ = tokio::task::spawn_blocking(move || drop(lease)).await;
                outcome
            }
            Err(err) => Err(err),
        };
        let mut current = playback().lock();
        current.cancel = None;
        current.state = State {
            phase: Phase::Idle,
            problem: result.err(),
        };
    });
    Ok(initial)
}

pub fn stop(owner: Option<&str>) -> State {
    let mut playback = playback().lock();
    if owner.is_some_and(|id| id != playback.owner) {
        return State::default();
    }
    if let Some(cancel) = playback.cancel.take() {
        cancel.cancel();
        playback.state.phase = Phase::Stopping;
    }
    playback.state.clone()
}

trait Output {
    fn format(&mut self, rate: u32, channels: u32) -> Result<(), String>;
    fn queued_seconds(&self) -> Result<f64, String>;
    fn append(&mut self, bytes: &[u8]) -> Result<(), String>;
}
struct Native;
impl Output for Native {
    fn format(&mut self, rate: u32, channels: u32) -> Result<(), String> {
        crate::audio::start_pcm(crate::audio::PcmFormat { sample_rate: rate, channels })
    }
    fn queued_seconds(&self) -> Result<f64, String> {
        let seconds = crate::audio::state().queued_seconds;
        if seconds < 0.0 {
            Err("the audio output device stopped".into())
        } else {
            Ok(seconds)
        }
    }
    fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        crate::audio::append_bytes(bytes)
    }
}

async fn wait_capacity(cancel: &CancellationToken, output: &impl Output, seconds: f64) -> Result<bool, String> {
    while output.queued_seconds()? + seconds > 5.0 {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(false),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
    Ok(!cancel.is_cancelled())
}
async fn play(mut claim: Claim, cancel: CancellationToken, output: &mut impl Output, draining: impl Fn()) -> Result<(), String> {
    let mut format = None;
    let mut sequence = 0;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let event = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(()),
            res = claim.0.events.recv() => match res {
                Some(ev) => ev,
                None => {
                    return if cancel.is_cancelled() {
                        Ok(())
                    } else {
                        Err("speech stream ended without completion".into())
                    };
                }
            },
        };
        match serde_json::from_value::<MediaSpeechEvent>(event).map_err(|e| e.to_string())? {
            MediaSpeechEvent::Format {
                sample_rate,
                channels,
                bit_depth,
            } => {
                if format.is_some() || bit_depth != 16 {
                    return Err("invalid speech PCM format".into());
                }
                let rate = u32::try_from(sample_rate).map_err(|e| e.to_string())?;
                let channels = u32::try_from(channels).map_err(|e| e.to_string())?;
                crate::audio::PcmFormat { sample_rate: rate, channels }.validate()?;
                output.format(rate, channels)?;
                format = Some((rate, channels));
            }
            MediaSpeechEvent::Audio { sequence: next, audio } => {
                let (rate, channels) = format.ok_or("speech audio arrived before its format")?;
                if next != sequence || audio.len() > 2 << 20 {
                    return Err("invalid or out-of-order speech audio".into());
                }
                sequence += 1;
                let bytes = base64::engine::general_purpose::STANDARD.decode(audio).map_err(|e| e.to_string())?;
                let block = channels as usize * 2;
                if bytes.is_empty() || bytes.len() % block != 0 {
                    return Err("speech chunk contains an incomplete sample frame".into());
                }
                // A provider chunk may exceed the playback window; feed it in 100 ms pieces.
                let size = (rate as usize / 10) * block;
                for piece in bytes.chunks(size) {
                    let seconds = piece.len() as f64 / (f64::from(rate) * block as f64);
                    if !wait_capacity(&cancel, output, seconds).await? {
                        return Ok(());
                    }
                    output.append(piece)?;
                }
            }
            MediaSpeechEvent::Done {} => {
                if format.is_none() {
                    return Err("speech completed without a format".into());
                }
                draining();
                while output.queued_seconds()? > 0.0 {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Ok(()),
                        _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                    }
                }
                return Ok(());
            }
            MediaSpeechEvent::Failed {} => return Err("speech generation failed".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    struct OutputProbe {
        queued: Mutex<f64>,
        bytes: usize,
        drain: Arc<AtomicBool>,
        full: Option<tokio::sync::mpsc::Sender<()>>,
    }
    impl Output for OutputProbe {
        fn format(&mut self, _: u32, _: u32) -> Result<(), String> {
            Ok(())
        }
        fn queued_seconds(&self) -> Result<f64, String> {
            let mut slot = self.queued.lock();
            let queued = *slot;
            if queued >= 4.99
                && let Some(full) = &self.full
            {
                let _ = full.try_send(());
            }
            if self.drain.load(Ordering::SeqCst) || (self.full.is_none() && queued >= 4.99) {
                *slot = (queued - 1.0).max(0.0);
            }
            Ok(queued)
        }
        fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
            let mut slot = self.queued.lock();
            assert!(*slot + bytes.len() as f64 / 16000.0 <= 5.000001);
            *slot += bytes.len() as f64 / 16000.0;
            self.bytes += bytes.len();
            Ok(())
        }
    }
    fn claim() -> (Claim, tokio::sync::mpsc::Sender<serde_json::Value>, Arc<AtomicBool>) {
        let (send, events) = tokio::sync::mpsc::channel(16);
        let gone = Arc::new(AtomicBool::new(false));
        let receipt = gone.clone();
        (
            Claim(SpeechClaim {
                events,
                gone: Box::new(move || {
                    receipt.store(true, Ordering::SeqCst);
                }),
            }),
            send,
            gone,
        )
    }
    #[test]
    fn regression_a_ten_second_burst_waits_for_playback_capacity_then_drains() {
        vibevalley_runtime::rt::block_on(async {
            let (claim, send, gone) = claim();
            let cancel = CancellationToken::new();
            send.send(json!({"type":"format","sampleRate":8000,"channels":1,"bitDepth":16})).await.unwrap();
            send.send(json!({"type":"audio","sequence":0,"audio":base64::engine::general_purpose::STANDARD.encode(vec![0;160000])}))
                .await
                .unwrap();
            send.send(json!({"type":"done"})).await.unwrap();
            let mut output = OutputProbe {
                queued: Mutex::new(0.0),
                bytes: 0,
                drain: Arc::new(AtomicBool::new(false)),
                full: None,
            };
            let drain = output.drain.clone();
            let drained = AtomicUsize::new(0);
            play(claim, cancel, &mut output, || {
                drain.store(true, Ordering::SeqCst);
                drained.fetch_add(1, Ordering::SeqCst);
            })
            .await
            .unwrap();
            assert_eq!(output.bytes, 160000);
            assert_eq!(*output.queued.lock(), 0.0);
            assert_eq!(drained.load(Ordering::SeqCst), 1);
            assert!(gone.load(Ordering::SeqCst));
        });
    }
    #[test]
    fn regression_stop_interrupts_a_full_playback_window_and_releases_the_claim() {
        vibevalley_runtime::rt::block_on(async {
            let (claim, send, gone) = claim();
            let cancel = CancellationToken::new();
            send.send(json!({"type":"format","sampleRate":8000,"channels":1,"bitDepth":16})).await.unwrap();
            send.send(json!({"type":"audio","sequence":0,"audio":"AAAAAA=="})).await.unwrap();
            let (full, mut reached) = tokio::sync::mpsc::channel(1);
            let task_cancel = cancel.clone();
            let worker = tokio::spawn(async move {
                let mut output = OutputProbe {
                    queued: Mutex::new(5.0),
                    bytes: 0,
                    drain: Arc::new(AtomicBool::new(false)),
                    full: Some(full),
                };
                play(claim, task_cancel, &mut output, || {}).await.unwrap();
                output.bytes
            });
            tokio::time::timeout(Duration::from_secs(5), reached.recv()).await.unwrap().unwrap();
            cancel.cancel();
            assert_eq!(worker.await.unwrap(), 0);
            assert!(gone.load(Ordering::SeqCst));
        });
    }
}
