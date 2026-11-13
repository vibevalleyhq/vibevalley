//! `provider.*`: the MOSS accounts (connections), which one each use is
//! bound to, and the account's models and voices. Ported from VibeValley
//! `platform/provider/connections.ts`, `provider.ts` (`status`, `update`,
//! `models`, `voices`) and `packages/provider/src/moss/{models,voices}.ts`.
//! The providers live in `settings.json` (`Setting::update_providers`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, ProviderModel, ProviderModelListing, ProviderStatus, ProviderUpdate, ProviderVoiceListing, ProviderVoiceListingVoices, ops,
};

use super::setting::{Setting, key_hint};
use crate::Hub;

const MOSS: &str = "https://api.mosi.cn/v1";

use crate::modules::media::vendor::{Fetch, FetchError, Request};

pub const IMAGE_MODELS: [&str; 4] = [
    "moss-image-base-1.0",
    "moss-image-sft-1.0",
    "moss-image-base-1.0-2026-10-09",
    "moss-image-sft-1.0-2026-10-09",
];
pub const LIVE_MODELS: [&str; 2] = ["moss-live-1.0", "moss-live-1.0-2026-11-02"];
pub const SPEAKERS_MODELS: [&str; 2] = ["moss-ttsd-1.0", "moss-ttsd-1.0-2026-03-20"];
pub const SPEECH_MODELS: [&str; 4] = [
    "moss-tts-1.5-flash",
    "moss-tts-1.5-flash-2026-06-26",
    "moss-tts-1.0-pro",
    "moss-tts-1.0-pro-2026-02-07",
];
pub const TRANSCRIPTION_MODELS: [&str; 4] = [
    "moss-transcribe-1.0",
    "moss-transcribe-1.0-2026-07-22",
    "moss-transcribe-diarize-pro",
    "moss-transcribe-diarize-pro-2026-07-03",
];
pub const UNDERSTANDING_MODELS: [&str; 2] = ["moss-vl-1.0", "moss-vl-1.0-2026-07-08"];
pub const VISION_MODELS: [&str; 2] = ["moss-vl-realtime-1.0", "moss-vl-realtime-1.0-2026-09-09"];
pub const VOICE_DESIGN_MODELS: [&str; 2] = ["moss-voice-generator-1.0", "moss-voice-generator-1.0-2026-07-22"];

const USES: [&str; 9] = [
    "dictation",
    "image",
    "understanding",
    "speech",
    "live",
    "speakers",
    "voiceDesign",
    "transcription",
    "vision",
];

fn refuse(key: &str) -> ApiError {
    ApiError::new(BizCode::ProviderRefused, t(key, &[]))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// `providerStatus`: the providers with each key as a hint.
pub fn status_of(p: &Value) -> ProviderStatus {
    let connections: Vec<Value> = p["connections"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut c| {
            let key = s(&c["key"]).to_string();
            c["key"] = if key.is_empty() {
                json!({ "source": null })
            } else {
                json!({ "source": "settings", "hint": key_hint(&key) })
            };
            c
        })
        .collect();
    let mut out = json!({
        "revision": p["revision"].as_i64().unwrap_or(0),
        "connections": connections,
        "liveModels": LIVE_MODELS,
        "speakersModels": SPEAKERS_MODELS,
        "voiceDesignModels": VOICE_DESIGN_MODELS,
        "transcriptionModels": TRANSCRIPTION_MODELS,
        "visionModels": VISION_MODELS,
        "dictationModels": TRANSCRIPTION_MODELS,
        "imageModels": IMAGE_MODELS,
        "understandingModels": UNDERSTANDING_MODELS,
        "speechModels": SPEECH_MODELS,
    });
    for u in USES {
        out[u] = if p[u].is_object() { p[u].clone() } else { Value::Null };
    }
    serde_json::from_value(out).expect("the providers' status is a ProviderStatus")
}

/// `boundConnection`: the connection named, on and with a key.
fn bound_connection<'a>(p: &'a Value, id: &str) -> Option<&'a Value> {
    p["connections"]
        .as_array()?
        .iter()
        .find(|c| c["id"] == id && c["enabled"] == true && !s(&c["key"]).is_empty())
}

