use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
use vibevalley_server::modules::collab::voice::Voice;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    phase: Phase,
    muted: bool,
    problem: Option<String>,
    heard: String,
    said: String,
}

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    #[default]
    Idle,
    Connecting,
    Live,
    Stopping,
}

#[derive(Default)]
struct Call {
    state: State,
    stop: Option<CancellationToken>,
    owner: String,
}

fn call() -> &'static Mutex<Call> {
    static CALL: OnceLock<Mutex<Call>> = OnceLock::new();
    CALL.get_or_init(Default::default)
}

pub fn state(owner: &str) -> State {
    let current = call().lock();
    if current.owner == owner { current.state.clone() } else { State::default() }
}

pub fn start(voice: Arc<Voice>, owner: String) -> Result<State, String> {
    if owner.is_empty() || owner.len() > 128 {
        return Err("voice call requires an owner ID".into());
    }
    let mut current = call().lock();
    if current.state.phase != Phase::Idle {
        if current.owner == owner {
            return Ok(current.state.clone());
        }
        return Err("a voice call is already open".into());
    }
    let cancel = CancellationToken::new();
    current.state = State {
        phase: Phase::Connecting,
        ..State::default()
    };
    current.stop = Some(cancel.clone());
    current.owner = owner;
    let state = current.state.clone();
    drop(current);
    vibevalley_runtime::rt::handle().spawn(async move {
        let result = run(voice, cancel).await;
        let mut current = call().lock();
        current.state.phase = Phase::Idle;
        current.state.muted = false;
        current.state.problem = result.err();
        current.stop = None;
    });
    Ok(state)
}

pub fn stop(owner: Option<&str>) -> State {
    let mut current = call().lock();
    if owner.is_some_and(|id| id != current.owner) {
        return State::default();
    }
    if let Some(stop) = current.stop.take() {
        current.state.phase = Phase::Stopping;
        stop.cancel();
    }
    current.state.clone()
}

pub fn mute(owner: &str, muted: bool) -> State {
    let mut current = call().lock();
    if current.owner != owner {
        return State::default();
    }
    current.state.muted = muted;
    current.state.clone()
}

trait Audio {
    fn start(&mut self) -> Result<(), String>;
    fn microphone(&mut self) -> Result<Vec<u8>, String>;
    fn append(&mut self, bytes: &[u8]) -> Result<(), String>;
    fn completed(&self) -> u64;
    fn cut(&mut self) -> Result<(), String>;
    fn stop(&mut self);
}

struct HeldAudio<A: Audio>(A);
impl<A: Audio> std::ops::Deref for HeldAudio<A> {
    type Target = A;
    fn deref(&self) -> &A {
        &self.0
    }
}
impl<A: Audio> std::ops::DerefMut for HeldAudio<A> {
    fn deref_mut(&mut self) -> &mut A {
        &mut self.0
    }
}
impl<A: Audio> Drop for HeldAudio<A> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

#[derive(Debug)]
enum WireError {
    Cancelled,
    Failed(String),
}
impl From<String> for WireError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}
impl From<&str> for WireError {
    fn from(error: &str) -> Self {
        Self::Failed(error.into())
    }
}

struct NativeAudio {
    _lease: crate::audio::CallAudio,
}
impl Audio for NativeAudio {
    fn stop(&mut self) {
        crate::audio::capture_stop();
        crate::audio::stop();
    }
    fn start(&mut self) -> Result<(), String> {
        crate::audio::capture_start()?;
        self.cut()
    }
    fn microphone(&mut self) -> Result<Vec<u8>, String> {
        crate::audio::capture_read()
    }
    fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        crate::audio::append_bytes(bytes)
    }
    fn completed(&self) -> u64 {
        crate::audio::completed_frames()
    }
    fn cut(&mut self) -> Result<(), String> {
        crate::audio::start_pcm(crate::audio::PcmFormat {
            sample_rate: 48_000,
            channels: 1,
        })
    }
}

