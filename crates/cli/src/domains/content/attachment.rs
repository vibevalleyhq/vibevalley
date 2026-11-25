//! `attachment upload|get`.

use std::io::Write;
use std::path::PathBuf;

use base64::Engine;
use clap::{Args, Subcommand};
use serde::Serialize;
use vibevalley_protocol::{Attachment, AttachmentUpload, ops};

use crate::client::{Client, Done, Failure, exit, no_dry_run};
use crate::output::{guess_mime, line, url_segment};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct AttachmentCmd {
    #[command(subcommand)]
    pub action: AttachmentAction,
}

#[derive(Debug, Subcommand)]
pub enum AttachmentAction {
    /// Upload a local file as a content-addressed attachment
    #[command(after_help = "Examples:\n  vibevalley attachment upload ./screenshot.png\n  vibevalley attachment upload ./doc.pdf --name spec.pdf --json")]
    Upload {
        /// Local file path to upload
        file: PathBuf,
        /// Display name override
        #[arg(long)]
        name: Option<String>,
        /// MIME type override (inferred from extension when omitted)
        #[arg(long)]
        mime: Option<String>,
    },
    /// Download an attachment by id to a file or stdout
    #[command(after_help = "Examples:\n  vibevalley attachment get <id> --out ./downloaded.png\n  vibevalley attachment get <id> > ./downloaded.png")]
    Get {
        /// Attachment id
        id: String,
        /// Output file path (streams raw bytes to stdout when omitted in text mode)
        #[arg(long)]
        out: Option<PathBuf>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedMeta {
    id: String,
    size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

fn attachment_line(att: &Attachment) -> String {
    line(&[&att.id, &att.name, &att.r#type, &format!("{}B", att.size)])
}

pub async fn run(client: &Client, cmd: AttachmentCmd) -> Done {
    match cmd.action {
        AttachmentAction::Upload { file, name, mime } => {
            if client.dry_run {
                return Err(no_dry_run("attachment upload"));
            }
            let bytes = std::fs::read(&file).map_err(|e| Failure::new(exit::OTHER, "File", format!("failed to read {}: {e}", file.display())))?;
            let name = name
                .or_else(|| file.file_name().and_then(|n| n.to_str()).map(ToString::to_string))
                .unwrap_or_else(|| "attachment".into());
            let r#type = mime.unwrap_or_else(|| guess_mime(&file).to_string());
            let request = AttachmentUpload {
                name,
                r#type,
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            };
            client.mutate::<ops::AttachmentCreate>("attachment upload", &request, attachment_line).await
        }
        AttachmentAction::Get { id, out } => {
            let (bytes, content_type) = client.get_bytes(&format!("/api/v1/attachment/{}", url_segment(&id))).await?;
            if let Some(path) = out {
                if let Some(parent) = path.parent()
                    && !parent.as_os_str().is_empty()
                {
                    std::fs::create_dir_all(parent).map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))?;
                }
                std::fs::write(&path, &bytes).map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))?;
                let meta = DownloadedMeta {
                    id: id.clone(),
                    size: bytes.len(),
                    content_type,
                    out: Some(path.display().to_string()),
                    data: None,
                };
                client
                    .output
                    .show(&meta, |m| line(&[&m.id, &format!("{}B", m.size), &format!("-> {}", path.display())]));
                return Ok(());
            }
            if client.output.json {
                let meta = DownloadedMeta {
                    id,
                    size: bytes.len(),
                    content_type,
                    out: None,
                    data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                };
                client.output.show(&meta, |_| String::new());
            } else {
                let mut stdout = std::io::stdout();
                stdout.write_all(&bytes).map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))?;
            }
            Ok(())
        }
    }
}
