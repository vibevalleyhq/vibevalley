//! Multi-speaker dialogue, voice design, voice cloning, and transcription on
//! the media job engine.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::time::Instant;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, MediaAudioJob, MediaAudioResult, MediaAudioSegment, MediaCloneRequest, MediaInputKind, MediaInputPhase, MediaInputReference, MediaSource,
    MediaSpeakersRequest, MediaTranscriptionRequest, MediaVoiceDesignRequest, Preview,
};

use super::Stop;
use super::job::{Ask, Held, Media, Phase, Record, active, id_ok, refused};
use super::vendor::{Account, Moss, MossBody, Outcome, StreamError, TranscriptionEvent, VendorError};
use crate::log::spawn_blocking_traced;
use crate::setting::Use;

const SAMPLE_MAX: i64 = 10_000_000;
const SAMPLE_SECONDS: f64 = 30.0;
const CHECKPOINT: Duration = Duration::from_millis(200);

fn invalid() -> ApiError {
    refused("audioInvalid")
}

fn sample_format(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/wav" => Some("wav"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        "audio/flac" => Some("flac"),
        _ => None,
    }
}

fn transcription_body(model: &str, file: &str, request: &MediaTranscriptionRequest) -> Result<MossBody, VendorError> {
    Moss::prepare_transcription(model, file, request.diarize, request.keyterms.as_ref())
}

macro_rules! audio_job {
    ($variant:ident, $r:expr, $request:expr, $prompt:expr) => {
        MediaAudioJob::$variant {
            id: $r.id().to_string(),
            prompt: $prompt,
            model: $r.model.clone(),
            connection: $r.connection.clone(),
            revision: $r.revision,
            source: $r.source.clone(),
            phase: $r.phase.shown(),
            phase_text: $r.phase_text(),
            problem: $r.problem.clone(),
            format: $r.result_format,
            content_type: $r.content_type.clone(),
            metadata: $r.metadata.clone(),
            usage: $r.usage.clone().and_then(|u| serde_json::from_value(u).ok()),
            input: $r.input.clone(),
            result_input: $r.result_input.clone(),
            attachment: $r.attachment.clone(),
            preview_input: $r.preview_input.clone(),
            result: $r.made.clone(),
            can_cancel: active($r.phase),
            can_retry_download: $r.can_retry_download(),
            can_resume: $r.can_resume(),
            can_cleanup: $r.can_cleanup_audio(),
            can_release: $r.can_release(),
            created_at: $r.created_at,
            updated_at: $r.updated_at,
            request: $request.clone(),
        }
    };
}

impl Record {
    fn can_cleanup_audio(&self) -> bool {
        matches!(self.phase, Phase::Ready | Phase::Failed) && self.remote.iter().any(|f| f.kept())
    }

    pub(super) fn audio_view(&self) -> Option<MediaAudioJob> {
        Some(match &self.ask {
            Ask::Speakers(q) => {
                let lines: Vec<String> = q.segments.iter().map(|s| format!("{}: {}", s.speaker, s.text)).collect();
                audio_job!(Speakers, self, q, lines.join("\n"))
            }
            Ask::VoiceDesign(q) => audio_job!(VoiceDesign, self, q, q.text.clone()),
            Ask::Clone(q) => audio_job!(Clone, self, q, q.name.clone().unwrap_or_default()),
            Ask::Transcription(q) => audio_job!(Transcription, self, q, self.input.as_ref().map(|i| i.name.clone()).unwrap_or_default()),
            Ask::Image(_) | Ask::Speech(_) | Ask::Understanding(_) => return None,
        })
    }
}

fn shown(r: &Record) -> Result<MediaAudioJob, ApiError> {
    r.audio_view().ok_or_else(|| refused("missing"))
}

impl Media {
    pub async fn speakers_async(&self, request: MediaSpeakersRequest, source: MediaSource) -> Result<MediaAudioJob, ApiError> {
        self.audio_async(Ask::Speakers(request), source).await
    }

    pub async fn voice_design_async(&self, request: MediaVoiceDesignRequest, source: MediaSource) -> Result<MediaAudioJob, ApiError> {
        self.audio_async(Ask::VoiceDesign(request), source).await
    }

    pub async fn clone_voice_async(&self, request: MediaCloneRequest) -> Result<MediaAudioJob, ApiError> {
        self.audio_async(Ask::Clone(request), MediaSource::User {}).await
    }

