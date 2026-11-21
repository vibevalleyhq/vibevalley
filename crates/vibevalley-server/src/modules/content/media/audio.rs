//! Several voices, a designed voice, a cloned voice and a transcript, on the
//! job machine: what each asks of the vendor and how it is shown. The first
//! two are vendor tasks whose audio is downloaded; a clone is asked at once;
//! a transcript is a task, or a stream saved as it comes.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, MediaAudioJob, MediaAudioResult, MediaAudioSegment, MediaCloneRequest, MediaInputKind, MediaInputPhase, MediaInputReference, MediaSource,
    MediaSpeakersRequest, MediaTranscriptionRequest, MediaVoiceDesignRequest, Preview,
};

use super::Stop;
use super::jobs::{Ask, Held, Jobs, Phase, Record, active, id_ok, refused};
use super::vendor::{Account, Moss, Outcome, StreamError, TranscriptionEvent, VendorError};
use crate::modules::team::provider::Use;

/// The largest and longest sample a voice is cloned from.
const SAMPLE_MAX: i64 = 10_000_000;
const SAMPLE_SECONDS: f64 = 30.0;
/// A streamed transcript is written down this often at most, and at each segment.
const CHECKPOINT: Duration = Duration::from_millis(200);

fn invalid() -> ApiError {
    refused("audioInvalid")
}

/// The file extension the vendor clones from, by the sample's type.
fn sample_format(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/wav" => Some("wav"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        "audio/flac" => Some("flac"),
        _ => None,
    }
}

