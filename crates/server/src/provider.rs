//! `provider.*`: unified model providers (1 provider = 1 API key),
//! connectivity verification & capability-tagged model discovery, and
//! per-scene primary + fallback policy bindings in `settings.json`.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, ModelCapability, ProviderBinding, ProviderConnectionAdapter, ProviderModel, ProviderModelListing, ProviderStatus, ProviderUpdate,
    ProviderVerification, ProviderVerificationStatus, ProviderVerifyRequest, ProviderVoiceListing, ProviderVoiceListingVoices, ProviderVoiceRequest,
};

use crate::context::http::{Fetch, FetchError, Request, read_max};
pub use crate::setting::{
    Account, Connection, IMAGE_MODELS, LIVE_MODELS, MOSS, Providers, SPEAKERS_MODELS, SPEECH_MODELS, TRANSCRIPTION_MODELS, UNDERSTANDING_MODELS, Use,
    VISION_MODELS, VOICE_DESIGN_MODELS,
};
use crate::setting::{Secret, Setting};

pub fn default_base_url(adapter: ProviderConnectionAdapter) -> &'static str {
    match adapter {
        ProviderConnectionAdapter::DeepSeek => "https://api.deepseek.com",
        ProviderConnectionAdapter::MiniMax => "https://api.minimaxi.com/v1",
        ProviderConnectionAdapter::Moss => MOSS,
        ProviderConnectionAdapter::OpenAi => "https://api.openai.com/v1",
        ProviderConnectionAdapter::Anthropic => "https://api.anthropic.com/v1",
    }
}

pub fn provider_display_name(adapter: ProviderConnectionAdapter) -> &'static str {
    match adapter {
        ProviderConnectionAdapter::DeepSeek => "DeepSeek",
        ProviderConnectionAdapter::MiniMax => "MiniMax",
        ProviderConnectionAdapter::Moss => "MOSS",
        ProviderConnectionAdapter::OpenAi => "OpenAI",
        ProviderConnectionAdapter::Anthropic => "Anthropic",
    }
}

/// Infers normalized capability tags (`Chat` / `ASR` / `TTS` / `Realtime` / `Vision` / `Image`)
/// from the provider adapter and model identifier.
pub fn infer_model_capabilities(adapter: ProviderConnectionAdapter, model_id: &str) -> Vec<ModelCapability> {
    let lower = model_id.to_ascii_lowercase();
    let mut caps = Vec::new();
    let mut push = |cap: ModelCapability| {
        if !caps.contains(&cap) {
            caps.push(cap);
        }
    };

    match adapter {
        ProviderConnectionAdapter::DeepSeek => {
            push(ModelCapability::Chat);
            if lower.contains("vl") || lower.contains("vision") {
                push(ModelCapability::Vision);
            }
        }
        ProviderConnectionAdapter::MiniMax => {
            if lower.contains("speech") || lower.contains("tts") || lower.contains("t2a") {
                push(ModelCapability::Tts);
            } else if lower.contains("asr") || lower.contains("transcribe") {
                push(ModelCapability::Asr);
            } else if lower.contains("realtime") || lower.contains("live") {
                push(ModelCapability::Realtime);
            } else if lower.contains("image") {
                push(ModelCapability::Image);
            } else if lower.contains("vl") || lower.contains("vision") {
                push(ModelCapability::Chat);
                push(ModelCapability::Vision);
            } else {
                push(ModelCapability::Chat);
            }
        }
        ProviderConnectionAdapter::Moss => {
            if lower.contains("image") {
                push(ModelCapability::Image);
            } else if lower.contains("vl-realtime") {
                push(ModelCapability::Vision);
                push(ModelCapability::Realtime);
            } else if lower.contains("-vl") || lower.contains("vision") {
                push(ModelCapability::Vision);
            } else if lower.contains("live") || lower.contains("realtime") {
                push(ModelCapability::Realtime);
            } else if lower.contains("transcribe") || lower.contains("asr") {
                push(ModelCapability::Asr);
            } else if lower.contains("tts") || lower.contains("voice-generator") || lower.contains("speech") {
                push(ModelCapability::Tts);
            } else if lower.contains("chat") {
                push(ModelCapability::Chat);
            }
        }
        ProviderConnectionAdapter::OpenAi => {
            if lower.contains("realtime") {
                push(ModelCapability::Realtime);
                push(ModelCapability::Chat);
            } else if lower.contains("whisper") || lower.contains("transcribe") {
                push(ModelCapability::Asr);
            } else if lower.starts_with("tts-") || lower.contains("-tts") {
                push(ModelCapability::Tts);
            } else if lower.contains("dall-e") || lower.contains("image") {
                push(ModelCapability::Image);
            } else if lower.contains("4o") || lower.contains("4.1") || lower.contains("turbo") || lower.contains("gpt-5") || lower.contains("vision") {
                push(ModelCapability::Chat);
                push(ModelCapability::Vision);
                if lower.contains("audio") {
                    push(ModelCapability::Tts);
                    push(ModelCapability::Asr);
                }
            } else {
                push(ModelCapability::Chat);
            }
        }
        ProviderConnectionAdapter::Anthropic => {
            push(ModelCapability::Chat);
            if lower.starts_with("claude-") {
                push(ModelCapability::Vision);
            }
        }
    }
    caps
}

