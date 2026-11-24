//! Image and video understanding on the media job engine: uploads inputs to
//! the vendor, runs one understanding query, and deletes remote copies afterward.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, LitFalse, MediaCleanup, MediaInputKind, MediaInputPhase, MediaInputReference, MediaSource, MediaUnderstandingAuthorization,
    MediaUnderstandingAuthorizationRequest, MediaUnderstandingJob, MediaUnderstandingJobKind, MediaUnderstandingRequest, MediaUnderstandingStatus, Preview,
};

use super::Stop;
use super::job::{Ask, Held, Media, Phase, Record, active, id_ok, refused};
use super::vendor::{Account, Moss, Outcome};
use crate::setting::Use;

const APPROVAL: i64 = 15 * 60_000;

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

impl Media {
    pub async fn understanding_async(&self, request: MediaUnderstandingRequest) -> Result<MediaUnderstandingJob, ApiError> {
        self.understanding_for_async(request, None).await
    }

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
            let input = self.storage.get_input_async(id).await.map_err(|_| invalid())?;
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
            Ok(body) => self.moss.understand(&account.key, &body, stop).await,
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

    async fn tidy_understanding_async(&self, id: &str) {
        let _one = self.cleaning.lock().await;
        let cleaned = match self.remove_remote_async(id).await {
            Ok(()) => match self.storage.release_input_pins_async(id).await {
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
                let _ = self.storage.release_input_pins_async(r.id()).await;
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
    use vibevalley_protocol::{ArtifactCard, ChatMessage, MediaInputRequest, MediaUnderstandingPhase, ProviderUpdate};

    use super::*;
    use crate::context::http::{Fetch, FetchError, Request, Response};
    use crate::context::port::ChannelAnnounce;
    use crate::context::{Context, LiveState, Outbox, StateFeed, TaskGroup};
    use crate::provider::connections_over;
    use crate::service::Service;
    use crate::setting::{Setting, SettingConfig};
    use crate::storage::Storage;

    struct UnusedFetch;

    impl Fetch for UnusedFetch {
        fn fetch_async(self: Arc<Self>, _request: Request, _cancel: CancellationToken) -> crate::BoxFuture<'static, Result<Response, FetchError>> {
            Box::pin(async { Err(FetchError::Network("unused in approval expiry test".into())) })
        }
    }

    struct MockAnnounce;

    impl ChannelAnnounce for MockAnnounce {
        fn place_exists(&self, id: &str) -> bool {
            id == "general"
        }

        fn orchestrator_in(&self, _channel: &str) -> String {
            "orchestrator".into()
        }

        fn place_of_async<'a>(&'a self, _who: &'a str, target: &'a str) -> crate::BoxFuture<'a, Result<String, ApiError>> {
            let out = if target.trim().is_empty() {
                "general".to_string()
            } else {
                target.trim().to_string()
            };
            Box::pin(async move { Ok(out) })
        }

        fn post_card_async<'a>(
            &'a self,
            _from: &'a str,
            _channel: &'a str,
            _text: &'a str,
            _card: ArtifactCard,
            _run: Option<String>,
            _send_key: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }

        fn post_attachments_async<'a>(
            &'a self,
            _from: &'a str,
            _channel: &'a str,
            _text: &'a str,
            _attachments: Vec<String>,
            _send_key: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn manual_clock_drives_understanding_approval_expiry_without_sleep() {
        vibevalley_i18n::set_locale("en");
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let fetch: Arc<dyn Fetch> = Arc::new(UnusedFetch);
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            clock.clone(),
            fetch.clone(),
            fetch,
        ));
        let setting = Setting::open_async(SettingConfig {
            home: dir.path().to_path_buf(),
            work_root: dir.path().to_path_buf(),
            version: "0.1.0-test".into(),
            deepseek_api_key: String::new(),
        })
        .await;
        let rev = setting.providers().revision;
        let update: ProviderUpdate = serde_json::from_value(json!({
            "revision": rev,
            "connections": [{"id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key"}],
            "understanding": {"connection": "moss", "model": "moss-vl-1.0"},
            "image": null, "speech": null, "speakers": null, "voiceDesign": null, "transcription": null, "live": null, "vision": null,
        }))
        .unwrap();
        let updated = setting.update_providers_async(|current| connections_over(current, &update)).await.unwrap();
        let revision = updated.revision;

        let storage = Storage::open_async(dir.path(), ctx.clone()).await.unwrap();
        let jobs = Media::open_async(ctx.clone(), setting, storage.clone(), Arc::new(MockAnnounce)).await.unwrap();

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.resize(24, 0);
        let req: MediaInputRequest = serde_json::from_value(json!({"kind": "image", "mime": "image/png", "name": "cat.png", "size": 24})).unwrap();
        let channel = "general".to_string();

        let reserved = storage.create_input_async(&req).await.unwrap();
        storage.upload_input_async(&reserved.id, Box::new(Cursor::new(png))).await.unwrap();
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
        assert!(!storage.get_input_async(&reserved.id).await.unwrap().can_delete);

        clock.advance(Duration::from_millis((APPROVAL - 1) as u64));
        jobs.expire_approvals_async().await;
        assert_eq!(jobs.found_async("approval-clock-test").await.unwrap().phase, Phase::Authorized);

        clock.advance(Duration::from_millis(1));
        let refused_start = jobs.start_understanding_async("approval-clock-test", "orchestrator", &channel).await;
        assert!(refused_start.is_err());

        jobs.expire_approvals_async().await;
        let ended = jobs.found_async("approval-clock-test").await.unwrap();
        assert_eq!(ended.phase, Phase::Canceled);
        assert_eq!(ended.cleanup, Some(MediaCleanup::Done));
        assert!(storage.get_input_async(&reserved.id).await.unwrap().can_delete);

        jobs.close();
        storage.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }
}
