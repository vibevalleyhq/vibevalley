use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::HostAsrPhase as Phase;
pub use vibevalley_protocol::HostAsrState as State;
use vibevalley_server::gateway::api::SharedLiveVoice;

const MAX_BATCH_PCM_BYTES: usize = 16_000 * 2 * 120;

#[derive(Default)]
struct Dictation {
    state: State,
    stop: Option<CancellationToken>,
    owner: String,
}

fn dictation() -> &'static Mutex<Dictation> {
    static DICTATION: OnceLock<Mutex<Dictation>> = OnceLock::new();
    DICTATION.get_or_init(Default::default)
}

pub fn state(owner: &str) -> State {
    let current = dictation().lock();
    if current.owner == owner { current.state.clone() } else { State::default() }
}

pub fn start(voice: SharedLiveVoice, owner: String) -> Result<State, String> {
    if owner.is_empty() || owner.len() > 128 {
        return Err("dictation requires an owner ID".into());
    }
    let mut current = dictation().lock();
    if current.state.phase != Phase::Idle {
        if current.owner == owner {
            return Ok(current.state.clone());
        }
        return Err("speech dictation is already active".into());
    }
    let cancel = CancellationToken::new();
    current.state = State {
        phase: Phase::Connecting,
        ..State::default()
    };
    current.stop = Some(cancel.clone());
    current.owner = owner;
    let initial = current.state.clone();
    drop(current);
    vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
        let result = run(voice, cancel).await;
        let mut current = dictation().lock();
        if !current.state.partial.is_empty() {
            let partial = current.state.partial.clone();
            append_segment(&mut current.state.text, &partial);
            current.state.partial.clear();
        }
        current.state.phase = Phase::Idle;
        current.state.mic_level = 0.0;
        current.state.problem = result.err();
        current.stop = None;
    });
    Ok(initial)
}

pub fn stop(owner: Option<&str>) -> State {
    let mut current = dictation().lock();
    if owner.is_some_and(|id| id != current.owner) {
        return State::default();
    }
    if let Some(stop) = current.stop.take() {
        current.state.phase = Phase::Finishing;
        stop.cancel();
    }
    current.state.clone()
}

trait CaptureAudio {
    fn start(&mut self) -> Result<(), String>;
    fn microphone(&mut self) -> Result<Vec<u8>, String>;
    fn stop(&mut self);
}

struct HeldCapture<A: CaptureAudio>(A);
impl<A: CaptureAudio> Drop for HeldCapture<A> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

struct NativeCapture {
    _lease: crate::audio::CaptureAudio,
}

impl CaptureAudio for NativeCapture {
    fn start(&mut self) -> Result<(), String> {
        crate::audio::capture_start()
    }

    fn microphone(&mut self) -> Result<Vec<u8>, String> {
        crate::audio::capture_read()
    }

    fn stop(&mut self) {
        crate::audio::capture_stop();
    }
}

fn append_segment(target: &mut String, segment: &str) {
    let piece = segment.trim();
    if piece.is_empty() {
        return;
    }
    if target.is_empty() {
        target.push_str(piece);
        return;
    }
    let last = target.chars().last();
    let first = piece.chars().next();
    let needs_space = last.is_some_and(|ch| ch.is_ascii_alphanumeric()) && first.is_some_and(|ch| ch.is_ascii_alphanumeric());
    if needs_space {
        target.push(' ');
    }
    target.push_str(piece);
}

fn update_mic_level(raw_level: f64) {
    let mut current = dictation().lock();
    let prev = current.state.mic_level;
    let next = if raw_level <= 0.001 { prev * 0.45 } else { prev * 0.5 + raw_level * 0.5 };
    current.state.mic_level = if next < 0.005 { 0.0 } else { next };
}

