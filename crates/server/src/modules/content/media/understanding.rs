//! Understanding images and video, on the job machine: the user's inputs
//! are uploaded to the vendor, asked about once, and deleted there after.
//! An orchestrator starts only what the user approved for its channel.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, LitFalse, MediaCleanup, MediaInputKind, MediaInputPhase, MediaInputReference, MediaSource, MediaUnderstandingAuthorization,
    MediaUnderstandingAuthorizationRequest, MediaUnderstandingJob, MediaUnderstandingJobKind, MediaUnderstandingRequest, MediaUnderstandingStatus, Preview,
};

use super::Stop;
use super::jobs::{Ask, Held, Jobs, Phase, Record, active, id_ok, refused};
use super::vendor::{Account, Moss, Outcome};
use crate::modules::infra::provider::Use;
use crate::now;

/// How long the user's approval waits for the orchestrator.
const APPROVAL: i64 = 15 * 60_000;

/// The user's leave for an orchestrator in `channel` to start the job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Authorization {
    pub(super) channel: String,
    expires_at: i64,
}

fn invalid() -> ApiError {
    refused("inputInvalid")
}

fn media(inputs: &[MediaInputReference], file: impl Fn(&MediaInputReference) -> String) -> Vec<(MediaInputKind, String)> {
    inputs.iter().map(|i| (i.kind, file(i))).collect()
}

