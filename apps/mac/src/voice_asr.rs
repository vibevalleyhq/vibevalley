use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;
pub use vibevalley_protocol::HostAsrState as State;
use vibevalley_protocol::{ApiError, BizCode, HostAsrPhase as Phase};
use vibevalley_server::gateway::api::{BoxFuture, LiveVoiceLine, LiveVoicePort, SharedLiveVoice};

const PCM_SAMPLE_RATE: u32 = 16_000;
const PCM_BYTES_PER_MS: usize = 32;
const MIN_PAUSE_CUT_BYTES: usize = PCM_BYTES_PER_MS * 1_200;
const MAX_CHUNK_BYTES: usize = PCM_BYTES_PER_MS * 4_500;
const MIN_FLUSH_BYTES: usize = PCM_BYTES_PER_MS * 200;
const MIN_QUIET_FLUSH_BYTES: usize = PCM_BYTES_PER_MS * 400;
const SILENCE_PREROLL_BYTES: usize = PCM_BYTES_PER_MS * 160;
const MAX_DICTATION_PCM_BYTES: usize = PCM_SAMPLE_RATE as usize * 2 * 600;
const VAD_SPEECH_RMS: f64 = 0.035;
const VAD_PAUSE_MS: u64 = 450;
const MAX_CHUNK_RETRIES: usize = 2;
const CHUNK_RETRY_BASE_MS: u64 = 150;
const MAX_CONCURRENT_CHUNKS: usize = 2;

#[derive(Default)]
struct Dictation {
    state: State,
    stop_capture: Option<CancellationToken>,
    abort: Option<CancellationToken>,
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
    let stop_capture = CancellationToken::new();
    let abort = CancellationToken::new();
    current.state = State {
        phase: Phase::Connecting,
        ..State::default()
    };
    current.stop_capture = Some(stop_capture.clone());
    current.abort = Some(abort.clone());
    current.owner = owner;
    let initial = current.state.clone();
    drop(current);
    vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
        let result = run(voice, stop_capture, abort).await;
        let mut current = dictation().lock();
        if !current.state.partial.is_empty() {
            let partial = current.state.partial.clone();
            append_segment(&mut current.state.text, &partial);
            current.state.partial.clear();
        }
        current.state.phase = Phase::Idle;
        current.state.mic_level = 0.0;
        current.state.problem = result.err();
        current.stop_capture = None;
        current.abort = None;
    });
    Ok(initial)
}