fn pcm16_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len()).unwrap_or(u32::MAX);
    let block_align = channels.saturating_mul(2);
    let byte_rate = sample_rate.saturating_mul(u32::from(block_align));
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&data_len.saturating_add(36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

async fn run(voice: SharedLiveVoice, cancel: CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Ok(());
    }
    let setup_voice = voice.clone();
    let setup_cancel = cancel.clone();
    enum Setup {
        Cancelled,
        Stream(crate::audio::CaptureAudio, Box<dyn vibevalley_server::gateway::api::LiveVoiceLine>),
        Batch(crate::audio::CaptureAudio),
    }
    let setup = tokio::task::spawn_blocking(move || -> Result<Setup, String> {
        if setup_cancel.is_cancelled() {
            return Ok(Setup::Cancelled);
        }
        let capture = crate::audio::reserve_capture()?;
        if setup_cancel.is_cancelled() {
            return Ok(Setup::Cancelled);
        }
        match setup_voice.asr_line() {
            Ok(line) => Ok(Setup::Stream(capture, line)),
            Err(err) => {
                if setup_voice.can_transcribe() {
                    Ok(Setup::Batch(capture))
                } else {
                    Err(err.message)
                }
            }
        }
    })
    .await
    .map_err(|e| format!("ASR setup task panicked: {e}"))??;

    match setup {
        Setup::Cancelled => Ok(()),
        Setup::Stream(lease, line) => run_stream(lease, line, cancel).await,
        Setup::Batch(lease) => run_batch(lease, voice, cancel).await,
    }
}

async fn run_stream(
    lease: crate::audio::CaptureAudio,
    line: Box<dyn vibevalley_server::gateway::api::LiveVoiceLine>,
    cancel: CancellationToken,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Ok(());
    }
    let mut request = line.url().into_client_request().map_err(|_| "invalid MOSS address".to_string())?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", line.bearer_token())
            .parse()
            .map_err(|_| "invalid MOSS credentials".to_string())?,
    );
    let (socket, _) = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(request)) => {
            result.map_err(|_| "MOSS connection timed out".to_string())?.map_err(|_| "MOSS connection failed".to_string())?
        }
    };
    session(
        socket,
        line.session_update(),
        NativeCapture { _lease: lease },
        cancel,
        || {
            dictation().lock().state.phase = Phase::Listening;
        },
        update_mic_level,
        |event| {
            let mut current = dictation().lock();
            match event {
                TranscriptUpdate::Partial(delta) => current.state.partial.push_str(&delta),
                TranscriptUpdate::Done(done) => {
                    append_segment(&mut current.state.text, &done);
                    current.state.partial.clear();
                }
            }
        },
    )
    .await
}

async fn run_batch(lease: crate::audio::CaptureAudio, voice: SharedLiveVoice, cancel: CancellationToken) -> Result<(), String> {
    let mut audio = HeldCapture(NativeCapture { _lease: lease });
    audio.0.start()?;
    dictation().lock().state.phase = Phase::Listening;
    let mut pcm = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            _ = tick.tick() => {
                let bytes = audio.0.microphone()?;
                if !bytes.is_empty() {
                    update_mic_level(crate::audio::pcm16_rms_level(&bytes));
                    if pcm.len() + bytes.len() <= MAX_BATCH_PCM_BYTES {
                        pcm.extend_from_slice(&bytes);
                    } else {
                        break;
                    }
                }
            }
        }
    }
    drop(audio);
    if pcm.is_empty() {
        return Ok(());
    }
    dictation().lock().state.phase = Phase::Finishing;
    let wav = pcm16_to_wav(&pcm, 16_000, 1);
    let text = voice.transcribe_wav_async(wav).await.map_err(|e| e.message)?;
    append_segment(&mut dictation().lock().state.text, &text);
    Ok(())
}

#[derive(Deserialize)]
struct Attached {
    session_id: String,
    memory_scope: String,
    delegation: String,
}

#[derive(Deserialize)]
struct Updated {
    error: String,
}

#[derive(Deserialize)]
struct Transcript {
    #[serde(default)]
    text: String,
    #[serde(default)]
    delta: String,
}

#[derive(Deserialize)]
#[serde(tag = "action")]
enum Event {
    #[serde(rename = "session_attached")]
    Attached { data: Attached },
    #[serde(rename = "session.updated")]
    Updated { data: Updated },
    #[serde(rename = "input.transcript.delta")]
    InputDelta { data: Transcript },
    #[serde(rename = "input.transcript.done")]
    InputDone { data: Transcript },
    #[serde(rename = "session.closing")]
    Closing,
    #[serde(rename = "error")]
    Error,
    #[serde(other)]
    Other,
}