impl Record {
    pub(super) fn understanding_view(&self, request: &MediaUnderstandingRequest) -> MediaUnderstandingJob {
        let cleanup = self.cleanup.unwrap_or(MediaCleanup::Pending);
        MediaUnderstandingJob {
            kind: MediaUnderstandingJobKind::Understanding,
            id: request.id.clone(),
            prompt: request.prompt.clone(),
            inputs: self.inputs.clone(),
            model: self.model.clone(),
            connection: self.connection.clone(),
            revision: self.revision,
            source: self.source.clone(),
            authorization: self.authorization.as_ref().map(|a| MediaUnderstandingAuthorization {
                channel: a.channel.clone(),
                expires_at: a.expires_at,
            }),
            phase: self.phase.understanding(),
            phase_text: t(&format!("server.media.understandingPhase.{}", self.phase.understanding().as_str()), &[]),
            problem: self.problem.clone(),
            result: self.understood.clone(),
            cleanup,
            cleanup_text: t(&format!("server.media.cleanup.{}", cleanup.as_str()), &[]),
            can_cancel: active(self.phase),
            can_cleanup: !active(self.phase) && matches!(cleanup, MediaCleanup::Pending | MediaCleanup::Blocked),
            can_retry_download: LitFalse,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

fn shown(r: &Record) -> Result<MediaUnderstandingJob, ApiError> {
    match &r.ask {
        Ask::Understanding(request) => Ok(r.understanding_view(request)),
        _ => Err(refused("missing")),
    }
}

impl Jobs {
    /// `media.understanding.create`: the user asks, and it runs at once.
    pub fn understanding(&self, request: MediaUnderstandingRequest) -> Result<MediaUnderstandingJob, ApiError> {
        self.understanding_for(request, None)
    }

    /// `media.understanding.authorize`: the user approves the upload for an orchestrator in `channel` to start.
    pub fn authorize_understanding(&self, r: MediaUnderstandingAuthorizationRequest) -> Result<MediaUnderstandingJob, ApiError> {
        if self.chat.place(&r.channel).is_none() {
            return Err(invalid());
        }
        let request = MediaUnderstandingRequest {
            id: r.id,
            prompt: r.prompt,
            inputs: r.inputs,
            connection: r.connection,
            revision: r.revision,
            allow_upload: r.allow_upload,
            max_output_tokens: r.max_output_tokens,
        };
        self.understanding_for(request, Some(r.channel))
    }

    fn understanding_for(&self, request: MediaUnderstandingRequest, channel: Option<String>) -> Result<MediaUnderstandingJob, ApiError> {
        self.open_for_work()?;
        if !id_ok(&request.id) {
            return Err(invalid());
        }
        let ask = Ask::Understanding(request);
        if let Some(old) = self.known(&ask, |old| old.authorization.as_ref().map(|a| &a.channel) == channel.as_ref())? {
            return shown(&old);
        }
        let Ask::Understanding(request) = &ask else { unreachable!() };
        let account = self.bound(Use::Understanding)?;
        if request.connection != account.connection || request.revision != account.revision {
            return Err(refused("consentChanged"));
        }
        let mut inputs: Vec<MediaInputReference> = vec![];
        for id in &request.inputs {
            if inputs.iter().any(|i| i.id == *id) {
                return Err(invalid());
            }
            let input = self.inputs.get(id).map_err(|_| invalid())?;
            let (MediaInputPhase::Ready, Some(hash)) = (input.phase, input.hash) else {
                return Err(invalid());
            };
            inputs.push(MediaInputReference {
                id: input.id,
                kind: input.kind,
                name: input.name,
                mime: input.mime,
                size: input.size,
                hash,
            });
        }
        Moss::prepare_understanding(&account.model, &request.prompt, &media(&inputs, |i| i.id.clone()), request.max_output_tokens).map_err(|_| invalid())?;
        let mut r = Record::new(
            ask,
            MediaSource::User {},
            account.connection.clone(),
            account.revision,
            account.model.clone(),
            account.fingerprint.clone(),
        );
        r.inputs = inputs;
        r.cleanup = Some(MediaCleanup::Pending);
        // An approved job waits for its orchestrator; the key is read again when it starts.
        let held = match channel {
            Some(channel) => {
                r.phase = Phase::Authorized;
                r.authorization = Some(Authorization {
                    channel,
                    expires_at: now() + APPROVAL,
                });
                None
            }
            None => Some(Held::Account(account)),
        };
        shown(&self.admit(r, held)?)
    }

    /// `media.understanding.start`: an orchestrator, with the user's word in this batch, starts what the user approved
    /// for its channel. Asked again it is the same job; nothing is uploaded twice.
    pub fn start_understanding(&self, id: &str, agent: &str, channel: &str) -> Result<MediaUnderstandingJob, ApiError> {
        self.open_for_work()?;
        let unapproved = || refused("authorizationRequired");
        let r = self.found(id)?;
        let Some(approval) = r
            .authorization
            .as_ref()
            .filter(|a| a.channel == channel && matches!(r.ask, Ask::Understanding(_)))
        else {
            return Err(unapproved());
        };
        let source = MediaSource::Orchestrator {
            agent: agent.into(),
            channel: channel.into(),
        };
        if r.phase != Phase::Authorized {
            if matches!(r.source, MediaSource::Orchestrator { .. }) && r.source != source {
                return Err(unapproved());
            }
            return shown(&r);
        }
        let account = self
            .bound(Use::Understanding)
            .ok()
            .filter(|a| {
                approval.expires_at > now() && a.connection == r.connection && a.revision == r.revision && a.model == r.model && a.fingerprint == r.fingerprint
            })
            .ok_or_else(|| refused("consentChanged"))?;
        if self.change(id, &[Phase::Authorized], |r| {
            r.source = source;
            r.phase = Phase::Queued;
        })? {
            self.hold(id, Held::Account(account));
            self.schedule();
        }
        shown(&self.found(id)?)
    }

    pub fn start_understanding_by_id(&self, id: &str) -> Result<MediaUnderstandingJob, ApiError> {
        let r = self.found(id)?;
        let channel = r
            .authorization
            .as_ref()
            .map(|a| a.channel.clone())
            .ok_or_else(|| refused("authorizationRequired"))?;
        let agent = self.chat.orchestrator_in(&channel);
        self.start_understanding(id, &agent, &channel)
    }

    /// An understanding job's run, from `uploading`.
    pub(super) fn understand(self: &Arc<Self>, r: &Record, request: &MediaUnderstandingRequest, account: &Account, stop: &Stop) {
        let id = r.id();
        let mut files = vec![];
        for input in &r.inputs {
            match self.upload(id, input, account, stop) {
                Ok(file) => files.push(file),
                Err(outcome) => {
                    let (phase, key) = match outcome {
                        Outcome::Unknown => (Phase::Unknown, "remoteUploadUnknown"),
                        Outcome::Rejected | Outcome::NotSubmitted => (Phase::Failed, "remoteUploadRejected"),
                    };
                    let _ = self.change(id, &[Phase::Uploading], |r| {
                        r.phase = phase;
                        r.problem = t(&format!("server.media.{key}"), &[]);
                    });
                    return;
                }
            }
        }
        if !matches!(self.change(id, &[Phase::Uploading], |r| r.phase = Phase::Generating), Ok(true)) {
            return;
        }
        let sent: Vec<(MediaInputKind, String)> = r.inputs.iter().map(|i| i.kind).zip(files).collect();
        let answer = Moss::prepare_understanding(&account.model, &request.prompt, &sent, request.max_output_tokens)
            .and_then(|body| self.moss.understand(&account.key, &body));
        match answer {
            Ok(result) => {
                let answered = self.change(id, &[Phase::Generating], |r| {
                    r.phase = match result.status {
                        MediaUnderstandingStatus::Completed => Phase::Ready,
                        MediaUnderstandingStatus::Incomplete => Phase::Incomplete,
                    };
                    r.understood = Some(result);
                    r.cleanup = Some(MediaCleanup::Running);
                    r.problem.clear();
                });
                if matches!(answered, Ok(true)) {
                    self.tidy_understanding(id);
                }
            }
            Err(e) => self.failed(id, e.outcome),
        }
    }

    /// What the job uploaded goes at the vendor and its inputs are let go; a file the vendor never answered for
    /// leaves the cleanup unknown and is named, and a deletion that fails leaves it blocked, to be asked again.
    fn tidy_understanding(&self, id: &str) {
        let _one = self.cleaning.lock();
        let cleaned = self.remove_remote(id).and_then(|()| self.inputs.release(id)).and_then(|()| self.found(id));
        let wrote = match cleaned {
            Ok(r) => {
                let unresolved: Vec<&str> = r.remote.iter().filter(|f| f.unresolved()).map(|f| f.filename.as_str()).collect();
                self.change(id, &Phase::ENDED, |r| {
                    if unresolved.is_empty() {
                        r.cleanup = Some(MediaCleanup::Done);
                    } else {
                        r.cleanup = Some(MediaCleanup::Unknown);
                        r.problem = t("server.media.remoteUnresolved", &[("files", unresolved.join(", ").into())]);
                    }
                })
            }
            Err(e) => {
                eprintln!("media {id}: cleanup is blocked: {}", e.message);
                self.change(id, &Phase::ENDED, |r| r.cleanup = Some(MediaCleanup::Blocked))
            }
        };
        if let Err(e) = wrote {
            eprintln!("media {id}: {}", e.message);
        }
    }

    /// The ended understanding job, and whether a cleanup has anything left to do.
    fn cleanable(&self, id: &str) -> Result<(Record, bool), ApiError> {
        let r = self.found(id)?;
        if !matches!(r.ask, Ask::Understanding(_)) {
            return Err(refused("missing"));
        }
        if active(r.phase) || r.cleanup == Some(MediaCleanup::Running) {
            return Err(refused("busy"));
        }
        let left = !matches!(r.cleanup, Some(MediaCleanup::Done | MediaCleanup::Unknown));
        Ok((r, left))
    }

    pub fn preview_understanding_cleanup(&self, id: &str) -> Result<Preview, ApiError> {
        let (r, left) = self.cleanable(id)?;
        if !left {
            return Ok(Preview { does: vec![] });
        }
        let count = r.remote.iter().filter(|f| f.kept()).count() as i64;
        Ok(Preview {
            does: vec![
                t(
                    "server.media.cleanupPreview",
                    &[("count", count.into()), ("connection", r.connection.clone().into())],
                ),
                t("server.media.cleanupReleasePreview", &[]),
            ],
        })
    }

    pub fn understanding_cleanup(&self, id: &str) -> Result<MediaUnderstandingJob, ApiError> {
        let (r, left) = self.cleanable(id)?;
        if left && self.change(id, &[r.phase], |r| r.cleanup = Some(MediaCleanup::Running))? {
            self.tidy_understanding(id);
        }
        shown(&self.found(id)?)
    }

    /// Approvals that ran out before an orchestrator used them end here, and let go of their inputs.
    pub(super) fn expire_approvals(&self) {
        let waiting = match self.rows(async |db| super::q::authorized_jobs(db).await) {
            Ok(w) => w,
            Err(e) => return eprintln!("media: {}", e.message),
        };
        let at = now();
        for r in waiting.iter().filter(|r| r.authorization.as_ref().is_some_and(|a| a.expires_at <= at)) {
            let expired = self.change(r.id(), &[Phase::Authorized], |r| {
                r.phase = Phase::Canceled;
                r.cleanup = Some(MediaCleanup::Done);
                r.problem = t("server.media.authorizationExpired", &[]);
            });
            if matches!(expired, Ok(true)) {
                let _ = self.inputs.release(r.id());
            }
        }
    }
}