async fn run(voice: Arc<Voice>, cancel: CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Ok(());
    }
    let setup_voice = voice.clone();
    let setup_cancel = cancel.clone();
    let Some((audio, line, voice_call)) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        if setup_cancel.is_cancelled() {
            return Ok(None);
        }
        let audio = crate::audio::reserve_for_call()?;
        if setup_cancel.is_cancelled() {
            return Ok(None);
        }
        let grant = setup_voice.grant().map_err(|e| e.message)?;
        let line = setup_voice.moss_line().map_err(|e| e.message)?;
        let voice_call = setup_voice.start(&grant.channel, &grant.uid, None).map_err(|e| e.message)?;
        Ok(Some((audio, line, voice_call)))
    })
    .await
    .map_err(|e| format!("MOSS voice setup task panicked: {e}"))??
    else {
        return Ok(());
    };
    let result: Result<(), WireError> = async {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let mut request = line.url.as_str().into_client_request().map_err(|_| "invalid MOSS address")?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", line.key.expose()).parse().map_err(|_| "invalid MOSS credentials")?,
        );
        let (socket, _) = tokio::select! {
            biased;
            () = cancel.cancelled() => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(request)) => {
                result.map_err(|_| "MOSS connection timed out")?.map_err(|_| "MOSS connection failed")?
            }
        };
        session(
            socket,
            SessionMessages {
                update: line.session_update(),
                outgoing: line.outgoing.clone(),
                cancel: cancel.clone(),
            },
            NativeAudio { _lease: audio },
            |raw, event| {
                line.heard(raw);
                match event {
                    Event::InputTranscript { data } => {
                        voice
                            .heard(&voice_call.agent_id, &data.text, None, (!data.turn.is_empty()).then_some(data.turn.as_str()))
                            .map_err(|e| e.message)?;
                        call().lock().state.heard = data.text.clone();
                    }
                    Event::OutputTranscript { data } => {
                        voice.said(&voice_call.agent_id, &data.text).map_err(|e| e.message)?;
                        call().lock().state.said = data.text.clone();
                    }
                    _ => {}
                }
                Ok(())
            },
            || call().lock().state.muted,
            || {
                call().lock().state.phase = Phase::Live;
            },
        )
        .await
    }
    .await;
    let agent_id = voice_call.agent_id;
    let _ = tokio::task::spawn_blocking(move || voice.stop(&agent_id)).await;
    match result {
        Ok(()) | Err(WireError::Cancelled) => Ok(()),
        Err(WireError::Failed(error)) => Err(error),
    }
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
#[derive(Clone, Deserialize)]
struct Piece {
    chunk_id: String,
    run_id: String,
    turn_id: String,
}
#[derive(Deserialize)]
struct Turn {
    #[serde(default)]
    run_id: String,
    #[serde(default)]
    turn_id: String,
}
#[derive(Deserialize)]
struct Transcript {
    text: String,
    #[serde(default)]
    turn: String,
}

#[derive(Deserialize)]
#[serde(tag = "action")]
enum Event {
    #[serde(rename = "session_attached")]
    Attached { data: Attached },
    #[serde(rename = "session.updated")]
    Updated { data: Updated },
    #[serde(rename = "response.audio.context")]
    Audio { data: Piece },
    #[serde(rename = "response.audio.done")]
    AudioDone { data: Turn },
    #[serde(rename = "response.audio.stop", alias = "response.interrupted")]
    Cut { data: Turn },
    #[serde(rename = "input.transcript.done")]
    InputTranscript { data: Transcript },
    #[serde(rename = "output.transcript.done")]
    OutputTranscript { data: Transcript },
    #[serde(rename = "session.closing")]
    Closing,
    #[serde(rename = "error")]
    Error,
    #[serde(other)]
    Other,
}

#[derive(Clone, Copy, PartialEq)]
enum Handshake {
    Attaching,
    Configuring,
    Live,
}

struct Playing {
    piece: Piece,
    end: u64,
}

struct SessionMessages {
    update: String,
    outgoing: flume::Receiver<String>,
    cancel: CancellationToken,
}