enum TranscriptUpdate {
    Partial(String),
    Done(String),
}

#[derive(Clone, Copy, PartialEq)]
enum Handshake {
    Attaching,
    Configuring,
    Listening,
}

async fn session<S, A: CaptureAudio>(
    socket: S,
    update: String,
    audio: A,
    cancel: CancellationToken,
    ready: impl Fn(),
    mut on_mic_level: impl FnMut(f64),
    mut on_transcript: impl FnMut(TranscriptUpdate),
) -> Result<(), String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let mut audio = HeldCapture(audio);
    let (mut writer, mut reader) = socket.split();
    async fn send<S>(writer: &mut S, cancel: &CancellationToken, message: Message) -> Result<(), String>
    where
        S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(String::new()),
            result = tokio::time::timeout(Duration::from_secs(5), writer.send(message)) => {
                result.map_err(|_| "MOSS send timed out".to_string())?.map_err(|_| "MOSS connection ended".to_string())
            }
        }
    }
    match send(&mut writer, &cancel, Message::text(r#"{"action":"attach_session","memory_scope":"session"}"#)).await {
        Ok(()) => {}
        Err(e) if e.is_empty() => return Ok(()),
        Err(e) => return Err(e),
    }
    let mut handshake = Handshake::Attaching;
    let deadline = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(deadline);
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                audio.0.stop();
                let _ = tokio::time::timeout(Duration::from_millis(500), writer.close()).await;
                return Ok(());
            }
            _ = &mut deadline, if handshake != Handshake::Listening => return Err("MOSS session setup timed out".into()),
            next = reader.next() => match next {
                Some(Ok(Message::Text(raw))) => {
                    if raw.len() > 64 * 1024 {
                        return Err("MOSS text frame is too large".into());
                    }
                    let event = serde_json::from_str::<Event>(&raw).map_err(|_| "invalid MOSS frame".to_string())?;
                    match event {
                        Event::Attached { data } => {
                            if handshake != Handshake::Attaching || data.session_id.is_empty() || data.memory_scope != "session" || data.delegation != "none" {
                                return Err("MOSS session options were refused".into());
                            }
                            handshake = Handshake::Configuring;
                            match send(&mut writer, &cancel, Message::text(update.clone())).await {
                                Ok(()) => {}
                                Err(e) if e.is_empty() => return Ok(()),
                                Err(e) => return Err(e),
                            }
                        }
                        Event::Updated { data } => {
                            if handshake != Handshake::Configuring || !data.error.is_empty() {
                                return Err("MOSS configuration was refused".into());
                            }
                            for frame in [
                                r#"{"action":"media.mode","binary_protocol":"tagged-v1"}"#,
                                r#"{"action":"mic_state","enabled":true}"#,
                            ] {
                                match send(&mut writer, &cancel, Message::text(frame)).await {
                                    Ok(()) => {}
                                    Err(e) if e.is_empty() => return Ok(()),
                                    Err(e) => return Err(e),
                                }
                            }
                            audio.0.start()?;
                            if cancel.is_cancelled() {
                                return Ok(());
                            }
                            handshake = Handshake::Listening;
                            ready();
                        }
                        Event::InputDelta { data } => {
                            let piece = if data.delta.is_empty() { data.text } else { data.delta };
                            if piece.len() <= 16_000 && !piece.is_empty() {
                                on_transcript(TranscriptUpdate::Partial(piece));
                            }
                        }
                        Event::InputDone { data } => {
                            if data.text.len() > 16_000 {
                                return Err("MOSS transcript is too large".into());
                            }
                            on_transcript(TranscriptUpdate::Done(data.text));
                        }
                        Event::Closing => return Ok(()),
                        Event::Error => return Err("MOSS refused the voice session".into()),
                        Event::Other => {}
                    }
                }
                Some(Ok(Message::Ping(bytes))) => match send(&mut writer, &cancel, Message::Pong(bytes)).await {
                    Ok(()) => {}
                    Err(e) if e.is_empty() => return Ok(()),
                    Err(e) => return Err(e),
                },
                Some(Ok(Message::Binary(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Err(_)) => return Err("MOSS connection failed".into()),
            },
            _ = tick.tick(), if handshake == Handshake::Listening => {
                let mic_bytes = audio.0.microphone()?;
                if !mic_bytes.is_empty() {
                    on_mic_level(crate::audio::pcm16_rms_level(&mic_bytes));
                }
                for frame in mic_bytes.as_chunks::<640>().0 {
                    let mut tagged = vec![0u8; 641];
                    tagged[1..].copy_from_slice(frame);
                    match send(&mut writer, &cancel, Message::Binary(tagged.into())).await {
                        Ok(()) => {}
                        Err(e) if e.is_empty() => return Ok(()),
                        Err(e) => return Err(e),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct SyntheticCapture {
        started: Arc<AtomicBool>,
        sent: bool,
    }

    impl CaptureAudio for SyntheticCapture {
        fn start(&mut self) -> Result<(), String> {
            self.started.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn microphone(&mut self) -> Result<Vec<u8>, String> {
            if self.sent {
                Ok(vec![])
            } else {
                self.sent = true;
                let mut pcm = vec![0u8; 640];
                let sample = 4_096_i16.to_le_bytes();
                for chunk in pcm.as_chunks_mut::<2>().0 {
                    *chunk = sample;
                }
                Ok(pcm)
            }
        }

        fn stop(&mut self) {
            self.started.store(false, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn ws_asr_session_streams_audio_and_tracks_partial_and_final_transcripts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let server_started = started.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let attach = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&attach).unwrap()["action"], "attach_session");
            assert!(!server_started.load(Ordering::SeqCst));
            socket
                .send(Message::text(
                    r#"{"action":"session_attached","data":{"session_id":"asr-1","memory_scope":"session","delegation":"none"}}"#,
                ))
                .await
                .unwrap();
            let update = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&update).unwrap()["action"], "session.update");
            socket.send(Message::text(r#"{"action":"session.updated","data":{"error":""}}"#)).await.unwrap();
            for action in ["media.mode", "mic_state"] {
                let msg = socket.next().await.unwrap().unwrap().into_text().unwrap();
                assert_eq!(serde_json::from_str::<serde_json::Value>(&msg).unwrap()["action"], action);
            }
            let audio = socket.next().await.unwrap().unwrap().into_data();
            assert_eq!(audio.len(), 641);
            assert_eq!(audio[0], 0);
            socket
                .send(Message::text(r#"{"action":"input.transcript.delta","data":{"delta":"你好"}}"#))
                .await
                .unwrap();
            socket
                .send(Message::text(r#"{"action":"input.transcript.done","data":{"text":"你好世界"}}"#))
                .await
                .unwrap();
            socket.send(Message::text(r#"{"action":"session.closing"}"#)).await.unwrap();
        });

        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
        let cancel = CancellationToken::new();
        let mut updates = Vec::new();
        let mut levels = Vec::new();
        session(
            socket,
            r#"{"action":"session.update"}"#.into(),
            SyntheticCapture {
                started: started.clone(),
                sent: false,
            },
            cancel,
            || {},
            |lvl| levels.push(lvl),
            |upd| updates.push(upd),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(!started.load(Ordering::SeqCst));
        assert!(levels.iter().any(|l| *l > 0.4));
        assert_eq!(updates.len(), 2);
        assert!(matches!(&updates[0], TranscriptUpdate::Partial(p) if p == "你好"));
        assert!(matches!(&updates[1], TranscriptUpdate::Done(d) if d == "你好世界"));
    }

    #[test]
    fn append_transcript_joins_segments_cleanly() {
        let mut out = String::new();
        append_segment(&mut out, "hello");
        append_segment(&mut out, "world");
        assert_eq!(out, "hello world");
        let mut zh = String::new();
        append_segment(&mut zh, "你好");
        append_segment(&mut zh, "世界");
        assert_eq!(zh, "你好世界");
    }
}