pub fn stop(owner: Option<&str>) -> State {
    let mut current = dictation().lock();
    if owner.is_some_and(|id| id != current.owner) {
        return State::default();
    }
    if owner.is_none() {
        if let Some(stop_capture) = current.stop_capture.take() {
            stop_capture.cancel();
        }
        if let Some(abort) = current.abort.take() {
            abort.cancel();
        }
        if current.state.phase != Phase::Idle {
            current.state.phase = Phase::Finishing;
        }
        return current.state.clone();
    }
    if let Some(stop_capture) = current.stop_capture.take() {
        current.state.phase = Phase::Finishing;
        stop_capture.cancel();
    } else if let Some(abort) = current.abort.take() {
        abort.cancel();
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

trait AsrBackend: Send + Sync {
    fn transcribe_wav_async(&self, wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>>;
    fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>>;
}

impl AsrBackend for SharedLiveVoice {
    fn transcribe_wav_async(&self, wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>> {
        LiveVoicePort::transcribe_wav_async(self.as_ref(), wav)
    }

    fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>> {
        LiveVoicePort::polish_transcript_async(self.as_ref(), raw)
    }
}

enum RoutePlan {
    Chunked,
    Stream(Box<dyn LiveVoiceLine>),
}

/// Routes composer dictation to dedicated ASR transcription first (`Use::Transcription`),
/// falling back to MOSS Live realtime streaming only when no transcription model is bound.
fn choose_route(voice: &dyn LiveVoicePort) -> Result<RoutePlan, String> {
    if voice.can_transcribe() {
        Ok(RoutePlan::Chunked)
    } else {
        voice.asr_line().map(RoutePlan::Stream).map_err(|e| e.message)
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
    if raw_level <= 0.0 {
        current.state.mic_level = 0.0;
        return;
    }
    let prev = current.state.mic_level;
    let next = if prev <= 0.001 { raw_level } else { prev * 0.5 + raw_level * 0.5 };
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

/// Segments continuous 16 kHz mono PCM16 capture on VAD pauses and bounded max windows.
#[derive(Default)]
struct ChunkSegmenter {
    buf: Vec<u8>,
    has_audio: bool,
    has_speech: bool,
    silence_ms: u64,
}

impl ChunkSegmenter {
    fn take_chunk(&mut self) -> Vec<u8> {
        self.has_audio = false;
        self.has_speech = false;
        self.silence_ms = 0;
        std::mem::take(&mut self.buf)
    }

    fn push(&mut self, pcm: &[u8], rms: f64, tick_ms: u64) -> Option<Vec<u8>> {
        if pcm.is_empty() {
            if self.has_speech {
                self.silence_ms = self.silence_ms.saturating_add(tick_ms);
                if self.buf.len() >= MIN_PAUSE_CUT_BYTES && self.silence_ms >= VAD_PAUSE_MS {
                    return Some(self.take_chunk());
                }
            }
            return None;
        }
        self.buf.extend_from_slice(pcm);
        if rms > 0.0 || pcm.iter().any(|&b| b != 0) {
            self.has_audio = true;
        }
        let frame_ms = u64::try_from(pcm.len() / PCM_BYTES_PER_MS).unwrap_or(0).max(tick_ms);
        if rms >= VAD_SPEECH_RMS {
            self.has_speech = true;
            self.silence_ms = 0;
        } else if self.has_speech {
            self.silence_ms = self.silence_ms.saturating_add(frame_ms);
        }
        if self.buf.len() >= MAX_CHUNK_BYTES {
            if self.has_speech {
                return Some(self.take_chunk());
            }
            let drop_len = self.buf.len().saturating_sub(SILENCE_PREROLL_BYTES);
            self.buf.drain(..drop_len);
            self.silence_ms = 0;
            return None;
        }
        if self.has_speech && self.buf.len() >= MIN_PAUSE_CUT_BYTES && self.silence_ms >= VAD_PAUSE_MS {
            return Some(self.take_chunk());
        }
        None
    }

    fn flush(&mut self) -> Option<Vec<u8>> {
        let enough_audio = (self.has_speech && self.buf.len() >= MIN_FLUSH_BYTES) || (self.has_audio && self.buf.len() >= MIN_QUIET_FLUSH_BYTES);
        if enough_audio {
            return Some(self.take_chunk());
        }
        self.buf.clear();
        self.has_audio = false;
        self.has_speech = false;
        self.silence_ms = 0;
        None
    }
}

/// Joins asynchronously transcribed chunks strictly in capture order while exposing ahead completions as `partial`.
#[derive(Default)]
struct ChunkAggregator {
    next_seq: usize,
    completed: BTreeMap<usize, Option<String>>,
    committed: String,
    last_error: Option<String>,
    succeeded: usize,
}

impl ChunkAggregator {
    fn record(&mut self, seq: usize, outcome: Result<String, String>) -> (String, String) {
        match outcome {
            Ok(text) => {
                let clean = text.trim().to_string();
                self.succeeded += 1;
                self.completed.insert(seq, (!clean.is_empty()).then_some(clean));
            }
            Err(err) => {
                self.last_error = Some(err);
                self.completed.insert(seq, None);
            }
        }
        while let Some(entry) = self.completed.remove(&self.next_seq) {
            self.next_seq += 1;
            if let Some(piece) = entry {
                append_segment(&mut self.committed, &piece);
            }
        }
        let mut ahead = String::new();
        for piece in self.completed.values().flatten() {
            append_segment(&mut ahead, piece);
        }
        (self.committed.clone(), ahead)
    }

    fn finish(self) -> Result<String, String> {
        if self.succeeded == 0
            && let Some(err) = self.last_error
        {
            return Err(err);
        }
        Ok(self.committed)
    }
}

fn is_retryable_asr_error(err: &ApiError) -> bool {
    !matches!(err.biz_code, BizCode::VoiceUnavailable | BizCode::InvalidInput)
}

async fn transcribe_chunk_with_retry(backend: &dyn AsrBackend, wav: Vec<u8>, abort: &CancellationToken, retry_base_ms: u64) -> Result<String, String> {
    let mut attempt = 0usize;
    loop {
        if abort.is_cancelled() {
            return Err("dictation aborted".into());
        }
        let result = tokio::select! {
            biased;
            () = abort.cancelled() => return Err("dictation aborted".into()),
            res = backend.transcribe_wav_async(wav.clone()) => res,
        };
        match result {
            Ok(text) => return Ok(text),
            Err(err) if attempt < MAX_CHUNK_RETRIES && is_retryable_asr_error(&err) => {
                attempt += 1;
                let delay = Duration::from_millis(retry_base_ms.saturating_mul(1u64 << (attempt - 1)));
                if !delay.is_zero() {
                    tokio::select! {
                        biased;
                        () = abort.cancelled() => return Err("dictation aborted".into()),
                        () = tokio::time::sleep(delay) => {}
                    }
                }
            }
            Err(err) => return Err(err.message),
        }
    }
}

async fn run(voice: SharedLiveVoice, stop_capture: CancellationToken, abort: CancellationToken) -> Result<(), String> {
    if stop_capture.is_cancelled() || abort.is_cancelled() {
        return Ok(());
    }
    let setup_voice = voice.clone();
    let setup_stop = stop_capture.clone();
    let setup_abort = abort.clone();
    enum Setup {
        Cancelled,
        Chunked(crate::audio::CaptureAudio),
        Stream(crate::audio::CaptureAudio, Box<dyn LiveVoiceLine>),
    }
    let setup = tokio::task::spawn_blocking(move || -> Result<Setup, String> {
        if setup_stop.is_cancelled() || setup_abort.is_cancelled() {
            return Ok(Setup::Cancelled);
        }
        let capture = crate::audio::reserve_capture()?;
        if setup_stop.is_cancelled() || setup_abort.is_cancelled() {
            return Ok(Setup::Cancelled);
        }
        match choose_route(setup_voice.as_ref())? {
            RoutePlan::Chunked => Ok(Setup::Chunked(capture)),
            RoutePlan::Stream(line) => Ok(Setup::Stream(capture, line)),
        }
    })
    .await
    .map_err(|e| format!("ASR setup task panicked: {e}"))??;

    match setup {
        Setup::Cancelled => Ok(()),
        Setup::Chunked(lease) => run_chunked(lease, voice, stop_capture, abort).await,
        Setup::Stream(lease, line) => run_stream(lease, line, voice, stop_capture, abort).await,
    }
}

async fn polish_with_fallback(backend: &dyn AsrBackend, raw: &str, abort: &CancellationToken) -> Option<(String, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || abort.is_cancelled() {
        return None;
    }
    let polished = tokio::select! {
        biased;
        () = abort.cancelled() => return None,
        res = backend.polish_transcript_async(trimmed.to_string()) => match res {
            Ok(text) if !text.trim().is_empty() => text.trim().to_string(),
            _ => trimmed.to_string(),
        },
    };
    Some((trimmed.to_string(), polished))
}

async fn run_stream(
    lease: crate::audio::CaptureAudio,
    line: Box<dyn LiveVoiceLine>,
    voice: SharedLiveVoice,
    stop_capture: CancellationToken,
    abort: CancellationToken,
) -> Result<(), String> {
    if stop_capture.is_cancelled() || abort.is_cancelled() {
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
        () = abort.cancelled() => return Ok(()),
        () = stop_capture.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(request)) => {
            result.map_err(|_| "MOSS connection timed out".to_string())?.map_err(|_| "MOSS connection failed".to_string())?
        }
    };
    let stream_cancel = stop_capture.child_token();
    let abort_watcher = {
        let stream_cancel = stream_cancel.clone();
        let abort = abort.clone();
        tokio::spawn(async move {
            abort.cancelled().await;
            stream_cancel.cancel();
        })
    };
    let res = session(
        socket,
        line.session_update(),
        NativeCapture { _lease: lease },
        stream_cancel,
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
    .await;
    abort_watcher.abort();
    res?;
    let raw = {
        let mut current = dictation().lock();
        if !current.state.partial.is_empty() {
            let partial = current.state.partial.clone();
            append_segment(&mut current.state.text, &partial);
            current.state.partial.clear();
        }
        current.state.text.clone()
    };
    if !raw.trim().is_empty() && !abort.is_cancelled() {
        dictation().lock().state.phase = Phase::Polishing;
        let backend: Arc<dyn AsrBackend> = Arc::new(voice);
        if let Some((raw_text, polished)) = polish_with_fallback(backend.as_ref(), &raw, &abort).await {
            let mut current = dictation().lock();
            current.state.raw_text = Some(raw_text);
            current.state.text = polished;
        }
    }
    Ok(())
}

struct ChunkRunOptions {
    tick_interval: Duration,
    retry_base_ms: u64,
}

impl Default for ChunkRunOptions {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_millis(20),
            retry_base_ms: CHUNK_RETRY_BASE_MS,
        }
    }
}

trait ChunkHooks {
    fn on_phase(&mut self, phase: Phase);
    fn on_mic_level(&mut self, level: f64);
    fn on_transcript(&mut self, committed: String, partial: String);
    fn on_polished(&mut self, raw: String, polished: String);
}

struct SharedStateHooks;
impl ChunkHooks for SharedStateHooks {
    fn on_phase(&mut self, phase: Phase) {
        dictation().lock().state.phase = phase;
    }

    fn on_mic_level(&mut self, level: f64) {
        update_mic_level(level);
    }

    fn on_transcript(&mut self, committed: String, partial: String) {
        let mut current = dictation().lock();
        current.state.text = committed;
        current.state.partial = partial;
    }

    fn on_polished(&mut self, raw: String, polished: String) {
        let mut current = dictation().lock();
        current.state.raw_text = Some(raw);
        current.state.text = polished;
        current.state.partial.clear();
    }
}

async fn run_chunked(
    lease: crate::audio::CaptureAudio,
    voice: SharedLiveVoice,
    stop_capture: CancellationToken,
    abort: CancellationToken,
) -> Result<(), String> {
    let backend: Arc<dyn AsrBackend> = Arc::new(voice);
    let mut hooks = SharedStateHooks;
    run_chunked_with(
        NativeCapture { _lease: lease },
        backend,
        (stop_capture, abort),
        ChunkRunOptions::default(),
        &mut hooks,
    )
    .await
}

fn spawn_chunk_task(
    in_flight: &mut tokio::task::JoinSet<(usize, Result<String, String>)>,
    seq: usize,
    pcm: Vec<u8>,
    backend: Arc<dyn AsrBackend>,
    semaphore: Arc<tokio::sync::Semaphore>,
    abort: CancellationToken,
    retry_base_ms: u64,
) {
    in_flight.spawn(async move {
        let permit = tokio::select! {
            biased;
            () = abort.cancelled() => return (seq, Err("dictation aborted".into())),
            res = semaphore.acquire_owned() => match res {
                Ok(p) => p,
                Err(_) => return (seq, Err("dictation aborted".into())),
            }
        };
        let wav = pcm16_to_wav(&pcm, PCM_SAMPLE_RATE, 1);
        let res = transcribe_chunk_with_retry(backend.as_ref(), wav, &abort, retry_base_ms).await;
        drop(permit);
        (seq, res)
    });
}

async fn run_chunked_with<A: CaptureAudio, H: ChunkHooks>(
    audio: A,
    backend: Arc<dyn AsrBackend>,
    (stop_capture, abort): (CancellationToken, CancellationToken),
    options: ChunkRunOptions,
    hooks: &mut H,
) -> Result<(), String> {
    let mut audio = HeldCapture(audio);
    audio.0.start()?;
    hooks.on_phase(Phase::Listening);

    let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CHUNKS));
    let mut in_flight: tokio::task::JoinSet<(usize, Result<String, String>)> = tokio::task::JoinSet::new();
    let mut segmenter = ChunkSegmenter::default();
    let mut aggregator = ChunkAggregator::default();
    let mut next_seq = 0usize;
    let mut total_pcm_bytes = 0usize;
    let tick_ms = u64::try_from(options.tick_interval.as_millis()).unwrap_or(20).max(1);
    let mut tick = tokio::time::interval(options.tick_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            biased;
            () = abort.cancelled() => {
                in_flight.abort_all();
                return Ok(());
            }
            () = stop_capture.cancelled() => break,
            Some(joined) = in_flight.join_next(), if !in_flight.is_empty() => {
                if let Ok((seq, outcome)) = joined {
                    let (committed, partial) = aggregator.record(seq, outcome);
                    hooks.on_transcript(committed, partial);
                }
            }
            _ = tick.tick() => {
                let bytes = audio.0.microphone()?;
                let rms = if bytes.is_empty() { 0.0 } else { crate::audio::pcm16_rms_level(&bytes) };
                if !bytes.is_empty() {
                    hooks.on_mic_level(rms);
                    total_pcm_bytes = total_pcm_bytes.saturating_add(bytes.len());
                }
                if let Some(chunk_pcm) = segmenter.push(&bytes, rms, tick_ms) {
                    let seq = next_seq;
                    next_seq += 1;
                    spawn_chunk_task(
                        &mut in_flight,
                        seq,
                        chunk_pcm,
                        backend.clone(),
                        semaphore.clone(),
                        abort.clone(),
                        options.retry_base_ms,
                    );
                }
                if total_pcm_bytes >= MAX_DICTATION_PCM_BYTES {
                    break;
                }
            }
        }
    }

    drop(audio);
    hooks.on_mic_level(0.0);

    if let Some(tail_pcm) = segmenter.flush() {
        let seq = next_seq;
        spawn_chunk_task(
            &mut in_flight,
            seq,
            tail_pcm,
            backend.clone(),
            semaphore.clone(),
            abort.clone(),
            options.retry_base_ms,
        );
    }

    if !in_flight.is_empty() {
        hooks.on_phase(Phase::Finishing);
    }
    while !in_flight.is_empty() {
        tokio::select! {
            biased;
            () = abort.cancelled() => {
                in_flight.abort_all();
                return Ok(());
            }
            Some(joined) = in_flight.join_next() => {
                if let Ok((seq, outcome)) = joined {
                    let (committed, partial) = aggregator.record(seq, outcome);
                    hooks.on_transcript(committed, partial);
                }
            }
        }
    }

    let raw = aggregator.finish()?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    hooks.on_phase(Phase::Polishing);
    if let Some((raw_text, polished)) = polish_with_fallback(backend.as_ref(), &raw, &abort).await {
        hooks.on_polished(raw_text, polished);
    }
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
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use parking_lot::Mutex;

    use super::*;

    fn pcm_tone(ms: usize, amplitude: i16) -> Vec<u8> {
        let mut pcm = vec![0u8; ms * PCM_BYTES_PER_MS];
        let sample = amplitude.to_le_bytes();
        for chunk in pcm.as_chunks_mut::<2>().0 {
            *chunk = sample;
        }
        pcm
    }

    struct StubLine;
    impl LiveVoiceLine for StubLine {
        fn url(&self) -> &str {
            "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
        }
        fn bearer_token(&self) -> &str {
            "test-key"
        }
        fn session_update(&self) -> String {
            "{}".into()
        }
        fn take_outgoing(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<String>> {
            None
        }
        fn heard(&self, _raw: &str) {}
    }

    struct StubVoicePort {
        transcribe_ready: bool,
        live_ready: bool,
    }

    impl LiveVoicePort for StubVoicePort {
        fn grant(&self) -> Result<vibevalley_protocol::VoiceGrant, ApiError> {
            Err(ApiError::new(BizCode::VoiceUnavailable, "unused"))
        }
        fn moss_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError> {
            Err(ApiError::new(BizCode::VoiceUnavailable, "unused"))
        }
        fn asr_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError> {
            if self.live_ready {
                Ok(Box::new(StubLine))
            } else {
                Err(ApiError::new(BizCode::VoiceUnavailable, "no live key"))
            }
        }
        fn can_transcribe(&self) -> bool {
            self.transcribe_ready
        }
        fn transcribe_wav_async(&self, _wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>> {
            Box::pin(async { Ok(String::new()) })
        }
        fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>> {
            Box::pin(async move { Ok(raw) })
        }
        fn start(&self, _channel: &str, _uid: &str) -> Result<vibevalley_protocol::VoiceCall, ApiError> {
            Err(ApiError::new(BizCode::VoiceUnavailable, "unused"))
        }
        fn heard(&self, _agent_id: &str, _text: &str, _turn: Option<&str>) -> Result<(), ApiError> {
            Ok(())
        }
        fn said(&self, _agent_id: &str, _text: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn stop(&self, _agent_id: &str) {}
    }

    #[test]
    fn route_prefers_dedicated_transcription_over_moss_live() {
        let both = StubVoicePort {
            transcribe_ready: true,
            live_ready: true,
        };
        assert!(matches!(choose_route(&both), Ok(RoutePlan::Chunked)));

        let live_only = StubVoicePort {
            transcribe_ready: false,
            live_ready: true,
        };
        assert!(matches!(choose_route(&live_only), Ok(RoutePlan::Stream(_))));

        let neither = StubVoicePort {
            transcribe_ready: false,
            live_ready: false,
        };
        assert_eq!(choose_route(&neither).err().as_deref(), Some("no live key"));
    }

    #[test]
    fn chunk_segmenter_cuts_on_vad_pause_and_max_window_and_skips_pure_silence() {
        let mut seg = ChunkSegmenter::default();

        // 5 seconds of pure silence never emits a chunk.
        for _ in 0..25 {
            assert!(seg.push(&pcm_tone(200, 0), 0.0, 200).is_none());
        }
        assert!(seg.flush().is_none());

        // Speech for 1.2s followed by 460ms of silence cuts cleanly on VAD pause.
        for _ in 0..6 {
            assert!(seg.push(&pcm_tone(200, 4_096), 0.5, 200).is_none());
        }
        assert!(seg.push(&pcm_tone(200, 0), 0.0, 200).is_none());
        assert!(seg.push(&pcm_tone(200, 0), 0.0, 200).is_none());
        let cut = seg.push(&pcm_tone(60, 0), 0.0, 60).expect("pause cut");
        assert!(cut.len() >= MIN_PAUSE_CUT_BYTES);

        // Continuous speech without pauses cuts at MAX_CHUNK_BYTES (4.5s).
        let mut max_cut = None;
        for _ in 0..10 {
            if let Some(chunk) = seg.push(&pcm_tone(500, 4_096), 0.5, 500) {
                max_cut = Some(chunk);
                break;
            }
        }
        assert!(max_cut.is_some_and(|c| c.len() >= MAX_CHUNK_BYTES));

        // Short tail flushes on stop.
        assert!(seg.push(&pcm_tone(300, 4_096), 0.5, 300).is_none());
        assert!(seg.flush().is_some_and(|c| c.len() == 300 * PCM_BYTES_PER_MS));
    }

    #[test]
    fn chunk_aggregator_orders_out_of_order_chunks_and_tolerates_single_chunk_failure() {
        let mut agg = ChunkAggregator::default();
        // Chunk 1 arrives before chunk 0 -> shows in ahead preview (`partial`).
        let (committed, partial) = agg.record(1, Ok("the logs".into()));
        assert_eq!(committed, "");
        assert_eq!(partial, "the logs");

        // Chunk 0 arrives -> both commit in strict order.
        let (committed, partial) = agg.record(0, Ok("Check".into()));
        assert_eq!(committed, "Check the logs");
        assert_eq!(partial, "");

        // Chunk 2 fails permanently, chunk 3 succeeds -> chunk 3 commits once 2 is marked failed.
        let (committed, partial) = agg.record(3, Ok("now".into()));
        assert_eq!(committed, "Check the logs");
        assert_eq!(partial, "now");
        let (committed, partial) = agg.record(2, Err("timeout".into()));
        assert_eq!(committed, "Check the logs now");
        assert_eq!(partial, "");
        assert_eq!(agg.finish().unwrap(), "Check the logs now");

        // All chunks failing surfaces the error.
        let mut failed_all = ChunkAggregator::default();
        failed_all.record(0, Err("network down".into()));
        assert_eq!(failed_all.finish().unwrap_err(), "network down");
    }

    struct ScriptedCapture {
        frames: VecDeque<Vec<u8>>,
        stop_capture: Option<CancellationToken>,
        stop_after_empty: bool,
        stopped: Arc<AtomicBool>,
    }

    impl CaptureAudio for ScriptedCapture {
        fn start(&mut self) -> Result<(), String> {
            Ok(())
        }

        fn microphone(&mut self) -> Result<Vec<u8>, String> {
            if let Some(frame) = self.frames.pop_front() {
                return Ok(frame);
            }
            if self.stop_after_empty
                && let Some(stop) = self.stop_capture.take()
            {
                stop.cancel();
            }
            Ok(vec![])
        }

        fn stop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
        }
    }

    struct ScriptedAsrBackend {
        chunk_calls: AtomicUsize,
        fail_first_attempts: usize,
        chunk_replies: Mutex<VecDeque<String>>,
        polish_reply: Mutex<Option<Result<String, ApiError>>>,
        polish_started: Arc<tokio::sync::Notify>,
        polish_release: Arc<tokio::sync::Notify>,
    }

    impl AsrBackend for ScriptedAsrBackend {
        fn transcribe_wav_async(&self, wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>> {
            assert!(wav.starts_with(b"RIFF"));
            let call_idx = self.chunk_calls.fetch_add(1, Ordering::SeqCst);
            if call_idx < self.fail_first_attempts {
                return Box::pin(async { Err(ApiError::new(BizCode::VoiceCallFailed, "transient error")) });
            }
            let text = self.chunk_replies.lock().pop_front().unwrap_or_default();
            Box::pin(async move { Ok(text) })
        }

        fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>> {
            let reply = self.polish_reply.lock().take();
            let started = self.polish_started.clone();
            let release = self.polish_release.clone();
            Box::pin(async move {
                started.notify_one();
                release.notified().await;
                reply.unwrap_or(Ok(raw))
            })
        }
    }

    #[derive(Default)]
    struct RecordedHooks {
        phases: Vec<Phase>,
        transcripts: Vec<(String, String)>,
        polished: Option<(String, String)>,
    }

    impl ChunkHooks for RecordedHooks {
        fn on_phase(&mut self, phase: Phase) {
            self.phases.push(phase);
        }
        fn on_mic_level(&mut self, _level: f64) {}
        fn on_transcript(&mut self, committed: String, partial: String) {
            self.transcripts.push((committed, partial));
        }
        fn on_polished(&mut self, raw: String, polished: String) {
            self.polished = Some((raw, polished));
        }
    }

    #[tokio::test]
    async fn chunked_asr_retries_transient_failure_streams_progressively_and_polishes() {
        let stop_capture = CancellationToken::new();
        let abort = CancellationToken::new();
        let stopped = Arc::new(AtomicBool::new(false));

        // Chunk 0: 1.4s speech + 500ms pause -> emits while recording.
        // Chunk 1: 400ms speech tail -> flushed on stop.
        let mut frames = VecDeque::new();
        frames.push_back(pcm_tone(1_400, 4_096));
        frames.push_back(pcm_tone(500, 0));
        frames.push_back(pcm_tone(400, 4_096));

        let capture = ScriptedCapture {
            frames,
            stop_capture: Some(stop_capture.clone()),
            stop_after_empty: true,
            stopped: stopped.clone(),
        };

        let polish_started = Arc::new(tokio::sync::Notify::new());
        let polish_release = Arc::new(tokio::sync::Notify::new());
        let backend = Arc::new(ScriptedAsrBackend {
            chunk_calls: AtomicUsize::new(0),
            fail_first_attempts: 2, // Chunk 0 fails twice transiently and succeeds on 3rd attempt.
            chunk_replies: Mutex::new(VecDeque::from(["呃那个 我想".to_string(), "看一下日志".to_string()])),
            polish_reply: Mutex::new(Some(Ok("我想看一下日志。".to_string()))),
            polish_started: polish_started.clone(),
            polish_release: polish_release.clone(),
        });

        let release_task = {
            let polish_started = polish_started.clone();
            let polish_release = polish_release.clone();
            tokio::spawn(async move {
                polish_started.notified().await;
                polish_release.notify_one();
            })
        };

        let mut hooks = RecordedHooks::default();
        run_chunked_with(
            capture,
            backend.clone(),
            (stop_capture, abort),
            ChunkRunOptions {
                tick_interval: Duration::from_millis(10),
                retry_base_ms: 1,
            },
            &mut hooks,
        )
        .await
        .unwrap();
        release_task.await.unwrap();

        assert!(stopped.load(Ordering::SeqCst));
        // 2 failed attempts + 1 success for chunk 0 + 1 success for chunk 1 = 4 calls.
        assert_eq!(backend.chunk_calls.load(Ordering::SeqCst), 4);
        assert_eq!(hooks.phases, vec![Phase::Listening, Phase::Finishing, Phase::Polishing]);
        assert!(hooks.transcripts.iter().any(|(c, _)| c == "呃那个 我想"));
        assert_eq!(hooks.polished, Some(("呃那个 我想看一下日志".to_string(), "我想看一下日志。".to_string())));
    }

    #[tokio::test]
    async fn chunked_asr_preserves_raw_transcript_when_polish_fails_or_non_retryable() {
        let stop_capture = CancellationToken::new();
        let abort = CancellationToken::new();
        let capture = ScriptedCapture {
            frames: VecDeque::from([pcm_tone(400, 4_096)]),
            stop_capture: Some(stop_capture.clone()),
            stop_after_empty: true,
            stopped: Arc::new(AtomicBool::new(false)),
        };

        let polish_started = Arc::new(tokio::sync::Notify::new());
        let polish_release = Arc::new(tokio::sync::Notify::new());
        let backend = Arc::new(ScriptedAsrBackend {
            chunk_calls: AtomicUsize::new(0),
            fail_first_attempts: 0,
            chunk_replies: Mutex::new(VecDeque::from(["raw chunk text".to_string()])),
            polish_reply: Mutex::new(Some(Err(ApiError::new(BizCode::VoiceCallFailed, "polish failed")))),
            polish_started: polish_started.clone(),
            polish_release: polish_release.clone(),
        });

        let release_task = tokio::spawn(async move {
            polish_started.notified().await;
            polish_release.notify_one();
        });

        let mut hooks = RecordedHooks::default();
        run_chunked_with(
            capture,
            backend,
            (stop_capture, abort),
            ChunkRunOptions {
                tick_interval: Duration::from_millis(10),
                retry_base_ms: 1,
            },
            &mut hooks,
        )
        .await
        .unwrap();
        release_task.await.unwrap();

        assert_eq!(hooks.polished, Some(("raw chunk text".to_string(), "raw chunk text".to_string())));

        // Non-retryable VoiceUnavailable does NOT retry.
        struct NonRetryableBackend(AtomicUsize);
        impl AsrBackend for NonRetryableBackend {
            fn transcribe_wav_async(&self, _wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(ApiError::new(BizCode::VoiceUnavailable, "missing key")) })
            }
            fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>> {
                Box::pin(async move { Ok(raw) })
            }
        }
        let non_retry = NonRetryableBackend(AtomicUsize::new(0));
        let err = transcribe_chunk_with_retry(&non_retry, vec![0; 48], &CancellationToken::new(), 1)
            .await
            .unwrap_err();
        assert_eq!(err, "missing key");
        assert_eq!(non_retry.0.load(Ordering::SeqCst), 1);
    }

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