    pub async fn transcription_async(&self, request: MediaTranscriptionRequest) -> Result<MediaAudioJob, ApiError> {
        self.audio_async(Ask::Transcription(request), MediaSource::User {}).await
    }

    async fn audio_async(&self, ask: Ask, source: MediaSource) -> Result<MediaAudioJob, ApiError> {
        self.open_for_work()?;
        if !id_ok(ask.id()) {
            return Err(invalid());
        }
        if let MediaSource::Orchestrator { agent, channel } = &source
            && (agent.is_empty() || channel.is_empty())
        {
            return Err(invalid());
        }
        if let Some(old) = self.known_async(&ask, |old| old.source == source).await? {
            return shown(&old);
        }
        let changed = || refused("audioAccountChanged");
        let (account, connection, revision) = match &ask {
            Ask::Speakers(q) => (self.bound(Use::Speakers)?, &q.connection, q.revision),
            Ask::VoiceDesign(q) => (self.bound(Use::VoiceDesign)?, &q.connection, q.revision),
            Ask::Transcription(q) => (self.bound(Use::Transcription)?, &q.connection, q.revision),
            Ask::Clone(q) => (self.on_connection(&q.connection).ok_or_else(changed)?, &q.connection, q.revision),
            Ask::Image(_) | Ask::Speech(_) | Ask::Understanding(_) => return Err(invalid()),
        };
        if account.connection != *connection || account.revision != revision {
            return Err(changed());
        }
        let model = account.model.as_str();
        let input = match &ask {
            Ask::Speakers(q) => {
                Moss::prepare_speakers(model, &q.speakers, &q.segments, q.format.as_str()).map_err(|_| invalid())?;
                None
            }
            Ask::VoiceDesign(q) => {
                Moss::prepare_design(model, &q.text, &q.instruction, q.format.as_str()).map_err(|_| invalid())?;
                None
            }
            Ask::Clone(q) => {
                if q.name.as_ref().is_some_and(|n| !(1..=1000).contains(&n.chars().count())) {
                    return Err(invalid());
                }
                let input = self.audio_input_async(&q.input).await?;
                self.sample_async(&input).await?;
                Some(input)
            }
            Ask::Transcription(q) => {
                let input = self.audio_input_async(&q.input).await?;
                let body = transcription_body(model, "file", q).map_err(|_| invalid())?;
                if q.streaming == Some(true) && !Moss::streams_transcripts(&body) {
                    return Err(invalid());
                }
                Some(input)
            }
            Ask::Image(_) | Ask::Speech(_) | Ask::Understanding(_) => None,
        };
        let mut r = Record::new(
            ask,
            source,
            account.connection.clone(),
            account.revision,
            account.model.clone(),
            account.fingerprint.clone(),
            self.now_ms(),
        );
        r.input = input;
        shown(&self.admit_async(r, Some(Held::Account(account))).await?)
    }

    async fn audio_input_async(&self, id: &str) -> Result<MediaInputReference, ApiError> {
        let input = self.storage.get_input_async(id).await.map_err(|_| invalid())?;
        match (input.kind, input.phase, input.hash) {
            (MediaInputKind::Audio, MediaInputPhase::Ready, Some(hash)) => Ok(MediaInputReference {
                id: input.id,
                kind: input.kind,
                name: input.name,
                mime: input.mime,
                size: input.size,
                hash,
            }),
            _ => Err(invalid()),
        }
    }

    async fn sample_async(&self, input: &MediaInputReference) -> Result<(Vec<u8>, String), ApiError> {
        let format = sample_format(&input.mime).filter(|_| input.size <= SAMPLE_MAX).ok_or_else(invalid)?;
        let content = self.storage.input_content_async(&input.id).await.map_err(|_| invalid())?;
        let mime = input.mime.clone();
        let bytes = tokio::fs::read(&content.path).await.map_err(|_| invalid())?;
        let bytes_for_probe = bytes.clone();
        let facts = spawn_blocking_traced(move || super::validate::audio_facts(bytes_for_probe, &mime))
            .await
            .map_err(|_| invalid())?
            .map_err(|_| invalid())?;
        if facts.seconds > SAMPLE_SECONDS {
            return Err(invalid());
        }
        Ok((bytes, format!("sample.{format}")))
    }

