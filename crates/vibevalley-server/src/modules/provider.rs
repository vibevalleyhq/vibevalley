//! `provider.*`: the MOSS accounts (connections), which one each use is
//! bound to, and the account's models and voices. Ported from VibeValley
//! `platform/provider/connections.ts`, `provider.ts` (`status`, `update`,
//! `models`, `voices`) and `packages/provider/src/moss/{models,voices}.ts`.
//! The providers live in `settings.json` (`Setting::update_providers`).

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, KeySource, LitFalse, LitTrue, Missing, ProviderBinding, ProviderConnection, ProviderConnectionAdapter, ProviderModel,
    ProviderModelListing, ProviderStatus, ProviderUpdate, ProviderVoiceListing, ProviderVoiceListingVoices, Readiness, ops,
};

use super::setting::{Secret, Setting};
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

/// What a MOSS account is bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Use {
    Dictation,
    Image,
    Understanding,
    Speech,
    Live,
    Speakers,
    VoiceDesign,
    Transcription,
    Vision,
}

impl Use {
    pub const ALL: [Use; 9] = [
        Use::Dictation,
        Use::Image,
        Use::Understanding,
        Use::Speech,
        Use::Live,
        Use::Speakers,
        Use::VoiceDesign,
        Use::Transcription,
        Use::Vision,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Use::Dictation => "dictation",
            Use::Image => "image",
            Use::Understanding => "understanding",
            Use::Speech => "speech",
            Use::Live => "live",
            Use::Speakers => "speakers",
            Use::VoiceDesign => "voiceDesign",
            Use::Transcription => "transcription",
            Use::Vision => "vision",
        }
    }

    pub fn models(self) -> &'static [&'static str] {
        match self {
            Use::Dictation | Use::Transcription => &TRANSCRIPTION_MODELS,
            Use::Image => &IMAGE_MODELS,
            Use::Understanding => &UNDERSTANDING_MODELS,
            Use::Speech => &SPEECH_MODELS,
            Use::Live => &LIVE_MODELS,
            Use::Speakers => &SPEAKERS_MODELS,
            Use::VoiceDesign => &VOICE_DESIGN_MODELS,
            Use::Vision => &VISION_MODELS,
        }
    }

    /// The refusal for a model this use does not run.
    fn wrong_model(self) -> ApiError {
        match self {
            Use::Dictation => refuse("server.provider.model"),
            Use::Image => refuse("server.provider.imageModel"),
            Use::Understanding => refuse("server.provider.understandingModel"),
            Use::Speech => refuse("server.provider.speechModel"),
            _ => {
                let capability = t(&format!("server.provider.use.{}", self.name()), &[]);
                ApiError::new(
                    BizCode::ProviderRefused,
                    t("server.provider.capabilityModel", &[("capability", capability.into())]),
                )
            }
        }
    }
}

/// A MOSS account as `settings.json` keeps it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub adapter: ProviderConnectionAdapter,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub key: Secret,
}

/// The MOSS accounts and what each use is bound to (`ProviderSettings`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Providers {
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub connections: Vec<Connection>,
    pub dictation: Option<ProviderBinding>,
    pub image: Option<ProviderBinding>,
    pub understanding: Option<ProviderBinding>,
    pub speech: Option<ProviderBinding>,
    pub live: Option<ProviderBinding>,
    pub speakers: Option<ProviderBinding>,
    pub voice_design: Option<ProviderBinding>,
    pub transcription: Option<ProviderBinding>,
    pub vision: Option<ProviderBinding>,
}

/// One use's account: the connection, its model and key.
#[derive(Debug, Clone)]
pub struct Account {
    pub connection: String,
    pub revision: i64,
    pub model: String,
    pub key: Secret,
}

impl Providers {
    pub fn binding(&self, u: Use) -> Option<&ProviderBinding> {
        match u {
            Use::Dictation => self.dictation.as_ref(),
            Use::Image => self.image.as_ref(),
            Use::Understanding => self.understanding.as_ref(),
            Use::Speech => self.speech.as_ref(),
            Use::Live => self.live.as_ref(),
            Use::Speakers => self.speakers.as_ref(),
            Use::VoiceDesign => self.voice_design.as_ref(),
            Use::Transcription => self.transcription.as_ref(),
            Use::Vision => self.vision.as_ref(),
        }
    }

    /// `boundConnection`: the connection named, on and with a key.
    fn usable(&self, id: &str) -> Option<&Connection> {
        self.connections.iter().find(|c| c.id == id && c.enabled && !c.key.is_empty())
    }

    /// The account bound to `u`, ready to call.
    pub fn account(&self, u: Use) -> Option<Account> {
        let b = self.binding(u)?;
        let c = self.usable(&b.connection)?;
        Some(Account {
            connection: c.id.clone(),
            revision: self.revision,
            model: b.model.clone(),
            key: c.key.clone(),
        })
    }

    /// A usable connection's account, whatever is bound to it now: a job goes on with the account it was asked with.
    pub fn account_on(&self, connection: &str, model: &str) -> Option<Account> {
        let c = self.usable(connection)?;
        Some(Account {
            connection: c.id.clone(),
            revision: self.revision,
            model: model.into(),
            key: c.key.clone(),
        })
    }