fn good_connection_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `connectionsOver`: the update laid over the current providers; refused
/// when it cannot be right.
pub fn connections_over(current: &Value, update: &ProviderUpdate) -> Result<Value, ApiError> {
    let revision = current["revision"].as_i64().unwrap_or(0);
    if update.revision != revision {
        return Err(refuse("server.provider.changed"));
    }
    if update.connections.len() > 32 {
        return Err(refuse("server.provider.limit"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut connections = Vec::new();
    for input in &update.connections {
        if !good_connection_id(&input.id) || !seen.insert(input.id.clone()) {
            return Err(refuse("server.provider.id"));
        }
        let name = input.name.trim();
        if name.is_empty() || name.encode_utf16().count() > 80 {
            return Err(refuse("server.provider.name"));
        }
        let kept = current["connections"]
            .as_array()
            .and_then(|cs| cs.iter().find(|c| c["id"] == input.id.as_str()))
            .map(|c| s(&c["key"]).to_string());
        let key = match &input.key {
            None => kept.unwrap_or_default(),
            Some(None) => String::new(),
            Some(Some(k)) => k.trim().to_string(),
        };
        let given_empty = matches!(&input.key, Some(Some(_))) && key.is_empty();
        if given_empty || key.chars().any(char::is_whitespace) || key.encode_utf16().count() > 4096 {
            return Err(refuse("server.provider.key"));
        }
        connections.push(json!({
            "id": input.id, "name": name, "adapter": input.adapter, "enabled": input.enabled, "key": key,
        }));
    }
    let u = serde_json::to_value(update).unwrap_or_default();
    let mut next = json!({ "revision": revision + 1, "connections": connections });
    for use_ in USES {
        next[use_] = u[use_].clone();
    }
    for use_ in USES {
        let b = &next[use_];
        if b.is_object() && bound_connection(&next, s(&b["connection"])).is_none() {
            return Err(refuse("server.provider.bound"));
        }
    }
    let model_in = |use_: &str, models: &[&str]| {
        let b = &next[use_];
        !b.is_object() || models.contains(&s(&b["model"]))
    };
    if !model_in("dictation", &TRANSCRIPTION_MODELS) {
        return Err(refuse("server.provider.model"));
    }
    if !model_in("image", &IMAGE_MODELS) {
        return Err(refuse("server.provider.imageModel"));
    }
    if !model_in("understanding", &UNDERSTANDING_MODELS) {
        return Err(refuse("server.provider.understandingModel"));
    }
    if !model_in("speech", &SPEECH_MODELS) {
        return Err(refuse("server.provider.speechModel"));
    }
    for (use_, models) in [
        ("live", &LIVE_MODELS[..]),
        ("speakers", &SPEAKERS_MODELS[..]),
        ("voiceDesign", &VOICE_DESIGN_MODELS[..]),
        ("transcription", &TRANSCRIPTION_MODELS[..]),
        ("vision", &VISION_MODELS[..]),
    ] {
        if !model_in(use_, models) {
            let capability = t(&format!("server.provider.use.{use_}"), &[]);
            return Err(ApiError::new(
                BizCode::ProviderRefused,
                t("server.provider.capabilityModel", &[("capability", capability.into())]),
            ));
        }
    }
    Ok(next)
}

/// A GET to MOSS: the parsed 2xx body, else its failure in the user's words (`refusal`).
fn moss_get(fetch: &dyn Fetch, key: &str, url: &str, query: &[(&str, String)], timeout: Duration) -> Result<Value, ApiError> {
    if key.trim().is_empty() || key.chars().any(char::is_whitespace) {
        return Err(refuse("server.provider.noKey"));
    }
    let mut target = url::Url::parse(url).map_err(|_| refuse("server.provider.network"))?;
    for (k, v) in query {
        target.query_pairs_mut().append_pair(k, v);
    }
    let response = fetch
        .fetch(Request {
            method: "GET",
            url: target.to_string(),
            headers: vec![("authorization".into(), format!("Bearer {key}")), ("accept".into(), "application/json".into())],
            body: None,
            timeout,
        })
        .map_err(|e| match e {
            FetchError::Timeout => refuse("server.provider.timeout"),
            FetchError::Network(_) => refuse("server.provider.network"),
        })?;
    match response.status {
        200..=299 => {}
        401 => return Err(refuse("server.provider.authentication")),
        403 => return Err(refuse("server.provider.forbidden")),
        429 => return Err(refuse("server.provider.rateLimited")),
        status => {
            return Err(ApiError::new(
                BizCode::ProviderRefused,
                t("server.provider.httpStatus", &[("status", (status as i64).into())]),
            ));
        }
    }
    let mut body = response.body;
    let bytes = crate::modules::media::vendor::read_max(&mut body, 1 << 20, None).map_err(|_| refuse("server.provider.tooLarge"))?;
    serde_json::from_slice(&bytes).map_err(|_| refuse("server.provider.invalidResponse"))
}

pub struct Provider {
    setting: Arc<Setting>,
    /// How MOSS is reached (offline in the page's tests).
    fetch: Arc<dyn Fetch>,
}

impl Provider {
    pub fn new(setting: Arc<Setting>, fetch: Arc<dyn Fetch>) -> Provider {
        Provider { setting, fetch }
    }

    pub fn status(&self) -> ProviderStatus {
        status_of(&self.setting.providers())
    }

    pub fn update(&self, input: &ProviderUpdate) -> Result<ProviderStatus, ApiError> {
        let next = self.setting.update_providers(|current| connections_over(&current, input))?;
        Ok(status_of(&next))
    }

    /// The bound connection's key at `revision`, else refused.
    fn key_at(&self, connection: &str, revision: i64) -> Result<String, ApiError> {
        let p = self.setting.providers();
        if p["revision"].as_i64().unwrap_or(0) != revision {
            return Err(refuse("server.provider.changed"));
        }
        let c = bound_connection(&p, connection).ok_or_else(|| refuse("server.provider.noKey"))?;
        Ok(s(&c["key"]).to_string())
    }

    fn still_at(&self, revision: i64) -> Result<(), ApiError> {
        if self.setting.providers()["revision"].as_i64().unwrap_or(0) != revision {
            return Err(refuse("server.provider.changed"));
        }
        Ok(())
    }

    pub fn models(&self, connection: &str, revision: i64) -> Result<ProviderModelListing, ApiError> {
        let key = self.key_at(connection, revision)?;
        let list = moss_get(&*self.fetch, &key, &format!("{MOSS}/models"), &[], Duration::from_secs(15))?;
        let data = list["data"]
            .as_array()
            .filter(|_| list["object"] == "list")
            .ok_or_else(|| refuse("server.provider.invalidResponse"))?;
        if data.len() > 1000 {
            return Err(refuse("server.provider.tooLarge"));
        }
        let models = data
            .iter()
            .map(|m| match (m["id"].as_str(), m["owned_by"].as_str()) {
                (Some(id), Some(owner)) if !id.is_empty() => Ok(ProviderModel {
                    id: id.into(),
                    owner: owner.into(),
                }),
                _ => Err(refuse("server.provider.invalidResponse")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.still_at(revision)?;
        Ok(ProviderModelListing {
            connection: connection.into(),
            revision,
            models,
        })
    }

    pub fn voices(&self, r: &vibevalley_protocol::ProviderVoiceRequest) -> Result<ProviderVoiceListing, ApiError> {
        let key = self.key_at(&r.connection, r.revision)?;
        let limit = r.limit.unwrap_or(20);
        let fits = (1..=150).contains(&limit)
            && r.offset.is_none_or(|o| (0..=100_000).contains(&o))
            && r.status.as_ref().is_none_or(|s| (1..=128).contains(&s.chars().count()));
        if !fits {
            return Err(refuse("server.provider.voiceQuery"));
        }
        let mut query = vec![("limit", limit.to_string())];
        if let Some(o) = r.offset {
            query.push(("offset", o.to_string()));
        }
        if let Some(a) = &r.after {
            query.push(("after", a.clone()));
        }
        if let Some(st) = &r.status {
            query.push(("status", st.clone()));
        }
        let got = moss_get(&*self.fetch, &key, &format!("{MOSS}/audio/voices"), &query, Duration::from_secs(30))?;
        let bad = || refuse("server.provider.invalidResponse");
        let data = got["data"]
            .as_array()
            .filter(|d| got["object"] == "list" && d.len() as i64 <= limit)
            .ok_or_else(bad)?;
        let voices = data
            .iter()
            .map(|v| {
                Some(ProviderVoiceListingVoices {
                    id: v["id"].as_str()?.into(),
                    name: v["name"].as_str()?.into(),
                    created_at_seconds: v["created_at"].as_i64()?,
                })
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(bad)?;
        let has_more = got["has_more"].as_bool().ok_or_else(bad)?;
        self.still_at(r.revision)?;
        Ok(ProviderVoiceListing {
            connection: r.connection.clone(),
            revision: r.revision,
            voices,
            has_more,
            next_cursor: got["next_cursor"].as_str().map(str::to_string),
        })
    }
}

pub fn install(hub: &Hub, provider: Arc<Provider>) {
    let p = provider.clone();
    hub.on::<ops::ProviderGet>(move |_, ()| Ok(p.status()));
    let p = provider.clone();
    hub.on::<ops::ProviderUpdate>(move |_, u| p.update(&u));
    let p = provider.clone();
    hub.on::<ops::ProviderModelList>(move |_, r| p.models(&r.connection, r.revision));
    hub.on::<ops::ProviderVoiceList>(move |_, r| provider.voices(&r));
}