fn transcription_body(model: &str, file: &str, request: &MediaTranscriptionRequest) -> Result<Value, VendorError> {
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
    /// Ended with files still at the vendor under ids this farm knows.
    fn can_cleanup_audio(&self) -> bool {
        matches!(self.phase, Phase::Ready | Phase::Failed) && self.remote.iter().any(|f| f.kept())
    }

    /// The job as an audio job, when it is one.
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

impl Jobs {
    pub fn speakers(&self, request: MediaSpeakersRequest, source: MediaSource) -> Result<MediaAudioJob, ApiError> {
        self.audio(Ask::Speakers(request), source)
    }

    pub fn voice_design(&self, request: MediaVoiceDesignRequest, source: MediaSource) -> Result<MediaAudioJob, ApiError> {
        self.audio(Ask::VoiceDesign(request), source)
    }

    /// A voice cloned from the user's sample: only the user can say whose voice it is.
    pub fn clone_voice(&self, request: MediaCloneRequest) -> Result<MediaAudioJob, ApiError> {
        self.audio(Ask::Clone(request), MediaSource::User {})
    }

    pub fn transcription(&self, request: MediaTranscriptionRequest) -> Result<MediaAudioJob, ApiError> {
        self.audio(Ask::Transcription(request), MediaSource::User {})
    }

    fn audio(&self, ask: Ask, source: MediaSource) -> Result<MediaAudioJob, ApiError> {
        self.open_for_work()?;
        if !id_ok(ask.id()) {
            return Err(invalid());
        }
        if let MediaSource::Orchestrator { agent, channel } = &source
            && (agent.is_empty() || channel.is_empty())
        {
            return Err(invalid());
        }
        if let Some(old) = self.known(&ask, |old| old.source == source)? {
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
                let input = self.audio_input(&q.input)?;
                self.sample(&input)?;
                Some(input)
            }
            Ask::Transcription(q) => {
                let input = self.audio_input(&q.input)?;
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
        );
        r.input = input;
        shown(&self.admit(r, Some(Held::Account(account)))?)
    }

    /// The user's audio input, ready to be read.
    fn audio_input(&self, id: &str) -> Result<MediaInputReference, ApiError> {
        let input = self.inputs.get(id).map_err(|_| invalid())?;
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

    /// A sample a voice can be cloned from: its bytes and the name to send them under.
    fn sample(&self, input: &MediaInputReference) -> Result<(Vec<u8>, String), ApiError> {
        let format = sample_format(&input.mime).filter(|_| input.size <= SAMPLE_MAX).ok_or_else(invalid)?;
        let content = self.inputs.content(&input.id).map_err(|_| invalid())?;
        let bytes = std::fs::read(&content.path).map_err(|_| invalid())?;
        let facts = super::validate::audio_facts(bytes.clone(), &input.mime).map_err(|_| invalid())?;
        if facts.seconds > SAMPLE_SECONDS {
            return Err(invalid());
        }
        Ok((bytes, format!("sample.{format}")))
    }

    /// An audio job's run, from `generating`.
    pub(super) fn generate_audio(self: &Arc<Self>, r: &Record, account: &Account, stop: &Stop) {
        let id = r.id();
        let model = account.model.as_str();
        match &r.ask {
            Ask::Speakers(q) => match Moss::prepare_speakers(model, &q.speakers, &q.segments, q.format.as_str()) {
                Ok(body) => self.follow(id, &account.key, "/audio/speech/speakers", &body, stop),
                Err(e) => self.failed(id, e.outcome),
            },
            Ask::VoiceDesign(q) => match Moss::prepare_design(model, &q.text, &q.instruction, q.format.as_str()) {
                Ok(body) => self.follow(id, &account.key, "/audio/voice/generations", &body, stop),
                Err(e) => self.failed(id, e.outcome),
            },
            Ask::Clone(q) => {
                let Some(Ok((bytes, name))) = r.input.as_ref().map(|i| self.sample(i)) else {
                    return self.failed(id, Outcome::NotSubmitted);
                };
                match self.moss.clone_voice(&account.key, bytes, &name, q.name.as_deref()) {
                    // Once cloned, the voice is written down whatever stopped the job meanwhile.
                    Ok(voice) => {
                        let _ = self.change(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| {
                            r.made = Some(MediaAudioResult::Clone { voice });
                            r.phase = Phase::Ready;
                            r.problem.clear();
                        });
                    }
                    Err(e) => self.failed(id, e.outcome),
                }
            }
            Ask::Transcription(q) => {
                let Some(input) = &r.input else {
                    return self.failed(id, Outcome::NotSubmitted);
                };
                let file = match self.upload(id, input, account, stop) {
                    Ok(file) => file,
                    Err(outcome) => return self.failed(id, outcome),
                };
                let body = match transcription_body(model, &file, q) {
                    Ok(body) => body,
                    Err(e) => return self.failed(id, e.outcome),
                };
                if stop.aborted() {
                    return;
                }
                if q.streaming == Some(true) {
                    self.receive_transcript(id, account, &body, stop);
                } else {
                    self.follow(id, &account.key, "/audio/transcriptions", &body, stop);
                }
            }
            Ask::Image(_) | Ask::Speech(_) | Ask::Understanding(_) => self.failed(id, Outcome::Unknown),
        }
    }

    /// The vendor's transcript as it comes, written down at each segment and at most every 200 ms between; cut short,
    /// what came stays on the job, which is then unknown and never asked for again.
    fn receive_transcript(&self, id: &str, account: &Account, body: &Value, stop: &Stop) {
        let mut text = String::new();
        let mut segments: Vec<MediaAudioSegment> = vec![];
        let mut seen: HashSet<i64> = HashSet::new();
        let mut usage: Option<Value> = None;
        let mut saved: Option<Instant> = None;
        let mut dirty = false;
        let save = |text: &str, segments: &[MediaAudioSegment], usage: &Option<Value>, complete: bool| {
            let patch = |r: &mut Record| {
                r.made = Some(MediaAudioResult::Transcription {
                    text: text.to_string(),
                    segments: segments.to_vec(),
                });
                r.usage = usage.clone();
            };
            if !complete {
                let _ = self.change(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], patch);
                return;
            }
            let ready = self.change(id, &[Phase::Generating], |r| {
                patch(r);
                r.phase = Phase::Ready;
                r.problem.clear();
            });
            if !matches!(ready, Ok(true)) {
                let _ = self.change(id, &[Phase::Canceled, Phase::Unknown], patch);
            }
        };
        let streamed = self.moss.transcription_stream(&account.key, body, stop, &mut |event| {
            match event {
                TranscriptionEvent::TaskCreated(task) => {
                    let _ = self.change(id, &[Phase::Generating, Phase::Canceled], |r| r.remote_task = Some(task));
                }
                TranscriptionEvent::Delta(more) => {
                    text.push_str(&more);
                    dirty = true;
                    if saved.is_none_or(|at| at.elapsed() >= CHECKPOINT) {
                        save(&text, &segments, &usage, false);
                        saved = Some(Instant::now());
                        dirty = false;
                    }
                }
                TranscriptionEvent::Segment { index, segment, usage: said } => {
                    if !seen.insert(index) {
                        return Err("a segment twice".into());
                    }
                    segments.push(segment);
                    usage = said.or(usage.take());
                    save(&text, &segments, &usage, false);
                    saved = Some(Instant::now());
                    dirty = false;
                }
                TranscriptionEvent::Done { text: whole, usage: said } => {
                    text = whole;
                    usage = said.or(usage.take());
                    save(&text, &segments, &usage, true);
                    dirty = false;
                }
            }
            Ok(())
        });
        if dirty {
            save(&text, &segments, &usage, false);
        }
        match streamed {
            Ok(()) | Err(StreamError::Stopped) => {}
            Err(StreamError::Vendor(e)) => self.failed(id, e.outcome),
            Err(StreamError::Mine(_)) => self.failed(id, Outcome::Unknown),
        }
    }

    /// An ended audio job lets go of what it sent to the vendor, and of the input it made nothing of; a result keeps
    /// its source until the user releases the job. A cleanup that fails is said on the job and can be asked again.
    pub(super) fn tidy_audio(&self, id: &str) {
        let _one = self.cleaning.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(r) = self.found(id) else { return };
        let ended = matches!(r.phase, Phase::Ready | Phase::Failed) || (r.phase == Phase::Canceled && r.remote_task.is_none());
        if !ended || r.remote.iter().any(|f| f.unresolved()) {
            return;
        }
        let pending = t("server.media.audioCleanupPending", &[]);
        let cleaned = self.remove_remote(id).and_then(|()| {
            if r.input.is_some() && r.made.is_none() {
                self.inputs.release(id)?;
            }
            Ok(())
        });
        let said = match cleaned {
            Ok(()) if r.problem == pending => String::new(),
            Ok(()) => return,
            Err(e) => {
                eprintln!("media {id}: cleanup is pending: {}", e.message);
                pending
            }
        };
        if let Err(e) = self.change(id, &[Phase::Ready, Phase::Failed, Phase::Canceled], |r| r.problem = said) {
            eprintln!("media {id}: {}", e.message);
        }
    }

    fn audio_job(&self, id: &str) -> Result<Record, ApiError> {
        self.found(id).ok().filter(|r| r.ask.is_audio()).ok_or_else(|| refused("missing"))
    }

    /// `media.audio.resume`: the known vendor task asked again.
    pub fn audio_resume(&self, id: &str) -> Result<MediaAudioJob, ApiError> {
        shown(&self.resumed(self.audio_job(id)?)?)
    }

    /// The ended job whose vendor files a cleanup would delete.
    fn cleanable_audio(&self, id: &str) -> Result<Record, ApiError> {
        let r = self.audio_job(id)?;
        if !matches!(r.phase, Phase::Ready | Phase::Failed) {
            return Err(refused("busy"));
        }
        Ok(r)
    }

    pub fn preview_audio_cleanup(&self, id: &str) -> Result<Preview, ApiError> {
        let r = self.cleanable_audio(id)?;
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

    pub fn audio_cleanup(&self, id: &str) -> Result<MediaAudioJob, ApiError> {
        self.cleanable_audio(id)?;
        self.tidy_audio(id);
        shown(&self.found(id)?)
    }
}
