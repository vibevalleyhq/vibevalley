//! `provider.*`: the MOSS accounts (connections), which one each use is
//! bound to, and the account's models and voices.
//! The providers live in `settings.json` (`Setting::update_providers`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, ProviderModel, ProviderModelListing, ProviderStatus, ProviderUpdate, ProviderVoiceListing, ProviderVoiceListingVoices};

use super::http::{Fetch, FetchError, Request, read_max};
pub use super::setting::{
    Account, Connection, IMAGE_MODELS, LIVE_MODELS, MOSS, Providers, SPEAKERS_MODELS, SPEECH_MODELS, TRANSCRIPTION_MODELS, UNDERSTANDING_MODELS, Use,
    VISION_MODELS, VOICE_DESIGN_MODELS,
};
use super::setting::{Secret, Setting};

fn refuse(key: &str) -> ApiError {
    ApiError::new(BizCode::ProviderRefused, t(key, &[]))
}

fn wrong_model(u: Use) -> ApiError {
    match u {
        Use::Image => refuse("server.provider.imageModel"),
        Use::Understanding => refuse("server.provider.understandingModel"),
        Use::Speech => refuse("server.provider.speechModel"),
        Use::Live | Use::Speakers | Use::VoiceDesign | Use::Transcription | Use::Vision => {
            let capability = t(&format!("server.provider.use.{}", u.name()), &[]);
            ApiError::new(
                BizCode::ProviderRefused,
                t("server.provider.capabilityModel", &[("capability", capability.into())]),
            )
        }
    }
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
            return Err(wrong_model(u));
        }
    }
    Ok(next)
}

/// A GET to MOSS: the parsed 2xx body, else its failure in the user's words (`refusal`).
async fn moss_get_async(fetch: &Arc<dyn Fetch>, key: &Secret, url: &str, query: &[(&str, String)], timeout: Duration) -> Result<Value, ApiError> {
    let key = key.expose();
    if key.trim().is_empty() || key.chars().any(char::is_whitespace) {
        return Err(refuse("server.provider.noKey"));
    }
    let mut target = url::Url::parse(url).map_err(|_| refuse("server.provider.network"))?;
    for (k, v) in query {
        target.query_pairs_mut().append_pair(k, v);
    }
    let response = fetch
        .clone()
        .fetch_async(
            Request {
                method: "GET",
                url: target.to_string(),
                headers: vec![("authorization".into(), format!("Bearer {key}")), ("accept".into(), "application/json".into())],
                body: None,
                timeout,
            },
            tokio_util::sync::CancellationToken::new(),
        )
        .await
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
    let bytes = crate::spawn_blocking_traced(move || read_max(&mut body, 1 << 20))
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
        .map_err(|_| refuse("server.provider.tooLarge"))?;
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

    pub async fn models_async(&self, connection: &str, revision: i64) -> Result<ProviderModelListing, ApiError> {
        let key = self.key_at(connection, revision)?;
        let list = moss_get_async(&self.fetch, &key, &format!("{MOSS}/models"), &[], Duration::from_secs(15)).await?;
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

    pub async fn voices_async(&self, r: &vibevalley_protocol::ProviderVoiceRequest) -> Result<ProviderVoiceListing, ApiError> {
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
        let got = moss_get_async(&self.fetch, &key, &format!("{MOSS}/audio/voices"), &query, Duration::from_secs(30)).await?;
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
