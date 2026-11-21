//! Dictation (`packages/ai/src/audio/transcription.ts`,
//! `packages/provider/src/base/transcription.ts`): one recording checked,
//! sent to an OpenAI-shaped `/audio/transcriptions` (MOSS's by default, or
//! the user's own address) and answered as text.

use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, DictationVia, VoiceFix};

use super::agora::unavailable;
use crate::modules::infra::http::{Fetch, FetchError, Request};
use crate::modules::infra::provider::{MOSS, Use};
use crate::modules::infra::setting::{Secret, Setting};

const AUDIO_MAX: usize = 25 << 20;

/// A recording format transcription takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Wav,
    M4a,
    Mp3,
    Webm,
    Ogg,
    Flac,
}

impl Format {
    fn named(s: &str) -> Option<Format> {
        Some(match s {
            "wav" => Format::Wav,
            "m4a" => Format::M4a,
            "mp3" => Format::Mp3,
            "webm" => Format::Webm,
            "ogg" => Format::Ogg,
            "flac" => Format::Flac,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Format::Wav => "wav",
            Format::M4a => "m4a",
            Format::Mp3 => "mp3",
            Format::Webm => "webm",
            Format::Ogg => "ogg",
            Format::Flac => "flac",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Format::Wav => "audio/wav",
            Format::M4a => "audio/mp4",
            Format::Mp3 => "audio/mpeg",
            Format::Webm => "audio/webm",
            Format::Ogg => "audio/ogg",
            Format::Flac => "audio/flac",
        }
    }
}

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::VoiceRefused, text)
}

/// The recording, checked before anything is asked: a format transcription
/// takes, canonical base64, not empty, at most 25 MiB.
pub fn recording(audio64: &str, given: &str) -> Result<(Vec<u8>, Format), ApiError> {
    let name = given.trim().trim_start_matches('.').to_lowercase();
    let Some(format) = Format::named(&name) else {
        let quoted = serde_json::to_string(&name).unwrap_or_default();
        return Err(refused(t("server.voice.dictation.format", &[("format", quoted.into())])));
    };
    let compact: String = audio64.trim_end_matches('=').chars().filter(|c| !c.is_whitespace()).collect();
    let audio = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(compact.trim_end_matches('='))
        .unwrap_or_default();
    if audio.is_empty() {
        return Err(refused(t("server.voice.dictation.empty", &[])));
    }
    if audio.len() > AUDIO_MAX {
        return Err(refused(t("server.voice.dictation.tooLong", &[])));
    }
    Ok((audio, format))
}

/// Where a recording is transcribed.
#[derive(Debug, Clone)]
pub struct Transcriber {
    pub url: String,
    pub model: String,
    pub key: Secret,
}

/// `provider.dictation()`: the user's own address when chosen and filled
/// in, else the MOSS account bound to dictation.
pub fn transcriber(setting: &Setting) -> Result<Transcriber, ApiError> {
    let (dictation, key) = setting.dictation();
    let fix = Some(VoiceFix::Dictation);
    match dictation.via {
        DictationVia::Own if dictation.url.is_empty() => Err(unavailable(t("server.voice.dictation.unset", &[]), fix)),
        DictationVia::Own => Ok(Transcriber {
            url: dictation.url.trim_end_matches('/').to_string(),
            model: dictation.model,
            key,
        }),
        DictationVia::Moss => {
            let account = setting
                .providers()
                .account(Use::Dictation)
                .ok_or_else(|| unavailable(t("server.provider.unbound", &[]), fix))?;
            Ok(Transcriber {
                url: MOSS.into(),
                model: account.model,
                key: account.key,
            })
        }
    }
}

#[derive(Deserialize)]
struct Answer {
    text: Option<String>,
    error: Option<AnswerError>,
}

#[derive(Deserialize)]
struct AnswerError {
    message: Option<String>,
}

fn multipart(boundary: &str, to: &Transcriber, audio: &[u8], format: Format) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    let field = |body: &mut Vec<u8>, name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\ncontent-disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    };
    body.extend_from_slice(
        format!(
            "--{boundary}\r\ncontent-disposition: form-data; name=\"file\"; filename=\"dictation.{}\"\r\ncontent-type: {}\r\n\r\n",
            format.name(),
            format.mime()
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(b"\r\n");
    // MOSS and compatible addresses answer `json`, not OpenAI's `verbose_json`.
    field(&mut body, "model", &to.model.replace(['\r', '\n'], ""));
    field(&mut body, "response_format", "json");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// One request, no retries; what failed is said as the user is told it.
pub fn transcribe(fetch: &dyn Fetch, to: &Transcriber, audio: &[u8], format: Format) -> Result<String, ApiError> {
    let boundary = format!("vibevalley-{}", uuid::Uuid::new_v4().simple());
    let mut headers = vec![];
    if !to.key.is_empty() {
        headers.push(("authorization".to_string(), format!("Bearer {}", to.key.expose())));
    }
    let safe = |why: String| if to.key.is_empty() { why } else { why.replace(to.key.expose(), "[redacted]") };
    let mut response = fetch
        .fetch(Request {
            method: "POST",
            url: format!("{}/audio/transcriptions", to.url),
            headers,
            body: Some((
                format!("multipart/form-data; boundary={boundary}"),
                Box::new(std::io::Cursor::new(multipart(&boundary, to, audio, format))),
            )),
            timeout: Duration::from_secs(120),
        })
        .map_err(|e| {
            let why = match e {
                FetchError::Timeout => "timed out".to_string(),
                FetchError::Network(why) => safe(why),
            };
            unavailable(t("server.voice.dictation.unreachable", &[("why", why.into())]), Some(VoiceFix::Dictation))
        })?;
    let mut raw = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(&mut response.body, 1 << 20), &mut raw)
        .map_err(|e| unavailable(t("server.voice.dictation.cut", &[("why", e.to_string().into())]), Some(VoiceFix::Call)))?;
    let got: Option<Answer> = serde_json::from_slice(&raw).ok();
    if !(200..300).contains(&response.status) {
        let said = got.and_then(|g| g.error).and_then(|e| e.message).filter(|m| !m.is_empty());
        let detail: String = said
            .unwrap_or_else(|| String::from_utf8_lossy(&raw).trim().to_string())
            .chars()
            .take(200)
            .collect();
        return Err(unavailable(
            t(
                "server.voice.dictation.status",
                &[("status", (response.status as i64).into()), ("detail", safe(detail).into())],
            ),
            None,
        ));
    }
    let got = got.ok_or_else(|| unavailable(t("server.voice.dictation.shape", &[]), None))?;
    Ok(got.text.unwrap_or_default().trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_is_checked_before_anything_is_asked() {
        vibevalley_i18n::set_locale("zh");
        let (audio, format) = recording("aGk=", " .WAV ").unwrap();
        assert_eq!((audio.as_slice(), format), (b"hi".as_slice(), Format::Wav));
        assert_eq!(recording("aG k\n", "mp3").unwrap().0, b"hi");
        assert_eq!(recording("aGk=", "aiff").unwrap_err().message, "听写认不得 \"aiff\" 这种录音");
        for empty in ["", "====", "not base64!", "aGl"] {
            let e = recording(empty, "wav").unwrap_err();
            assert_eq!(
                (e.biz_code, e.message.as_str()),
                (BizCode::VoiceRefused, "录音是空的，或者不是 base64"),
                "{empty}"
            );
        }
    }
}