    pub(super) async fn generate_audio_async(self: &Arc<Self>, r: &Record, account: &Account, stop: &Stop) {
        let id = r.id();
        let model = account.model.as_str();
        match &r.ask {
            Ask::Speakers(q) => match Moss::prepare_speakers(model, &q.speakers, &q.segments, q.format.as_str()) {
                Ok(body) => self.follow_async(id, &account.key, "/audio/speech/speakers", &body, stop).await,
                Err(e) => self.failed_async(id, e.outcome).await,
            },
            Ask::VoiceDesign(q) => match Moss::prepare_design(model, &q.text, &q.instruction, q.format.as_str()) {
                Ok(body) => self.follow_async(id, &account.key, "/audio/voice/generations", &body, stop).await,
                Err(e) => self.failed_async(id, e.outcome).await,
            },
            Ask::Clone(q) => {
                let sample = match r.input.as_ref() {
                    Some(i) => self.sample_async(i).await,
                    None => Err(invalid()),
                };
                let Ok((bytes, name)) = sample else {
                    return self.failed_async(id, Outcome::NotSubmitted).await;
                };
                match self.moss.clone_voice(&account.key, bytes, &name, q.name.as_deref(), stop).await {
                    // Once cloned, record the voice regardless of concurrent cancellation.
                    Ok(voice) => {
                        let _ = self
                            .change_async(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| {
                                r.made = Some(MediaAudioResult::Clone { voice });
                                r.phase = Phase::Ready;
                                r.problem.clear();
                            })
                            .await;
                    }
                    Err(e) if !stop.aborted() => self.failed_async(id, e.outcome).await,
                    Err(_) => {}
                }
            }
            Ask::Transcription(q) => {
                let Some(input) = &r.input else {
                    return self.failed_async(id, Outcome::NotSubmitted).await;
                };
                let file = match self.upload_async(id, input, account, stop).await {
                    Ok(file) => file,
                    Err(outcome) => return self.failed_async(id, outcome).await,
                };
                let body = match transcription_body(model, &file, q) {
                    Ok(body) => body,
                    Err(e) => return self.failed_async(id, e.outcome).await,
                };
                if stop.aborted() {
                    return;
                }
                if q.streaming == Some(true) {
                    self.receive_transcript_async(id, account, &body, stop).await;
                } else {
                    self.follow_async(id, &account.key, "/audio/transcriptions", &body, stop).await;
                }
            }
            Ask::Image(_) | Ask::Speech(_) | Ask::Understanding(_) => self.failed_async(id, Outcome::Unknown).await,
        }
    }

    async fn receive_transcript_async(&self, id: &str, account: &Account, body: &MossBody, stop: &Stop) {
        let mut text = String::new();
        let mut segments: Vec<MediaAudioSegment> = vec![];
        let mut seen: HashSet<i64> = HashSet::new();
        let mut usage: Option<Value> = None;
        let mut saved: Option<Instant> = None;
        let mut dirty = false;
        let (tx, mut rx) = tokio::sync::mpsc::channel::<TranscriptionEvent>(32);
        let moss = self.moss.clone();
        let key = account.key.clone();
        let body = body.clone();
        let stop_stream = stop.clone();
        let stream_task = self.ctx.spawn("media.transcription.stream", async move {
            moss.transcription_stream(&key, &body, &stop_stream, tx).await
        });
        let mut mine_error = false;
        while let Some(event) = rx.recv().await {
            match event {
                TranscriptionEvent::TaskCreated(task) => {
                    let _ = self
                        .change_async(id, &[Phase::Generating, Phase::Canceled], |r| r.remote_task = Some(task))
                        .await;
                }
                TranscriptionEvent::Delta(more) => {
                    text.push_str(&more);
                    dirty = true;
                    if saved.is_none_or(|at| at.elapsed() >= CHECKPOINT) {
                        self.save_transcript_async(id, &text, &segments, &usage, false).await;
                        saved = Some(Instant::now());
                        dirty = false;
                    }
                }
                TranscriptionEvent::Segment { index, segment, usage: said } => {
                    if !seen.insert(index) {
                        mine_error = true;
                        break;
                    }
                    segments.push(segment);
                    usage = said.or(usage.take());
                    self.save_transcript_async(id, &text, &segments, &usage, false).await;
                    saved = Some(Instant::now());
                    dirty = false;
                }
                TranscriptionEvent::Done { text: whole, usage: said } => {
                    text = whole;
                    usage = said.or(usage.take());
                    self.save_transcript_async(id, &text, &segments, &usage, true).await;
                    dirty = false;
                }
            }
        }
        drop(rx);
        let streamed = stream_task.await;
        if dirty {
            self.save_transcript_async(id, &text, &segments, &usage, false).await;
        }
        if mine_error {
            self.failed_async(id, Outcome::Unknown).await;
            return;
        }
        match streamed {
            Ok(Ok(()) | Err(StreamError::Stopped)) => {}
            Ok(Err(StreamError::Vendor(e))) => self.failed_async(id, e.outcome).await,
            Ok(Err(StreamError::Mine(_))) | Err(_) => self.failed_async(id, Outcome::Unknown).await,
        }
    }

