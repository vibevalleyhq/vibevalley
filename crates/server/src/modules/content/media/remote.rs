//! What a job sent to the vendor, kept on the job: each file is written
//! down before it goes, so a restart or a lost answer leaves a name to look
//! for, and it is deleted there only by the account that sent it.

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{ApiError, MediaInputReference};

use super::Stop;
use super::jobs::{Jobs, refused};
use super::vendor::{Account, Outcome, Uploaded};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RemoteState {
    Uploading,
    Ready,
    Rejected,
    /// The vendor may or may not have it.
    Unknown,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteFile {
    pub(super) input: String,
    /// The name it was sent under, never the user's own.
    pub(super) filename: String,
    pub(super) state: RemoteState,
    pub(super) remote_id: Option<String>,
}

impl RemoteFile {
    /// The vendor has it under a known id.
    pub(super) fn kept(&self) -> bool {
        self.remote_id.is_some() && self.state != RemoteState::Deleted
    }

    /// It may be at the vendor, under no id this farm knows.
    pub(super) fn unresolved(&self) -> bool {
        self.remote_id.is_none() && matches!(self.state, RemoteState::Uploading | RemoteState::Unknown)
    }
}

fn extension(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "video/mp4" => "mp4",
        "video/x-m4v" => "m4v",
        "video/quicktime" => "mov",
        "video/x-msvideo" => "avi",
        "video/webm" | "audio/webm" => "webm",
        "video/x-matroska" => "mkv",
        "audio/wav" => "wav",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        _ => return None,
    })
}

impl Jobs {
    /// The input sent to the vendor, once per job: its file id there. A file already sent is not sent again, so one
    /// whose answer was lost stays unknown.
    pub(super) async fn upload_async(&self, id: &str, input: &MediaInputReference, account: &Account, stop: &Stop) -> Result<String, Outcome> {
        let unsent = |_| Outcome::NotSubmitted;
        let r = self.found_async(id).await.map_err(unsent)?;
        if let Some(sent) = r.remote.iter().find(|f| f.input == input.id) {
            return match (sent.state, &sent.remote_id) {
                (RemoteState::Ready, Some(file)) => Ok(file.clone()),
                _ => Err(Outcome::Unknown),
            };
        }
        let extension = extension(&input.mime).ok_or(Outcome::NotSubmitted)?;
        let content = self.inputs.content_async(&input.id).await.map_err(unsent)?;
        if stop.aborted() {
            return Err(Outcome::NotSubmitted);
        }
        let filename = format!("vv-{}.{extension}", uuid::Uuid::new_v4().simple());
        let wrote = self
            .note_async(id, |r| {
                r.remote.push(RemoteFile {
                    input: input.id.clone(),
                    filename: filename.clone(),
                    state: RemoteState::Uploading,
                    remote_id: None,
                })
            })
            .await;
        if !matches!(wrote, Ok(true)) {
            return Err(Outcome::NotSubmitted);
        }
        let fetch = self.moss.fetch.clone();
        let key = account.key.clone();
        let path = content.path;
        let size = input.size;
        let kind = input.kind.as_str().to_string();
        let upload_name = filename.clone();
        let stop_upload = stop.clone();
        let uploaded = crate::spawn_blocking_traced(move || {
            let file = std::fs::File::open(&path).map_err(|_| Outcome::NotSubmitted)?;
            Ok(super::vendor::Moss { fetch }.upload(&key, file, size, &upload_name, &kind, &stop_upload))
        })
        .await;
        let (state, remote_id, answer) = match uploaded {
            Ok(Ok(Ok((file, Uploaded::Ready)))) => (RemoteState::Ready, Some(file.clone()), Ok(file)),
            Ok(Ok(Ok((file, Uploaded::Rejected)))) => (RemoteState::Rejected, Some(file), Err(Outcome::Rejected)),
            Ok(Ok(Ok((file, Uploaded::Unknown)))) => (RemoteState::Unknown, Some(file), Err(Outcome::Unknown)),
            Ok(Ok(Err(e))) if e.unknown() => (RemoteState::Unknown, None, Err(Outcome::Unknown)),
            Ok(Ok(Err(_))) => (RemoteState::Rejected, None, Err(Outcome::Rejected)),
            Ok(Err(outcome)) => (RemoteState::Rejected, None, Err(outcome)),
            Err(_) => (RemoteState::Unknown, None, Err(Outcome::Unknown)),
        };
        let _ = self
            .note_async(id, |r| {
                if let Some(file) = r.remote.iter_mut().find(|f| f.input == input.id) {
                    file.state = state;
                    file.remote_id = remote_id;
                }
            })
            .await;
        answer
    }

    /// The vendor's copies deleted, each written down as it goes; refused when the job's account changed or the vendor
    /// would not confirm one, so it can be asked again.
    pub(super) async fn remove_remote_async(&self, id: &str) -> Result<(), ApiError> {
        let r = self.found_async(id).await?;
        let left: Vec<RemoteFile> = r.remote.iter().filter(|f| f.kept() || f.state == RemoteState::Rejected).cloned().collect();
        if left.is_empty() {
            return Ok(());
        }
        let account = if left.iter().any(RemoteFile::kept) {
            Some(self.account_of(&r)?)
        } else {
            None
        };
        for file in left {
            if let (Some(account), Some(remote)) = (&account, file.remote_id.as_ref().filter(|_| file.kept())) {
                let fetch = self.moss.fetch.clone();
                let key = account.key.clone();
                let remote = remote.clone();
                tokio::task::spawn_blocking(move || super::vendor::Moss { fetch }.delete_file(&key, &remote))
                    .await
                    .map_err(|_| refused("remoteCleanupFailed"))?
                    .map_err(|_| refused("remoteCleanupFailed"))?;
            }
            self.note_async(id, |r| {
                if let Some(f) = r.remote.iter_mut().find(|f| f.input == file.input) {
                    f.state = RemoteState::Deleted;
                }
            })
            .await?;
        }
        Ok(())
    }
}
