//! Files uploaded to the vendor for media jobs: recorded before upload so a
//! restart or lost response leaves a trackable entry, and deleted only by the
//! originating account.

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{ApiError, MediaInputReference};

use super::Stop;
use super::job::{Media, refused};
use super::vendor::{Account, Outcome, Uploaded};
use crate::log::spawn_blocking_traced;

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
    /// Generated filename sent to the vendor (never the user's own filename).
    pub(super) filename: String,
    pub(super) state: RemoteState,
    pub(super) remote_id: Option<String>,
}

impl RemoteFile {
    /// The vendor has it under a known id.
    pub(super) fn kept(&self) -> bool {
        self.remote_id.is_some() && self.state != RemoteState::Deleted
    }

    /// It may exist at the vendor without a known id.
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

impl Media {
    /// Uploads an input to the vendor once per job, returning its remote file id.
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
        let content = self.storage.input_content_async(&input.id).await.map_err(unsent)?;
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
        let path = content.path;
        let file = match spawn_blocking_traced(move || std::fs::File::open(&path)).await {
            Ok(Ok(file)) => file,
            _ => {
                let _ = self
                    .note_async(id, |r| {
                        if let Some(f) = r.remote.iter_mut().find(|f| f.input == input.id) {
                            f.state = RemoteState::Rejected;
                        }
                    })
                    .await;
                return Err(Outcome::NotSubmitted);
            }
        };
        let uploaded = self.moss.upload(&account.key, file, input.size, &filename, input.kind.as_str(), stop).await;
        let (state, remote_id, answer) = match uploaded {
            Ok((file, Uploaded::Ready)) => (RemoteState::Ready, Some(file.clone()), Ok(file)),
            Ok((file, Uploaded::Rejected)) => (RemoteState::Rejected, Some(file), Err(Outcome::Rejected)),
            Ok((file, Uploaded::Unknown)) => (RemoteState::Unknown, Some(file), Err(Outcome::Unknown)),
            Err(e) if e.unknown() => (RemoteState::Unknown, None, Err(Outcome::Unknown)),
            Err(_) => (RemoteState::Rejected, None, Err(Outcome::Rejected)),
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

    /// Deletes vendor-side uploaded files for a job; fails if the originating account
    /// changed or the vendor refuses deletion so cleanup can be retried.
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
                self.moss.delete_file(&account.key, remote).await.map_err(|_| refused("remoteCleanupFailed"))?;
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