async fn session<S, A: Audio>(
    socket: S,
    messages: SessionMessages,
    audio: A,
    mut heard: impl FnMut(&str, &Event) -> Result<(), WireError>,
    muted: impl Fn() -> bool,
    ready: impl Fn(),
) -> Result<(), WireError>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let mut audio = HeldAudio(audio);
    let SessionMessages { update, outgoing, cancel } = messages;
    let (mut writer, mut reader) = socket.split();
    async fn send<S>(writer: &mut S, cancel: &CancellationToken, message: Message) -> Result<(), WireError>
    where
        S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(WireError::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(5), writer.send(message)) => {
                result.map_err(|_| "MOSS send timed out")?.map_err(|_| WireError::Failed("MOSS connection ended".into()))
            }
        }
    }
    send(&mut writer, &cancel, Message::text(r#"{"action":"attach_session","memory_scope":"session"}"#)).await?;
    let mut handshake = Handshake::Attaching;
    let deadline = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(deadline);
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut piece: Option<Piece> = None;
    let mut playing: VecDeque<Playing> = VecDeque::new();
    let mut seen = HashSet::new();
    let mut finished: HashMap<String, String> = HashMap::new();
    let mut queued = 0u64;
    let mut active: Option<(String, String)> = None;
    let mut ended = HashSet::new();
    let mut discard_audio = false;
    let mut was_muted = false;
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => { audio.stop(); let _ = tokio::time::timeout(Duration::from_millis(500), writer.close()).await; return Ok(()); }
            _ = &mut deadline, if handshake != Handshake::Live => return Err("MOSS session setup timed out".into()),
            next = reader.next() => match next {
                Some(Ok(Message::Text(raw))) => {
                    if raw.len() > 64 * 1024 { return Err("MOSS text frame is too large".into()); }
                    let event = serde_json::from_str::<Event>(&raw).map_err(|_| "invalid MOSS frame")?;
                    match &event {
                        Event::Attached { data } => {
                            if handshake != Handshake::Attaching || data.session_id.is_empty() || data.memory_scope != "session" || data.delegation != "none" {
                                return Err("MOSS session options were refused".into());
                            }
                            handshake = Handshake::Configuring;
                            send(&mut writer, &cancel, Message::text(update.clone())).await?;
                        }
                        Event::Updated { data } => {
                            if handshake != Handshake::Configuring || !data.error.is_empty() { return Err("MOSS configuration was refused".into()); }
                            send(&mut writer, &cancel, Message::text(r#"{"action":"media.mode","binary_protocol":"tagged-v1"}"#)).await?;
                            audio.start()?;
                            if cancel.is_cancelled() { return Ok(()); }
                            send(&mut writer, &cancel, Message::text(r#"{"action":"mic_state","enabled":true}"#)).await?;
                            handshake = Handshake::Live;
                            ready();
                        }
                        Event::Audio { data } if handshake == Handshake::Live => {
                            if ended.contains(&data.run_id) { piece = None; discard_audio = true; continue; }
                            if active.as_ref().is_some_and(|(run, turn)| run != &data.run_id || turn != &data.turn_id) {
                                return Err("MOSS interleaved two audio runs".into());
                            }
                            if [&data.chunk_id, &data.run_id, &data.turn_id].iter().any(|s| s.is_empty() || s.len() > 256) || seen.len() >= 4096 || !seen.insert(data.chunk_id.clone()) {
                                return Err("MOSS audio context is invalid or repeated".into());
                            }
                            active = Some((data.run_id.clone(), data.turn_id.clone()));
                            discard_audio = false;
                            piece = Some(data.clone());
                        }
                        Event::AudioDone { data } => {
                            if !ended.contains(&data.run_id) && active.as_ref().is_some_and(|(run, turn)| run == &data.run_id && turn == &data.turn_id) {
                                finished.insert(data.run_id.clone(), data.turn_id.clone());
                            }
                        }
                        Event::Cut { data } => {
                            let Some((run, turn)) = active.as_ref() else { continue };
                            if !data.run_id.is_empty() && (&data.run_id != run || (!data.turn_id.is_empty() && &data.turn_id != turn)) { continue; }
                            let (run, turn) = active.take().unwrap();
                            ended.insert(run.clone());
                            piece = None;
                            discard_audio = true;
                            audio.cut()?;
                            queued = 0;
                            playing.clear();
                            finished.clear();
                            send(&mut writer, &cancel, Message::text(json!({"action":"playback.stopped","run_id":run,"turn_id":turn,"played_audio_ms":0}).to_string())).await?;
                        }
                        Event::Closing => return Ok(()),
                        Event::Error => return Err("MOSS refused the voice session".into()),
                        Event::InputTranscript { data } | Event::OutputTranscript { data } if data.text.len() > 16000 => return Err("MOSS transcript is too large".into()),
                        Event::Audio { .. } | Event::InputTranscript { .. } | Event::OutputTranscript { .. } | Event::Other => {}
                    }
                    heard(&raw, &event)?;
                }
                Some(Ok(Message::Binary(bytes))) if handshake == Handshake::Live => {
                    if discard_audio { discard_audio = false; continue; }
                    let Some(context) = piece.take() else { return Err("MOSS audio arrived without context".into()); };
                    if bytes.is_empty() || bytes.len() % 2 != 0 || bytes.len() > 48_000 * 2 * 5 { return Err("MOSS PCM frame is invalid".into()); }
                    audio.append(&bytes)?;
                    queued += (bytes.len() / 2) as u64;
                    playing.push_back(Playing { piece: context, end: queued });
                }
                Some(Ok(Message::Ping(bytes))) => send(&mut writer, &cancel, Message::Pong(bytes)).await?,
                Some(Ok(Message::Pong(_) | Message::Frame(_))) => {},
                Some(Ok(Message::Binary(_))) => return Err("MOSS audio arrived before setup".into()),
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Err(_)) => return Err("MOSS connection failed".into()),
            },
            frame = outgoing.recv_async(), if handshake == Handshake::Live => {
                if let Ok(frame) = frame { send(&mut writer, &cancel, Message::text(frame)).await?; }
            }
            _ = tick.tick(), if handshake == Handshake::Live => {
                let is_muted = muted();
                if is_muted != was_muted {
                    send(&mut writer, &cancel, Message::text(json!({"action":"mic_state","enabled":!is_muted}).to_string())).await?;
                    was_muted = is_muted;
                }
                for frame in audio.microphone()?.as_chunks::<640>().0 {
                    let mut tagged = vec![0u8; 641];
                    if !is_muted { tagged[1..].copy_from_slice(frame); }
                    send(&mut writer, &cancel, Message::Binary(tagged.into())).await?;
                }
                let completed = audio.completed();
                while playing.front().is_some_and(|p| p.end <= completed) {
                    let p = playing.pop_front().unwrap().piece;
                    send(&mut writer, &cancel, Message::text(json!({"action":"playback.chunk.completed","chunk_id":p.chunk_id,"run_id":p.run_id,"turn_id":p.turn_id}).to_string())).await?;
                }
                let done: Vec<_> = finished.keys().filter(|run| !playing.iter().any(|p| &p.piece.run_id == *run)).cloned().collect();
                for run in done {
                    let turn = finished.remove(&run).unwrap();
                    ended.insert(run.clone());
                    active = None;
                    send(&mut writer, &cancel, Message::text(json!({"action":"playback.completed","run_id":run,"turn_id":turn}).to_string())).await?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[derive(Default)]
    struct Probe {
        started: AtomicBool,
        played: AtomicU64,
    }
    struct SyntheticAudio {
        probe: Arc<Probe>,
        sent: bool,
    }
    impl Audio for SyntheticAudio {
        fn stop(&mut self) {
            self.probe.started.store(false, Ordering::SeqCst);
        }
        fn start(&mut self) -> Result<(), String> {
            self.probe.started.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn microphone(&mut self) -> Result<Vec<u8>, String> {
            Ok(if self.sent {
                vec![]
            } else {
                self.sent = true;
                vec![1; 640]
            })
        }
        fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.probe.played.fetch_add((bytes.len() / 2) as u64, Ordering::SeqCst);
            Ok(())
        }
        fn completed(&self) -> u64 {
            self.probe.played.load(Ordering::SeqCst)
        }
        fn cut(&mut self) -> Result<(), String> {
            self.probe.played.store(0, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn regression_moss_handshake_tagged_microphone_and_playback_receipts_use_one_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let probe = Arc::new(Probe::default());
        let server_probe = probe.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let attach = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&attach).unwrap()["action"], "attach_session");
            assert!(!server_probe.started.load(Ordering::SeqCst));
            socket
                .send(Message::text(
                    r#"{"action":"session_attached","data":{"session_id":"s","memory_scope":"session","delegation":"none"}}"#,
                ))
                .await
                .unwrap();
            assert_eq!(socket.next().await.unwrap().unwrap().into_text().unwrap(), r#"{"action":"session.update"}"#);
            assert!(!server_probe.started.load(Ordering::SeqCst));
            socket.send(Message::text(r#"{"action":"session.updated","data":{"error":""}}"#)).await.unwrap();
            for action in ["media.mode", "mic_state"] {
                let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
                assert_eq!(serde_json::from_str::<serde_json::Value>(&message).unwrap()["action"], action);
            }
            socket
                .send(Message::text(
                    r#"{"action":"response.audio.context","data":{"chunk_id":"c","run_id":"r","turn_id":"t"}}"#,
                ))
                .await
                .unwrap();
            socket.send(Message::Binary(vec![0; 960].into())).await.unwrap();
            socket
                .send(Message::text(r#"{"action":"response.audio.done","data":{"run_id":"r","turn_id":"t"}}"#))
                .await
                .unwrap();
            let mut microphone = false;
            let mut chunk = false;
            let mut completed = false;
            while !(microphone && chunk && completed) {
                match tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap() {
                    Message::Binary(bytes) => {
                        assert_eq!(bytes.len(), 641);
                        assert_eq!(bytes[0], 0);
                        assert!(bytes[1..].iter().all(|b| *b == 1));
                        microphone = true;
                    }
                    Message::Text(text) => {
                        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                        match value["action"].as_str().unwrap() {
                            "playback.chunk.completed" => {
                                assert_eq!(value["chunk_id"], "c");
                                chunk = true;
                            }
                            "playback.completed" => {
                                assert_eq!(value["run_id"], "r");
                                completed = true;
                            }
                            unexpected => panic!("unexpected {unexpected}"),
                        }
                    }
                    unexpected => panic!("unexpected {unexpected:?}"),
                }
            }
            socket.send(Message::text(r#"{"action":"session.closing"}"#)).await.unwrap();
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let cancel = CancellationToken::new();
        let (_out, outgoing) = flume::bounded(1);
        session(
            socket,
            SessionMessages {
                update: r#"{"action":"session.update"}"#.into(),
                outgoing,
                cancel,
            },
            SyntheticAudio {
                probe: probe.clone(),
                sent: false,
            },
            |_, _| Ok(()),
            || false,
            || {},
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(!probe.started.load(Ordering::SeqCst));
        assert_eq!(probe.played.load(Ordering::SeqCst), 480);
    }

    #[tokio::test]
    async fn regression_moss_rejected_setup_never_opens_the_microphone() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            socket.next().await.unwrap().unwrap();
            socket
                .send(Message::text(
                    r#"{"action":"session_attached","data":{"session_id":"s","memory_scope":"account","delegation":"none"}}"#,
                ))
                .await
                .unwrap();
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let cancel = CancellationToken::new();
        let (_out, outgoing) = flume::bounded(1);
        let probe = Arc::new(Probe::default());
        let result = session(
            socket,
            SessionMessages {
                update: String::new(),
                outgoing,
                cancel,
            },
            SyntheticAudio {
                probe: probe.clone(),
                sent: false,
            },
            |_, _| Ok(()),
            || false,
            || {},
        )
        .await;
        assert!(matches!(result, Err(WireError::Failed(error)) if error.contains("options")));
        assert!(!probe.started.load(Ordering::SeqCst));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn regression_interrupted_moss_runs_ignore_late_audio_and_completion() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            socket.next().await.unwrap().unwrap();
            socket
                .send(Message::text(
                    r#"{"action":"session_attached","data":{"session_id":"s","memory_scope":"session","delegation":"none"}}"#,
                ))
                .await
                .unwrap();
            socket.next().await.unwrap().unwrap();
            socket.send(Message::text(r#"{"action":"session.updated","data":{"error":""}}"#)).await.unwrap();
            socket.next().await.unwrap().unwrap();
            socket.next().await.unwrap().unwrap();
            socket
                .send(Message::text(
                    r#"{"action":"response.audio.context","data":{"chunk_id":"c","run_id":"r","turn_id":"t"}}"#,
                ))
                .await
                .unwrap();
            socket
                .send(Message::text(r#"{"action":"response.interrupted","data":{"run_id":"r","turn_id":"t"}}"#))
                .await
                .unwrap();
            let stopped = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&stopped).unwrap()["action"], "playback.stopped");
            socket
                .send(Message::text(
                    r#"{"action":"response.audio.context","data":{"chunk_id":"late","run_id":"r","turn_id":"t"}}"#,
                ))
                .await
                .unwrap();
            socket.send(Message::Binary(vec![0; 960].into())).await.unwrap();
            socket
                .send(Message::text(r#"{"action":"response.audio.done","data":{"run_id":"r","turn_id":"t"}}"#))
                .await
                .unwrap();
            socket.send(Message::Ping(vec![1].into())).await.unwrap();
            // Ping is behind every late frame, so its reply observes that processing finished.
            assert!(matches!(socket.next().await.unwrap().unwrap(), Message::Pong(_)));
            socket.send(Message::text(r#"{"action":"session.closing"}"#)).await.unwrap();
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let cancel = CancellationToken::new();
        let (_out, outgoing) = flume::bounded(1);
        let probe = Arc::new(Probe::default());
        session(
            socket,
            SessionMessages {
                update: String::new(),
                outgoing,
                cancel,
            },
            SyntheticAudio {
                probe: probe.clone(),
                sent: true,
            },
            |_, _| Ok(()),
            || false,
            || {},
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(probe.played.load(Ordering::SeqCst), 0);
    }
    struct SlowSocket {
        reads: VecDeque<Message>,
        sent: usize,
        blocked: flume::Sender<()>,
    }
    impl futures_util::Stream for SlowSocket {
        type Item = Result<Message, tokio_tungstenite::tungstenite::Error>;
        fn poll_next(mut self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
            match self.reads.pop_front() {
                Some(message) => std::task::Poll::Ready(Some(Ok(message))),
                None => std::task::Poll::Pending,
            }
        }
    }
    impl futures_util::Sink<Message> for SlowSocket {
        type Error = tokio_tungstenite::tungstenite::Error;
        fn poll_ready(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
            if self.sent >= 4 {
                let _ = self.blocked.try_send(());
                std::task::Poll::Pending
            } else {
                std::task::Poll::Ready(Ok(()))
            }
        }
        fn start_send(mut self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            self.sent += 1;
            Ok(())
        }
        fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Pending
        }
    }

    #[tokio::test]
    async fn regression_hangup_interrupts_a_blocked_microphone_send_and_stops_capture() {
        let (blocked, waiting) = flume::bounded(1);
        let cancel = CancellationToken::new();
        let (_out, outgoing) = flume::bounded(1);
        let probe = Arc::new(Probe::default());
        let socket = SlowSocket {
            reads: VecDeque::from([
                Message::text(r#"{"action":"session_attached","data":{"session_id":"s","memory_scope":"session","delegation":"none"}}"#),
                Message::text(r#"{"action":"session.updated","data":{"error":""}}"#),
            ]),
            sent: 0,
            blocked,
        };
        let worker_probe = probe.clone();
        let worker_cancel = cancel.clone();
        let worker = vibevalley_runtime::rt::handle().spawn(async move {
            session(
                socket,
                SessionMessages {
                    update: String::new(),
                    outgoing,
                    cancel: worker_cancel,
                },
                SyntheticAudio {
                    probe: worker_probe,
                    sent: false,
                },
                |_, _| Ok(()),
                || false,
                || {},
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), waiting.recv_async()).await.unwrap().unwrap();
        assert!(probe.started.load(Ordering::SeqCst));
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker).await.unwrap().unwrap();
        assert!(matches!(result, Err(WireError::Cancelled)));
        assert!(!probe.started.load(Ordering::SeqCst));
    }
}