    async fn save_transcript_async(&self, id: &str, text: &str, segments: &[MediaAudioSegment], usage: &Option<Value>, complete: bool) {
        if !complete {
            let _ = self
                .change_async(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| {
                    r.made = Some(MediaAudioResult::Transcription {
                        text: text.to_string(),
                        segments: segments.to_vec(),
                    });
                    r.usage = usage.clone();
                })
                .await;
            return;
        }
        let ready = self
            .change_async(id, &[Phase::Generating], |r| {
                r.made = Some(MediaAudioResult::Transcription {
                    text: text.to_string(),
                    segments: segments.to_vec(),
                });
                r.usage = usage.clone();
                r.phase = Phase::Ready;
                r.problem.clear();
            })
            .await;
        if !matches!(ready, Ok(true)) {
            let _ = self
                .change_async(id, &[Phase::Canceled, Phase::Unknown], |r| {
                    r.made = Some(MediaAudioResult::Transcription {
                        text: text.to_string(),
                        segments: segments.to_vec(),
                    });
                    r.usage = usage.clone();
                })
                .await;
        }
    }

    pub(super) async fn tidy_audio_async(&self, id: &str) {
        let _one = self.cleaning.lock().await;
        let Ok(r) = self.found_async(id).await else { return };
        let ended = matches!(r.phase, Phase::Ready | Phase::Failed) || (r.phase == Phase::Canceled && r.remote_task.is_none());
        if !ended || r.remote.iter().any(|f| f.unresolved()) {
            return;
        }
        let pending = t("server.media.audioCleanupPending", &[]);
        let cleaned = match self.remove_remote_async(id).await {
            Ok(()) => {
                if r.input.is_some() && r.made.is_none() {
                    self.storage.release_input_pins_async(id).await
                } else {
                    Ok(())
                }
            }
            Err(e) => Err(e),
        };
        let said = match cleaned {
            Ok(()) if r.problem == pending => String::new(),
            Ok(()) => return,
            Err(e) => {
                eprintln!("media {id}: cleanup is pending: {}", e.message);
                pending
            }
        };
        if let Err(e) = self
            .change_async(id, &[Phase::Ready, Phase::Failed, Phase::Canceled], |r| r.problem = said)
            .await
        {
            eprintln!("media {id}: {}", e.message);
        }
    }

    async fn audio_job_async(&self, id: &str) -> Result<Record, ApiError> {
        self.found_async(id).await.ok().filter(|r| r.ask.is_audio()).ok_or_else(|| refused("missing"))
    }

    pub async fn audio_resume_async(&self, id: &str) -> Result<MediaAudioJob, ApiError> {
        shown(&self.resumed_async(self.audio_job_async(id).await?).await?)
    }

    async fn cleanable_audio_async(&self, id: &str) -> Result<Record, ApiError> {
        let r = self.audio_job_async(id).await?;
        if !matches!(r.phase, Phase::Ready | Phase::Failed) {
            return Err(refused("busy"));
        }
        Ok(r)
    }

    pub async fn preview_audio_cleanup_async(&self, id: &str) -> Result<Preview, ApiError> {
        let r = self.cleanable_audio_async(id).await?;
        let count = r.remote.iter().filter(|f| f.kept()).count() as i64;
        let does = if count == 0 {
            vec![]
        } else {
            vec![t(
                "server.media.cleanupPreview",
                &[("count", count.into()), ("connection", r.connection.clone().into())],
            )]
        };
        Ok(Preview { does })
    }

    pub async fn audio_cleanup_async(&self, id: &str) -> Result<MediaAudioJob, ApiError> {
        self.cleanable_audio_async(id).await?;
        self.tidy_audio_async(id).await;
        shown(&self.found_async(id).await?)
    }
}
