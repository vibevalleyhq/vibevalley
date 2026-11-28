//! DB record serialization/deserialization, account credential adaptation,
//! and media announcement payload builders.

use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, MediaSource};

use super::MediaAnnouncement;
use super::state::{Ask, Phase, Record};
use super::vendor::{self, Account};
use crate::service::note::MediaJobRow;

pub(super) fn storage_err(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("media job storage: {e}"))
}

pub(super) fn encode_row(r: &Record) -> Result<MediaJobRow, ApiError> {
    Ok(MediaJobRow {
        id: r.id().to_string(),
        kind: r.ask.kind().to_string(),
        phase: r.phase.as_str().to_string(),
        data: serde_json::to_string(r).map_err(storage_err)?,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

pub(super) fn decode_row(row: MediaJobRow) -> Result<Record, ApiError> {
    serde_json::from_str(&row.data).map_err(storage_err)
}

pub(super) fn decode_rows(rows: Vec<MediaJobRow>) -> Result<Vec<Record>, ApiError> {
    rows.into_iter().map(decode_row).collect()
}

pub(super) fn keyed(a: crate::setting::Account) -> Account {
    Account {
        fingerprint: vendor::fingerprint(a.key.expose()),
        key: a.key.expose().to_string(),
        connection: a.connection,
        revision: a.revision,
        model: a.model,
    }
}

pub(super) fn image_announcement(r: &Record) -> Option<MediaAnnouncement> {
    let (Ask::Image(request), Phase::Ready, MediaSource::Orchestrator { agent, channel }, Some(attachment)) = (&r.ask, r.phase, &r.source, &r.attachment)
    else {
        return None;
    };
    let text = t(
        "server.media.imageMade",
        &[("prompt", request.prompt.chars().take(80).collect::<String>().into())],
    );
    Some(MediaAnnouncement {
        from: agent.clone(),
        channel: channel.clone(),
        text,
        attachments: vec![attachment.id.clone()],
        send_key: format!("media:{}", r.id()),
    })
}

pub(super) fn speech_format_event(sample_rate: i64, channels: i64) -> Value {
    json!({ "type": "format", "sampleRate": sample_rate, "channels": channels, "bitDepth": 16 })
}

pub(super) fn speech_audio_event(sequence: i64, pcm_chunk: &[u8]) -> Value {
    let audio = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, pcm_chunk);
    json!({ "type": "audio", "sequence": sequence, "audio": audio })
}

pub(super) fn speech_done_event() -> Value {
    json!({ "type": "done" })
}

pub(super) fn speech_failed_event() -> Value {
    json!({ "type": "failed" })
}

impl Record {
    pub(super) fn to_row(&self) -> Result<MediaJobRow, ApiError> {
        encode_row(self)
    }
}
