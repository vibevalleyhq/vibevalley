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
use super::jobs::{Ask, Held, MediaStore, Phase, Record, active, id_ok, refused};
use super::vendor::{Account, Moss, Outcome};
use crate::infra::provider::Use;

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

impl MediaStore {
    /// `media.understanding.create`: the user asks, and it runs at once.
    pub async fn understanding_async(&self, request: MediaUnderstandingRequest) -> Result<MediaUnderstandingJob, ApiError> {
        self.understanding_for_async(request, None).await
    }

    /// `media.understanding.authorize`: the user approves the upload for an orchestrator in `channel` to start.
    pub async fn authorize_understanding_async(&self, r: MediaUnderstandingAuthorizationRequest) -> Result<MediaUnderstandingJob, ApiError> {
        if !self.channel.place_exists(&r.channel) {
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
        self.understanding_for_async(request, Some(r.channel)).await
    }

    async fn understanding_for_async(&self, request: MediaUnderstandingRequest, channel: Option<String>) -> Result<MediaUnderstandingJob, ApiError> {
        self.open_for_work()?;
        if !id_ok(&request.id) {
            return Err(invalid());
        }
        let ask = Ask::Understanding(request);
        if let Some(old) = self
            .known_async(&ask, |old| old.authorization.as_ref().map(|a| &a.channel) == channel.as_ref())
            .await?
        {
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
            let input = self.inputs.get_async(id).await.map_err(|_| invalid())?;
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
            self.now_ms(),
        );
        r.inputs = inputs;
        r.cleanup = Some(MediaCleanup::Pending);
        // An approved job waits for its orchestrator; the key is read again when it starts.
        let held = match channel {
            Some(channel) => {
                r.phase = Phase::Authorized;
                r.authorization = Some(Authorization {
                    channel,
                    expires_at: self.now_ms() + APPROVAL,
                });
                None
            }
            None => Some(Held::Account(account)),
        };
        shown(&self.admit_async(r, held).await?)
    }

    /// `media.understanding.start`: an orchestrator, with the user's word in this batch, starts what the user approved
    /// for its channel. Asked again it is the same job; nothing is uploaded twice.
    pub async fn start_understanding_async(&self, id: &str, agent: &str, channel: &str) -> Result<MediaUnderstandingJob, ApiError> {
        self.open_for_work()?;
        let unapproved = || refused("authorizationRequired");
        let r = self.found_async(id).await?;
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
                approval.expires_at > self.now_ms()
                    && a.connection == r.connection
                    && a.revision == r.revision
                    && a.model == r.model
                    && a.fingerprint == r.fingerprint
            })
            .ok_or_else(|| refused("consentChanged"))?;
        if self
            .change_async(id, &[Phase::Authorized], |r| {
                r.source = source;
                r.phase = Phase::Queued;
            })
            .await?
        {
            self.hold(id, Held::Account(account));
            self.schedule_async().await;
        }
        shown(&self.found_async(id).await?)
    }

    pub async fn start_understanding_by_id_async(&self, id: &str) -> Result<MediaUnderstandingJob, ApiError> {
        let r = self.found_async(id).await?;
        let channel = r
            .authorization
            .as_ref()
            .map(|a| a.channel.clone())
            .ok_or_else(|| refused("authorizationRequired"))?;
        let agent = self.channel.orchestrator_in(&channel);
        self.start_understanding_async(id, &agent, &channel).await
    }

    /// An understanding job's run, from `uploading`.
    pub(super) async fn understand_async(self: &Arc<Self>, r: &Record, request: &MediaUnderstandingRequest, account: &Account, stop: &Stop) {
        let id = r.id();
        let mut files = vec![];
        for input in &r.inputs {
            match self.upload_async(id, input, account, stop).await {
                Ok(file) => files.push(file),
                Err(outcome) => {
                    let (phase, key) = match outcome {
                        Outcome::Unknown => (Phase::Unknown, "remoteUploadUnknown"),
                        Outcome::Rejected | Outcome::NotSubmitted => (Phase::Failed, "remoteUploadRejected"),
                    };
                    let _ = self
                        .change_async(id, &[Phase::Uploading], |r| {
                            r.phase = phase;
                            r.problem = t(&format!("server.media.{key}"), &[]);
                        })
                        .await;
                    return;
                }
            }
        }
        if !matches!(self.change_async(id, &[Phase::Uploading], |r| r.phase = Phase::Generating).await, Ok(true)) {
            return;
        }
        let sent: Vec<(MediaInputKind, String)> = r.inputs.iter().map(|i| i.kind).zip(files).collect();
        let body = Moss::prepare_understanding(&account.model, &request.prompt, &sent, request.max_output_tokens);
        let answer = match body {
            Ok(body) => {
                let fetch = self.moss.fetch.clone();
                let key = account.key.clone();
                let stop_req = stop.clone();
                match crate::spawn_blocking_traced(move || Moss { fetch }.understand(&key, &body, &stop_req)).await {
                    Ok(res) => res,
                    Err(_) => Err(super::vendor::VendorError::new(super::vendor::Reason::Network, Outcome::Unknown)),
                }
            }
            Err(e) => Err(e),
        };
        if stop.aborted() {
            return;
        }
        match answer {
            Ok(result) => {
                let answered = self
                    .change_async(id, &[Phase::Generating], |r| {
                        r.phase = match result.status {
                            MediaUnderstandingStatus::Completed => Phase::Ready,
                            MediaUnderstandingStatus::Incomplete => Phase::Incomplete,
                        };
                        r.understood = Some(result);
                        r.cleanup = Some(MediaCleanup::Running);
                        r.problem.clear();
                    })
                    .await;
                if matches!(answered, Ok(true)) {
                    self.tidy_understanding_async(id).await;
                }
            }
            Err(e) => self.failed_async(id, e.outcome).await,
        }
    }

    /// What the job uploaded goes at the vendor and its inputs are let go; a file the vendor never answered for
    /// leaves the cleanup unknown and is named, and a deletion that fails leaves it blocked, to be asked again.
    async fn tidy_understanding_async(&self, id: &str) {
        let _one = self.cleaning.lock().await;
        let cleaned = match self.remove_remote_async(id).await {
            Ok(()) => match self.inputs.release_async(id).await {
                Ok(()) => self.found_async(id).await,
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        };
        let wrote = match cleaned {
            Ok(r) => {
                let unresolved: Vec<&str> = r.remote.iter().filter(|f| f.unresolved()).map(|f| f.filename.as_str()).collect();
                self.change_async(id, &Phase::ENDED, |r| {
                    if unresolved.is_empty() {
                        r.cleanup = Some(MediaCleanup::Done);
                    } else {
                        r.cleanup = Some(MediaCleanup::Unknown);
                        r.problem = t("server.media.remoteUnresolved", &[("files", unresolved.join(", ").into())]);
                    }
                })
                .await
            }
            Err(e) => {
                eprintln!("media {id}: cleanup is blocked: {}", e.message);
                self.change_async(id, &Phase::ENDED, |r| r.cleanup = Some(MediaCleanup::Blocked)).await
            }
        };
        if let Err(e) = wrote {
            eprintln!("media {id}: {}", e.message);
        }
    }

    /// The ended understanding job, and whether a cleanup has anything left to do.
    async fn cleanable_async(&self, id: &str) -> Result<(Record, bool), ApiError> {
        let r = self.found_async(id).await?;
        if !matches!(r.ask, Ask::Understanding(_)) {
            return Err(refused("missing"));
        }
        if active(r.phase) || r.cleanup == Some(MediaCleanup::Running) {
            return Err(refused("busy"));
        }
        let left = !matches!(r.cleanup, Some(MediaCleanup::Done | MediaCleanup::Unknown));
        Ok((r, left))
    }

    pub async fn preview_understanding_cleanup_async(&self, id: &str) -> Result<Preview, ApiError> {
        let (r, left) = self.cleanable_async(id).await?;
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

    pub async fn understanding_cleanup_async(&self, id: &str) -> Result<MediaUnderstandingJob, ApiError> {
        let (r, left) = self.cleanable_async(id).await?;
        if left && self.change_async(id, &[r.phase], |r| r.cleanup = Some(MediaCleanup::Running)).await? {
            self.tidy_understanding_async(id).await;
        }
        shown(&self.found_async(id).await?)
    }

    /// Approvals that ran out before an orchestrator used them end here, and let go of their inputs.
    pub(super) async fn expire_approvals_async(&self) {
        let waiting = match self.authorized_jobs_async().await {
            Ok(w) => w,
            Err(e) => return eprintln!("media: {}", e.message),
        };
        let at = self.now_ms();
        for r in waiting.iter().filter(|r| r.authorization.as_ref().is_some_and(|a| a.expires_at <= at)) {
            let expired = self
                .change_async(r.id(), &[Phase::Authorized], |r| {
                    r.phase = Phase::Canceled;
                    r.cleanup = Some(MediaCleanup::Done);
                    r.problem = t("server.media.authorizationExpired", &[]);
                })
                .await;
            if matches!(expired, Ok(true)) {
                let _ = self.inputs.release_async(r.id()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::time::Duration;

    use serde_json::json;
    use tokio_util::sync::CancellationToken;
    use vibevalley_core::ManualClock;
    use vibevalley_protocol::{MediaInputRequest, MediaUnderstandingPhase, ProviderUpdate};

    use super::*;
    use crate::app::live::LiveOverlay;
    use crate::app::runtime::Runtime;
    use crate::app::slice::SliceProjector;
    use crate::collab::channel::Chat;
    use crate::content::attachment::AttachmentStore;
    use crate::content::media::inputs::MediaInputStore;
    use crate::content::media::jobs::Parts;
    use crate::db::ServerDb;
    use crate::infra::http::{Fetch, FetchError, Request, Response};
    use crate::infra::provider::connections_over;
    use crate::infra::setting::{Setting, SettingConfig};

    struct UnusedFetch;

    impl Fetch for UnusedFetch {
        fn fetch(&self, _r: Request) -> Result<Response, FetchError> {
            Err(FetchError::Network("unused in approval expiry test".into()))
        }

        fn fetch_with_cancel(&self, r: Request, _cancel: CancellationToken) -> Result<Response, FetchError> {
            self.fetch(r)
        }
    }

    #[tokio::test]
    async fn manual_clock_drives_understanding_approval_expiry_without_sleep() {
        vibevalley_i18n::set_locale("en");
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let runtime = Arc::new(Runtime::new());
        let live = Arc::new(LiveOverlay::new());
        let projector = Arc::new(SliceProjector::new());
        let setting = Setting::open(SettingConfig {
            home: dir.path().to_path_buf(),
            work_root: dir.path().to_path_buf(),
            version: "0.1.0-test".into(),
            deepseek_api_key: String::new(),
        });
        let rev = setting.providers().revision;
        let update: ProviderUpdate = serde_json::from_value(json!({
            "revision": rev,
            "connections": [{"id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key"}],
            "understanding": {"connection": "moss", "model": "moss-vl-1.0"},
            "image": null, "speech": null, "speakers": null, "voiceDesign": null, "transcription": null, "live": null, "vision": null,
        }))
        .unwrap();
        let updated = setting.update_providers(|current| connections_over(current, &update)).unwrap();
        let revision = updated.revision;

        let files = AttachmentStore::open(dir.path(), db.clone());
        let chat = Chat::open_async(db.clone(), runtime.clone(), live, projector.clone(), files.clone(), None, false)
            .await
            .unwrap();
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let inputs = MediaInputStore::open_with_clock_async(dir.path(), db.clone(), runtime.clone(), files.clone(), clock.clone())
            .await
            .unwrap();
        let fetch: Arc<dyn Fetch> = Arc::new(UnusedFetch);
        let jobs = MediaStore::open_with_clock_async(
            Parts {
                db: db.clone(),
                runtime: runtime.clone(),
                projector,
                setting,
                files,
                inputs: inputs.clone(),
                channel: chat.clone(),
                vendor: fetch.clone(),
                download: fetch,
            },
            clock.clone(),
        )
        .await
        .unwrap();

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.resize(24, 0);
        let req: MediaInputRequest = serde_json::from_value(json!({"kind": "image", "mime": "image/png", "name": "cat.png", "size": 24})).unwrap();
        let channel = chat.default_channel();

        let reserved = inputs.create_async(&req).await.unwrap();
        inputs.upload_async(&reserved.id, Box::new(Cursor::new(png))).await.unwrap();
        let auth_req: MediaUnderstandingAuthorizationRequest = serde_json::from_value(json!({
            "id": "approval-clock-test",
            "prompt": "Describe this image.",
            "inputs": [reserved.id],
            "connection": "moss",
            "revision": revision,
            "allowUpload": true,
            "maxOutputTokens": 256,
            "channel": channel,
        }))
        .unwrap();
        let job = jobs.authorize_understanding_async(auth_req).await.unwrap();
        assert_eq!(job.phase, MediaUnderstandingPhase::Authorized);
        assert_eq!(job.authorization.as_ref().unwrap().expires_at, 1_700_000_000_000 + APPROVAL);
        assert!(!inputs.get_async(&reserved.id).await.unwrap().can_delete);

        // Just before APPROVAL elapses, sweep keeps the authorization intact.
        clock.advance(Duration::from_millis((APPROVAL - 1) as u64));
        jobs.expire_approvals_async().await;
        assert_eq!(jobs.found_async("approval-clock-test").await.unwrap().phase, Phase::Authorized);

        // At expiry, starting is refused and sweep cancels the approval and releases its input pin.
        clock.advance(Duration::from_millis(1));
        let refused_start = jobs.start_understanding_async("approval-clock-test", "orchestrator", &channel).await;
        assert!(refused_start.is_err());

        jobs.expire_approvals_async().await;
        let ended = jobs.found_async("approval-clock-test").await.unwrap();
        assert_eq!(ended.phase, Phase::Canceled);
        assert_eq!(ended.cleanup, Some(MediaCleanup::Done));
        assert!(inputs.get_async(&reserved.id).await.unwrap().can_delete);

        jobs.close();
        inputs.close_async().await;
        runtime.shutdown(Duration::from_secs(2)).await;
        db.close_async().await;
    }
}