    /// `bindingOf`: whether `u` can run, and what it lacks.
    pub fn readiness(&self, u: Use) -> Readiness {
        let lacks = |missing| Readiness::False { ready: LitFalse, missing };
        if self.connections.is_empty() {
            return lacks(Missing::MossAccount);
        }
        let Some(c) = self.binding(u).and_then(|b| self.connections.iter().find(|c| c.id == b.connection)) else {
            return lacks(Missing::Binding);
        };
        if !c.enabled {
            return lacks(Missing::MossOff);
        }
        if c.key.is_empty() {
            return lacks(Missing::MossKey);
        }
        Readiness::True { ready: LitTrue }
    }

    /// `providerStatus`: the providers with each key as a hint.
    pub fn status(&self) -> ProviderStatus {
        let models = |m: &[&str]| m.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        ProviderStatus {
            revision: self.revision,
            connections: self
                .connections
                .iter()
                .map(|c| ProviderConnection {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    adapter: c.adapter,
                    enabled: c.enabled,
                    key: c.key.status(KeySource::Settings),
                })
                .collect(),
            dictation: self.dictation.clone(),
            image: self.image.clone(),
            live: self.live.clone(),
            live_models: models(&LIVE_MODELS),
            speakers: self.speakers.clone(),
            speakers_models: models(&SPEAKERS_MODELS),
            voice_design: self.voice_design.clone(),
            voice_design_models: models(&VOICE_DESIGN_MODELS),
            transcription: self.transcription.clone(),
            transcription_models: models(&TRANSCRIPTION_MODELS),
            vision: self.vision.clone(),
            vision_models: models(&VISION_MODELS),
            dictation_models: models(&TRANSCRIPTION_MODELS),
            image_models: models(&IMAGE_MODELS),
            understanding: self.understanding.clone(),
            understanding_models: models(&UNDERSTANDING_MODELS),
            speech: self.speech.clone(),
            speech_models: models(&SPEECH_MODELS),
        }
    }
}

fn refuse(key: &str) -> ApiError {
    ApiError::new(BizCode::ProviderRefused, t(key, &[]))
}

fn good_connection_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `connectionsOver`: the update laid over the current providers; refused
/// when it cannot be right.
pub fn connections_over(current: &Providers, update: &ProviderUpdate) -> Result<Providers, ApiError> {
    if update.revision != current.revision {
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
        let key = match &input.key {
            None => current.connections.iter().find(|c| c.id == input.id).map(|c| c.key.clone()).unwrap_or_default(),
            Some(None) => Secret::default(),
            Some(Some(k)) => Secret::new(k.trim()),
        };
        let given_empty = matches!(&input.key, Some(Some(_))) && key.is_empty();
        if given_empty || key.expose().chars().any(char::is_whitespace) || key.expose().encode_utf16().count() > 4096 {
            return Err(refuse("server.provider.key"));
        }
        connections.push(Connection {
            id: input.id.clone(),
            name: name.into(),
            adapter: input.adapter,
            enabled: input.enabled,
            key,
        });
    }
    let next = Providers {
        revision: current.revision + 1,
        connections,
        dictation: update.dictation.clone(),
        image: update.image.clone(),
        understanding: update.understanding.clone(),
        speech: update.speech.clone(),
        live: update.live.clone(),
        speakers: update.speakers.clone(),
        voice_design: update.voice_design.clone(),
        transcription: update.transcription.clone(),
        vision: update.vision.clone(),
    };
    for u in Use::ALL {
        if let Some(b) = next.binding(u)
            && next.usable(&b.connection).is_none()
        {
            return Err(refuse("server.provider.bound"));
        }
    }
    for u in Use::ALL {
        if let Some(b) = next.binding(u)
            && !u.models().contains(&b.model.as_str())
        {
            return Err(u.wrong_model());
        }
    }
    Ok(next)
}

/// A GET to MOSS: the parsed 2xx body, else its failure in the user's words (`refusal`).
fn moss_get(fetch: &dyn Fetch, key: &Secret, url: &str, query: &[(&str, String)], timeout: Duration) -> Result<Value, ApiError> {
    let key = key.expose();
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
        self.setting.providers().status()
    }

    pub fn update(&self, input: &ProviderUpdate) -> Result<ProviderStatus, ApiError> {
        let next = self.setting.update_providers(|current| connections_over(current, input))?;
        Ok(next.status())
    }

    /// The bound connection's key at `revision`, else refused.
    fn key_at(&self, connection: &str, revision: i64) -> Result<Secret, ApiError> {
        let p = self.setting.providers();
        if p.revision != revision {
            return Err(refuse("server.provider.changed"));
        }
        let c = p.usable(connection).ok_or_else(|| refuse("server.provider.noKey"))?;
        Ok(c.key.clone())
    }

    fn still_at(&self, revision: i64) -> Result<(), ApiError> {
        if self.setting.providers().revision != revision {
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