fn refuse(key: &str) -> ApiError {
    ApiError::new(BizCode::ProviderRefused, t(key, &[]))
}

fn wrong_model(u: Use) -> ApiError {
    match u {
        Use::Image => refuse("server.provider.imageModel"),
        Use::Understanding => refuse("server.provider.understandingModel"),
        Use::Speech => refuse("server.provider.speechModel"),
        Use::Orchestrator | Use::Polish | Use::Live | Use::Speakers | Use::VoiceDesign | Use::Transcription | Use::Vision => {
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

fn good_base_url(url: &str) -> bool {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.chars().any(char::is_whitespace)) && url.chars().count() <= 512
}

fn validate_binding(next: &Providers, u: Use, b: &ProviderBinding) -> Result<(), ApiError> {
    let Some(conn) = next.usable(&b.connection) else {
        return Err(refuse("server.provider.bound"));
    };
    let model = b.model.trim();
    if model.is_empty() || model.chars().any(char::is_whitespace) || model.encode_utf16().count() > 160 {
        return Err(wrong_model(u));
    }
    if !conn.models.is_empty() {
        let req_cap = u.required_capability();
        let supported = conn
            .models
            .iter()
            .any(|m| m.id == model && (m.capabilities.is_empty() || m.capabilities.contains(&req_cap)));
        if !supported {
            return Err(wrong_model(u));
        }
    } else if conn.adapter == ProviderConnectionAdapter::Moss && !u.models().contains(&model) {
        return Err(wrong_model(u));
    }
    Ok(())
}

/// Lays `update` over `current` providers; refused when invalid or stale.
pub fn connections_over(current: &Providers, update: &ProviderUpdate) -> Result<Providers, ApiError> {
    if update.revision != current.revision {
        return Err(refuse("server.provider.changed"));
    }
    if update.connections.len() > 32 {
        return Err(refuse("server.provider.limit"));
    }
    let mut seen_ids = HashSet::new();
    let mut seen_adapters = HashSet::new();
    let mut connections = Vec::new();
    for input in &update.connections {
        if !good_connection_id(&input.id) || !seen_ids.insert(input.id.clone()) {
            return Err(refuse("server.provider.id"));
        }
        if !seen_adapters.insert(input.adapter) {
            return Err(refuse("server.provider.duplicateAdapter"));
        }
        let name = input.name.trim();
        if name.is_empty() || name.encode_utf16().count() > 80 {
            return Err(refuse("server.provider.name"));
        }
        let prev = current.connections.iter().find(|c| c.id == input.id);
        let key = match &input.key {
            None => prev.map(|c| c.key.clone()).unwrap_or_default(),
            Some(None) => Secret::default(),
            Some(Some(k)) => Secret::new(k.trim()),
        };
        let given_empty = matches!(&input.key, Some(Some(_))) && key.is_empty();
        if given_empty || key.expose().chars().any(char::is_whitespace) || key.expose().encode_utf16().count() > 4096 {
            return Err(refuse("server.provider.key"));
        }
        let base_url = match &input.base_url {
            None => prev.and_then(|c| c.base_url.clone()),
            Some(None) => None,
            Some(Some(u)) => {
                let trimmed = u.trim().trim_end_matches('/').to_string();
                if trimmed.is_empty() || !good_base_url(&trimmed) {
                    return Err(refuse("server.provider.baseUrl"));
                }
                Some(trimmed)
            }
        };
        let (models, verification) = match prev {
            Some(p) if p.adapter == input.adapter && p.key == key && p.base_url == base_url && !key.is_empty() => (p.models.clone(), p.verification.clone()),
            _ => (Vec::new(), None),
        };
        connections.push(Connection {
            id: input.id.clone(),
            name: name.into(),
            adapter: input.adapter,
            enabled: input.enabled,
            key,
            base_url,
            models,
            verification,
        });
    }

    let mut seen_scenes = HashSet::new();
    for policy in &update.scene_policies {
        if !seen_scenes.insert(policy.scene) || policy.fallbacks.len() > 8 {
            return Err(refuse("server.provider.policy"));
        }
    }

    let next = Providers {
        revision: current.revision + 1,
        connections,
        orchestrator: update.orchestrator.clone(),
        polish: update.polish.clone(),
        image: update.image.clone(),
        understanding: update.understanding.clone(),
        speech: update.speech.clone(),
        live: update.live.clone(),
        speakers: update.speakers.clone(),
        voice_design: update.voice_design.clone(),
        transcription: update.transcription.clone(),
        vision: update.vision.clone(),
        scene_policies: update.scene_policies.clone(),
    };
    for u in Use::ALL {
        if let Some(b) = next.binding(u) {
            validate_binding(&next, u, b)?;
        }
    }
    for policy in &next.scene_policies {
        let u = Use::from_scene(policy.scene);
        for fb in &policy.fallbacks {
            validate_binding(&next, u, fb)?;
        }
    }
    Ok(next)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn provider_refuse(key: &str, adapter: ProviderConnectionAdapter) -> ApiError {
    ApiError::new(BizCode::ProviderRefused, t(key, &[("provider", provider_display_name(adapter).into())]))
}

/// A GET to a provider API: the parsed 2xx body, else its failure in the user's words.
async fn provider_get_async(
    fetch: &Arc<dyn Fetch>,
    adapter: ProviderConnectionAdapter,
    key: &Secret,
    url: &str,
    query: &[(&str, String)],
    timeout: Duration,
) -> Result<Value, ApiError> {
    let key = key.expose();
    if key.trim().is_empty() || key.chars().any(char::is_whitespace) {
        return Err(provider_refuse("server.provider.noKey", adapter));
    }
    let mut target = url::Url::parse(url).map_err(|_| provider_refuse("server.provider.network", adapter))?;
    for (k, v) in query {
        target.query_pairs_mut().append_pair(k, v);
    }
    let mut headers = vec![("accept".into(), "application/json".into())];
    if adapter == ProviderConnectionAdapter::Anthropic {
        headers.push(("x-api-key".into(), key.to_string()));
        headers.push(("anthropic-version".into(), "2023-06-01".into()));
    } else {
        headers.push(("authorization".into(), format!("Bearer {key}")));
    }
    let response = fetch
        .clone()
        .fetch_async(
            Request {
                method: "GET",
                url: target.to_string(),
                headers,
                body: None,
                timeout,
            },
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .map_err(|e| match e {
            FetchError::Timeout => provider_refuse("server.provider.timeout", adapter),
            FetchError::Network(_) => provider_refuse("server.provider.network", adapter),
        })?;
    match response.status {
        200..=299 => {}
        401 => return Err(provider_refuse("server.provider.authentication", adapter)),
        403 => return Err(provider_refuse("server.provider.forbidden", adapter)),
        429 => return Err(provider_refuse("server.provider.rateLimited", adapter)),
        status => {
            return Err(ApiError::new(
                BizCode::ProviderRefused,
                t(
                    "server.provider.httpStatus",
                    &[("provider", provider_display_name(adapter).into()), ("status", (status as i64).into())],
                ),
            ));
        }
    }
    let mut body = response.body;
    let bytes = crate::log::spawn_blocking_traced(move || read_max(&mut body, 1 << 20))
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
        .map_err(|_| provider_refuse("server.provider.tooLarge", adapter))?;
    serde_json::from_slice(&bytes).map_err(|_| provider_refuse("server.provider.invalidResponse", adapter))
}

async fn fetch_models_for_adapter_async(
    fetch: &Arc<dyn Fetch>,
    adapter: ProviderConnectionAdapter,
    base_url: Option<&str>,
    key: &Secret,
) -> Result<Vec<ProviderModel>, ApiError> {
    let base = base_url.unwrap_or_else(|| default_base_url(adapter)).trim_end_matches('/');
    let list = provider_get_async(fetch, adapter, key, &format!("{base}/models"), &[], Duration::from_secs(15)).await?;
    let object_ok = list.get("object").is_none_or(|o| o == "list");
    let data = list["data"]
        .as_array()
        .filter(|_| object_ok)
        .ok_or_else(|| provider_refuse("server.provider.invalidResponse", adapter))?;
    if data.len() > 1000 {
        return Err(provider_refuse("server.provider.tooLarge", adapter));
    }
    data.iter()
        .map(|m| {
            let Some(id) = m["id"].as_str().filter(|s| !s.is_empty()) else {
                return Err(provider_refuse("server.provider.invalidResponse", adapter));
            };
            let owner = m["owned_by"].as_str().unwrap_or_else(|| adapter.as_str());
            Ok(ProviderModel {
                id: id.into(),
                owner: owner.into(),
                capabilities: infer_model_capabilities(adapter, id),
            })
        })
        .collect()
}

pub struct Provider {
    setting: Arc<Setting>,
    /// How provider APIs are reached (offline in unit tests).
    fetch: Arc<dyn Fetch>,
}

impl Provider {
    pub fn new(setting: Arc<Setting>, fetch: Arc<dyn Fetch>) -> Provider {
        Provider { setting, fetch }
    }

    pub fn status(&self) -> ProviderStatus {
        self.setting.provider_status()
    }

    pub async fn update_async(&self, input: &ProviderUpdate) -> Result<ProviderStatus, ApiError> {
        self.setting.update_providers_async(|current| connections_over(current, input)).await?;
        Ok(self.setting.provider_status())
    }

    /// Resolves `(adapter, base_url, key)` for `connection` at `revision`.
    fn target_at(&self, connection: &str, revision: i64) -> Result<(ProviderConnectionAdapter, Option<String>, Secret), ApiError> {
        let p = self.setting.providers();
        if p.revision != revision {
            return Err(refuse("server.provider.changed"));
        }
        if let Some(c) = p.connections.iter().find(|c| c.id == connection) {
            if !c.enabled {
                return Err(provider_refuse("server.provider.noKey", c.adapter));
            }
            let key = if !c.key.is_empty() {
                c.key.clone()
            } else if c.adapter == ProviderConnectionAdapter::DeepSeek
                && let Some(env_key) = self.setting.config_deepseek_key()
            {
                Secret::new(env_key)
            } else {
                return Err(provider_refuse("server.provider.noKey", c.adapter));
            };
            return Ok((c.adapter, c.base_url.clone(), key));
        }
        if connection == "deepseek"
            && let Some(env_key) = self.setting.config_deepseek_key()
        {
            return Ok((ProviderConnectionAdapter::DeepSeek, None, Secret::new(env_key)));
        }
        Err(provider_refuse("server.provider.noKey", ProviderConnectionAdapter::Moss))
    }

    fn still_at(&self, revision: i64) -> Result<(), ApiError> {
        if self.setting.providers().revision != revision {
            return Err(refuse("server.provider.changed"));
        }
        Ok(())
    }

    async fn store_discovery_async(
        &self,
        connection: &str,
        expected_revision: i64,
        adapter: ProviderConnectionAdapter,
        models: Option<Vec<ProviderModel>>,
        verification: ProviderVerification,
    ) -> Result<(), ApiError> {
        self.setting
            .update_providers_async(|current| {
                if current.revision != expected_revision {
                    return Err(refuse("server.provider.changed"));
                }
                let mut next = current.clone();
                if let Some(conn) = next.connections.iter_mut().find(|c| c.id == connection) {
                    if let Some(m) = models {
                        conn.models = m;
                    }
                    conn.verification = Some(verification);
                } else if connection == "deepseek" && adapter == ProviderConnectionAdapter::DeepSeek {
                    next.connections.push(Connection {
                        id: "deepseek".into(),
                        name: "DeepSeek".into(),
                        adapter,
                        enabled: true,
                        key: Secret::default(),
                        base_url: None,
                        models: models.unwrap_or_default(),
                        verification: Some(verification),
                    });
                } else {
                    return Err(refuse("server.provider.changed"));
                }
                next.revision += 1;
                Ok(next)
            })
            .await?;
        Ok(())
    }

    /// Verifies connectivity for `r.connection` and caches discovered capability-tagged models.
    pub async fn verify_async(&self, r: &ProviderVerifyRequest) -> Result<ProviderStatus, ApiError> {
        let (adapter, base_url, key) = self.target_at(&r.connection, r.revision)?;
        let checked_at = now_ms();
        match fetch_models_for_adapter_async(&self.fetch, adapter, base_url.as_deref(), &key).await {
            Ok(models) => {
                let verification = ProviderVerification {
                    status: ProviderVerificationStatus::Verified,
                    checked_at: Some(checked_at),
                    error: None,
                };
                self.store_discovery_async(&r.connection, r.revision, adapter, Some(models), verification)
                    .await?;
            }
            Err(err) => {
                let verification = ProviderVerification {
                    status: ProviderVerificationStatus::Failed,
                    checked_at: Some(checked_at),
                    error: Some(err.message),
                };
                self.store_discovery_async(&r.connection, r.revision, adapter, None, verification).await?;
            }
        }
        Ok(self.setting.provider_status())
    }

    pub async fn models_async(&self, connection: &str, revision: i64) -> Result<ProviderModelListing, ApiError> {
        let (adapter, base_url, key) = self.target_at(connection, revision)?;
        let models = fetch_models_for_adapter_async(&self.fetch, adapter, base_url.as_deref(), &key).await?;
        self.still_at(revision)?;
        let verification = ProviderVerification {
            status: ProviderVerificationStatus::Verified,
            checked_at: Some(now_ms()),
            error: None,
        };
        let _ = self
            .store_discovery_async(connection, revision, adapter, Some(models.clone()), verification)
            .await;
        Ok(ProviderModelListing {
            connection: connection.into(),
            revision: self.setting.providers().revision,
            models,
        })
    }

    pub async fn voices_async(&self, r: &ProviderVoiceRequest) -> Result<ProviderVoiceListing, ApiError> {
        let (adapter, base_url, key) = self.target_at(&r.connection, r.revision)?;
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
        let base = base_url.as_deref().unwrap_or_else(|| default_base_url(adapter)).trim_end_matches('/');
        let got = provider_get_async(&self.fetch, adapter, &key, &format!("{base}/audio/voices"), &query, Duration::from_secs(30)).await?;
        let bad = || provider_refuse("server.provider.invalidResponse", adapter);
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
