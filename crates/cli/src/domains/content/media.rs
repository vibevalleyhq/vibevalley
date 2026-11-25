//! `media job list|show|cancel` and `media input list|upload|delete`.

use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use vibevalley_protocol::{MediaAudioJob, MediaInput, MediaInputKind, MediaInputRequest, MediaJob, MediaJobRequest, ops};

use crate::client::{Client, Done, Failure, exit, no_dry_run};
use crate::output::{guess_mime, line, one_line, url_segment};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum MediaInputKindArg {
    Image,
    Video,
    Audio,
}

impl From<MediaInputKindArg> for MediaInputKind {
    fn from(value: MediaInputKindArg) -> Self {
        match value {
            MediaInputKindArg::Image => MediaInputKind::Image,
            MediaInputKindArg::Video => MediaInputKind::Video,
            MediaInputKindArg::Audio => MediaInputKind::Audio,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct MediaCmd {
    #[command(subcommand)]
    pub action: MediaAction,
}

#[derive(Debug, Subcommand)]
pub enum MediaAction {
    /// Inspect or cancel media generation jobs
    Job(MediaJobCmd),
    /// Manage binary media inputs
    Input(MediaInputCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct MediaJobCmd {
    #[command(subcommand)]
    pub action: MediaJobAction,
}

#[derive(Debug, Subcommand)]
pub enum MediaJobAction {
    /// List media jobs
    #[command(after_help = "Examples:\n  vibevalley media job list")]
    List,
    /// Show details for one media job
    #[command(after_help = "Examples:\n  vibevalley media job show job-1")]
    Show {
        /// Media job id
        id: String,
    },
    /// Cancel a running media job
    #[command(after_help = "Examples:\n  vibevalley media job cancel job-1")]
    Cancel {
        /// Media job id
        id: String,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct MediaInputCmd {
    #[command(subcommand)]
    pub action: MediaInputAction,
}

#[derive(Debug, Subcommand)]
pub enum MediaInputAction {
    /// List reserved and uploaded media inputs
    #[command(after_help = "Examples:\n  vibevalley media input list")]
    List,
    /// Reserve and stream-upload a local file as a media input
    #[command(after_help = "Examples:\n  vibevalley media input upload ./clip.wav --kind audio")]
    Upload {
        /// Local file path to upload
        file: PathBuf,
        /// Media kind (inferred from MIME type when omitted)
        #[arg(long, value_enum)]
        kind: Option<MediaInputKindArg>,
        /// Display name override
        #[arg(long)]
        name: Option<String>,
        /// MIME type override
        #[arg(long)]
        mime: Option<String>,
    },
    /// Delete a media input
    #[command(after_help = "Examples:\n  vibevalley media input delete inp-1 --dry-run")]
    Delete {
        /// Media input id
        id: String,
    },
}

fn job_line(job: &MediaJob) -> String {
    let fmt = |id: &str, kind: &str, phase: &str, model: &str, prompt: &str| line(&[id, kind, phase, model, &one_line(prompt)]);
    match job {
        MediaJob::MediaImageJob(j) => fmt(&j.id, j.kind.as_str(), j.phase.as_str(), &j.model, &j.prompt),
        MediaJob::MediaUnderstandingJob(j) => fmt(&j.id, j.kind.as_str(), j.phase.as_str(), &j.model, &j.prompt),
        MediaJob::MediaSpeechJob(j) => fmt(&j.id, j.kind.as_str(), j.phase.as_str(), &j.model, &j.prompt),
        MediaJob::MediaAudioJob(a) => match a {
            MediaAudioJob::Speakers { id, phase, model, prompt, .. } => fmt(id, "speakers", phase.as_str(), model, prompt),
            MediaAudioJob::VoiceDesign { id, phase, model, prompt, .. } => fmt(id, "voiceDesign", phase.as_str(), model, prompt),
            MediaAudioJob::Clone { id, phase, model, prompt, .. } => fmt(id, "clone", phase.as_str(), model, prompt),
            MediaAudioJob::Transcription { id, phase, model, prompt, .. } => fmt(id, "transcription", phase.as_str(), model, prompt),
        },
    }
}

fn input_line(input: &MediaInput) -> String {
    line(&[
        &input.id,
        input.kind.as_str(),
        input.phase.as_str(),
        &input.name,
        &input.mime,
        &format!("{}B", input.size),
    ])
}

fn infer_kind(mime: &str) -> Option<MediaInputKind> {
    if mime.starts_with("image/") {
        Some(MediaInputKind::Image)
    } else if mime.starts_with("audio/") {
        Some(MediaInputKind::Audio)
    } else if mime.starts_with("video/") {
        Some(MediaInputKind::Video)
    } else {
        None
    }
}

pub async fn run(client: &Client, cmd: MediaCmd) -> Done {
    match cmd.action {
        MediaAction::Job(job) => match job.action {
            MediaJobAction::List => {
                let jobs = client.ask::<ops::MediaJobList>(&()).await?;
                client.output.show(&jobs, |list| list.iter().map(job_line).collect::<Vec<_>>().join("\n"));
                Ok(())
            }
            MediaJobAction::Show { id } => {
                let found = client.ask::<ops::MediaJobGet>(&MediaJobRequest { id }).await?;
                client.output.show(&found, job_line);
                Ok(())
            }
            MediaJobAction::Cancel { id } => {
                client
                    .mutate::<ops::MediaJobCancel>("media job cancel", &MediaJobRequest { id }, job_line)
                    .await
            }
        },
        MediaAction::Input(input) => match input.action {
            MediaInputAction::List => {
                let inputs = client.ask::<ops::MediaInputList>(&()).await?;
                client.output.show(&inputs, |list| list.iter().map(input_line).collect::<Vec<_>>().join("\n"));
                Ok(())
            }
            MediaInputAction::Upload { file, kind, name, mime } => {
                if client.dry_run {
                    return Err(no_dry_run("media input upload"));
                }
                let bytes = std::fs::read(&file).map_err(|e| Failure::new(exit::OTHER, "File", format!("failed to read {}: {e}", file.display())))?;
                let mime = mime.unwrap_or_else(|| guess_mime(&file).to_string());
                let kind = match kind {
                    Some(k) => k.into(),
                    None => infer_kind(&mime).ok_or_else(|| {
                        Failure::usage(
                            "InvalidValue",
                            format!("cannot infer media kind from MIME {mime:?}; pass --kind image|audio|video"),
                        )
                    })?,
                };
                let name = name
                    .or_else(|| file.file_name().and_then(|n| n.to_str()).map(ToString::to_string))
                    .unwrap_or_else(|| "input".into());
                let reserved = client
                    .ask::<ops::MediaInputCreate>(&MediaInputRequest {
                        kind,
                        name,
                        mime,
                        size: bytes.len() as i64,
                    })
                    .await?;
                let uploaded: MediaInput = client
                    .put_bytes(
                        &format!("/api/v1/media/input/{}/content", url_segment(&reserved.id)),
                        "application/octet-stream",
                        &bytes,
                    )
                    .await?;
                client.output.show(&uploaded, input_line);
                Ok(())
            }
            MediaInputAction::Delete { id } => {
                let key = id.clone();
                client
                    .mutate::<ops::MediaInputDelete>("media input delete", &MediaJobRequest { id }, |_| format!("deleted {key}"))
                    .await
            }
        },
    }
}
