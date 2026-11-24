//! `setting.*`: the farm's settings file (`<home>/settings.json`), read once
//! into `Stored` and written whole on each change; keys are `Secret`s,
//! shown by hint only; the voice's settings over their defaults; and each
//! feature's readiness.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, Feature, KeySource, KeyStatus, LitFalse, LitTrue, Locale, MemorySource, MemorySourceKind, Missing, ProviderBinding, ProviderConnection,
    ProviderConnectionAdapter, ProviderStatus, Readiness, SettingsStatus, SettingsUpdate, SettingsUpdateVoice, SpacePaths, Validation, VoiceSettings,
};

pub const MOSS: &str = "https://api.mosi.cn/v1";

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
    pub const ALL: [Use; 8] = [
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
            Use::Transcription => &TRANSCRIPTION_MODELS,
            Use::Image => &IMAGE_MODELS,
            Use::Understanding => &UNDERSTANDING_MODELS,
            Use::Speech => &SPEECH_MODELS,
            Use::Live => &LIVE_MODELS,
            Use::Speakers => &SPEAKERS_MODELS,
            Use::VoiceDesign => &VOICE_DESIGN_MODELS,
            Use::Vision => &VISION_MODELS,
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

    /// The connection named, enabled and carrying a non-empty key.
    pub fn usable(&self, id: &str) -> Option<&Connection> {
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

    /// Whether `u` can run, and what it lacks.
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

    /// The providers with each key redacted to its hint.
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
            image_models: models(&IMAGE_MODELS),
            understanding: self.understanding.clone(),
            understanding_models: models(&UNDERSTANDING_MODELS),
            speech: self.speech.clone(),
            speech_models: models(&SPEECH_MODELS),
        }
    }
}

/// A key or token: never printed, shown by its last four characters.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Secret {
        Secret(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn hint(&self) -> String {
        let tail: String = self.0.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("…{tail}")
    }

    pub fn status(&self, source: KeySource) -> KeyStatus {
        if self.is_empty() {
            KeyStatus { source: None, hint: None }
        } else {
            KeyStatus {
                source: Some(source),
                hint: Some(self.hint()),
            }
        }
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.is_empty() {
            f.write_str("Secret(none)")
        } else {
            write!(f, "Secret({})", self.hint())
        }
    }
}

/// What the server was started with: where the farm lives, and keys given
/// outside the settings file.
#[derive(Debug, Clone, Default)]
pub struct SettingConfig {
    pub home: PathBuf,
    /// The work root: repos and worktrees live under it.
    pub work_root: PathBuf,
    pub version: String,
    pub deepseek_api_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSource {
    kind: MemorySourceKind,
    #[serde(default)]
    url: String,
    #[serde(default, skip_serializing_if = "is_false")]
    enabled: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    read: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    write: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    everything: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    key: Secret,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// `settings.json` as stored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(skip_serializing_if = "Option::is_none")]
    locale: Option<Locale>,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    deepseek_api_key: Secret,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    memory_sources: Vec<StoredSource>,
    /// The voice's settings that differ from its defaults.
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<SettingsUpdateVoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    providers: Option<Providers>,
}

pub struct Setting {
    config: SettingConfig,
    file: PathBuf,
    /// One save at a time.
    stored: Mutex<Stored>,
}

fn has_space(s: &str) -> bool {
    s.chars().any(char::is_whitespace)
}

/// `^https?:\/\/\S+$`.
fn http_url(s: &str) -> bool {
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !has_space(r))
}

fn users_language() -> &'static str {
    if vibevalley_i18n::locale() == "en" { "英文（English）" } else { "中文" }
}

fn persona() -> String {
    format!(
        "你是码农场物语的助手，一个和气、利落的年轻农夫。农场里的帮工是一群小动物，它们其实是写代码的 AI：后端老周（熊）、测试小吴（兔子）、前端阿郑（小狐狸）、文档员 Kimi（猫）、情报 Grok（猫头鹰）、Pi 实验员（刺猬）、夜班反重力（浣熊）。\n\n\
         用户跟你说要做什么活，你就简短确认会派给谁去做，比如「好，让测试小吴去跑一遍测试」。派活和进度由农场自己处理，你看不到地里的实时情况，不要编造进度、结果或文件名；被问到进度时，就说可以看地里的牌子或者日志。\n\n\
         这是语音对话：每次只说一两句，口语化，不列清单，不用 markdown。一次最多问一个问题。用{}回答。",
        users_language()
    )
}

/// What is wrong with a voice update, or "".
fn voice_problem(v: &SettingsUpdateVoice) -> String {
    if v.persona.as_deref().is_some_and(|p| p.trim().is_empty()) {
        return t("server.setting.voice.persona", &[]);
    }
    String::new()
}

/// Validates a settings update; empty strings clear and are always fine.
pub fn settings_problem(u: &SettingsUpdate) -> String {
    let trimmed = |k: &Option<String>| k.as_deref().unwrap_or("").trim().to_string();
    let deepseek = trimmed(&u.deepseek_api_key);
    if !deepseek.is_empty() && (has_space(&deepseek) || deepseek.chars().count() < 8) {
        return t("server.setting.deepseekKey", &[]);
    }
    let mut seen = Vec::new();
    for m in u.memory_sources.iter().flatten() {
        if seen.contains(&m.kind) {
            return t("server.setting.memory.twice", &[("kind", m.kind.as_str().into())]);
        }
        seen.push(m.kind);
        let url = m.url.trim();
        if m.enabled && url.is_empty() {
            return t("server.setting.memory.noUrl", &[]);
        }
        if !url.is_empty() && !http_url(url) {
            return t("server.setting.memory.url", &[]);
        }
        if m.key.as_deref().is_some_and(|k| has_space(k.trim())) {
            return t("server.setting.memory.keySpace", &[]);
        }
    }
    u.voice.as_ref().map(voice_problem).unwrap_or_default()
}

/// The voice: its defaults with what is set laid over them.
fn voice_over(d: VoiceSettings, o: &SettingsUpdateVoice) -> VoiceSettings {
    VoiceSettings {
        persona: o.persona.clone().unwrap_or(d.persona),
        greeting: o.greeting.clone().unwrap_or(d.greeting),
    }
}

/// What of `v` differs from `d`.
fn voice_overrides(v: VoiceSettings, d: &VoiceSettings) -> SettingsUpdateVoice {
    fn differs<T: PartialEq>(v: T, d: &T) -> Option<T> {
        (v != *d).then_some(v)
    }
    SettingsUpdateVoice {
        persona: differs(v.persona, &d.persona),
        greeting: differs(v.greeting, &d.greeting),
    }
}

fn ready() -> Readiness {
    Readiness::True { ready: LitTrue }
}

fn lacks(missing: Missing) -> Readiness {
    Readiness::False { ready: LitFalse, missing }
}

impl Setting {
    /// Reads `<home>/settings.json`; one that cannot be read is set aside
    /// (`settings.json.bad`) and the settings start empty.
    pub fn open(config: SettingConfig) -> Arc<Setting> {
        let file = config.home.join(vibevalley_protocol::home::SETTINGS_FILE);
        let stored = match std::fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str::<Stored>(&text).unwrap_or_else(|_| {
                let _ = std::fs::rename(&file, file.with_extension("json.bad"));
                Stored::default()
            }),
            Err(_) => Stored::default(),
        };
        vibevalley_i18n::set_locale(stored.locale.unwrap_or(Locale::Zh).as_str());
        Arc::new(Setting {
            config,
            file,
            stored: Mutex::new(stored),
        })
    }

    fn stored(&self) -> Stored {
        self.stored.lock().clone()
    }

    /// The voice's defaults, in the farm's language as it is now.
    pub fn voice_defaults(&self) -> VoiceSettings {
        VoiceSettings {
            persona: persona(),
            greeting: t("shared.greeting", &[]),
        }
    }

    /// A key from the settings file, else from the server's start.
    fn pick(saved: &Secret, given: &str) -> Option<(Secret, KeySource)> {
        if !saved.is_empty() {
            Some((saved.clone(), KeySource::Settings))
        } else if !given.is_empty() {
            Some((Secret::new(given), KeySource::Config))
        } else {
            None
        }
    }

    /// The DeepSeek key the orchestrator calls with.
    pub fn deepseek_api_key(&self) -> Option<String> {
        Self::pick(&self.stored().deepseek_api_key, &self.config.deepseek_api_key).map(|k| k.0.expose().to_string())
    }

    /// The voice's settings as a call reads them at its start.
    pub fn voice(&self) -> VoiceSettings {
        voice_over(self.voice_defaults(), &self.stored().voice.unwrap_or_default())
    }

    /// The MOSS providers.
    pub fn providers(&self) -> Providers {
        self.stored().providers.unwrap_or_default()
    }

    /// Non-empty live secret values (>= 6 chars) for diagnostics redaction, sorted longest first.
    pub fn live_secrets(&self) -> Vec<String> {
        let st = self.stored();
        let mut out = Vec::new();
        let mut push = |raw: &str| {
            let trimmed = raw.trim();
            if trimmed.chars().count() >= 6 && !out.iter().any(|existing: &String| existing == trimmed) {
                out.push(trimmed.to_string());
            }
        };
        push(st.deepseek_api_key.expose());
        push(&self.config.deepseek_api_key);
        for source in &st.memory_sources {
            push(source.key.expose());
        }
        if let Some(providers) = &st.providers {
            for conn in &providers.connections {
                push(conn.key.expose());
            }
        }
        out.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        out
    }

    pub fn status(&self) -> SettingsStatus {
        let st = self.stored();
        let c = &self.config;
        let deepseek = Self::pick(&st.deepseek_api_key, &c.deepseek_api_key);
        let picked = |k: &Option<(Secret, KeySource)>| match k {
            Some((v, from)) => v.status(*from),
            None => KeyStatus { source: None, hint: None },
        };
        let providers = st.providers.clone().unwrap_or_default();
        let voice = voice_over(self.voice_defaults(), &st.voice.clone().unwrap_or_default());
        let moss = |u| providers.readiness(u);
        let readiness = [
            (Feature::Orchestrator, if deepseek.is_some() { ready() } else { lacks(Missing::DeepseekKey) }),
            (Feature::Image, moss(Use::Image)),
            (Feature::Understanding, moss(Use::Understanding)),
            (Feature::Speech, moss(Use::Speech)),
            (Feature::Speakers, moss(Use::Speakers)),
            (Feature::VoiceDesign, moss(Use::VoiceDesign)),
            (Feature::Transcription, moss(Use::Transcription)),
            (Feature::Live, moss(Use::Live)),
            (Feature::Vision, moss(Use::Vision)),
            (Feature::Call, moss(Use::Live)),
        ]
        .into_iter()
        .collect();
        let memory_sources = st
            .memory_sources
            .iter()
            .map(|m| MemorySource {
                kind: m.kind,
                url: m.url.clone(),
                enabled: m.enabled,
                read: m.read,
                write: m.write,
                everything: m.everything,
                user: m.user.clone(),
                key: m.key.status(KeySource::Settings),
            })
            .collect();
        let path = |p: PathBuf| p.to_string_lossy().into_owned();
        SettingsStatus {
            file: path(self.file.clone()),
            home: path(c.home.clone()),
            paths: SpacePaths {
                repos: path(c.work_root.join("repos")),
                worktrees: path(c.work_root.join("worktrees")),
            },
            version: c.version.clone(),
            locale: st.locale.unwrap_or(Locale::Zh),
            deepseek_api_key: picked(&deepseek),
            voice,
            voice_defaults: self.voice_defaults(),
            readiness,
            memory_sources,
        }
    }

    pub fn validate(&self, u: &SettingsUpdate) -> Validation {
        Validation { problem: settings_problem(u) }
    }

    /// A key missing from the update is kept, an empty one cleared; nothing
    /// is saved when something cannot be right.
    pub fn save(&self, u: &SettingsUpdate) -> Result<SettingsStatus, ApiError> {
        let problem = settings_problem(u);
        if !problem.is_empty() {
            return Err(ApiError::new(BizCode::SettingRefused, problem));
        }
        let mut guard = self.stored.lock();
        let mut next = guard.clone();
        if let Some(given) = &u.deepseek_api_key {
            next.deepseek_api_key = Secret::new(given.trim());
        }
        if let Some(locale) = u.locale {
            next.locale = (locale != Locale::Zh).then_some(locale);
        }
        if let Some(given) = &u.memory_sources {
            let saved = std::mem::take(&mut next.memory_sources);
            next.memory_sources = given
                .iter()
                .map(|m| StoredSource {
                    kind: m.kind,
                    url: m.url.trim().to_string(),
                    enabled: m.enabled,
                    read: m.read,
                    write: m.write,
                    everything: m.everything == Some(true),
                    user: m.user.as_deref().map(str::trim).filter(|u| !u.is_empty()).map(String::from),
                    key: match &m.key {
                        Some(k) => Secret::new(k.trim()),
                        None => saved.iter().find(|c| c.kind == m.kind).map(|c| c.key.clone()).unwrap_or_default(),
                    },
                })
                .collect();
        }
        if let Some(v) = &u.voice {
            let defaults = self.voice_defaults();
            let overrides = voice_overrides(voice_over(defaults.clone(), v), &defaults);
            next.voice = (overrides != SettingsUpdateVoice::default()).then_some(overrides);
        }
        self.persist(&next)?;
        vibevalley_i18n::set_locale(next.locale.unwrap_or(Locale::Zh).as_str());
        *guard = next;
        drop(guard);
        Ok(self.status())
    }

    pub async fn save_async(self: &Arc<Self>, update: SettingsUpdate) -> Result<SettingsStatus, ApiError> {
        let setting = self.clone();
        crate::log::spawn_blocking_traced(move || setting.save(&update))
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }

    /// Changes the providers under the settings' lock.
    pub fn update_providers(&self, change: impl FnOnce(&Providers) -> Result<Providers, ApiError>) -> Result<Providers, ApiError> {
        let mut guard = self.stored.lock();
        let providers = change(&guard.providers.clone().unwrap_or_default())?;
        let mut next = guard.clone();
        next.providers = Some(providers.clone());
        self.persist(&next)?;
        *guard = next;
        Ok(providers)
    }

    fn persist(&self, next: &Stored) -> Result<(), ApiError> {
        let text = serde_json::to_string_pretty(next).unwrap_or_default() + "\n";
        write_private(&self.file, &text).map_err(|e| {
            ApiError::new(
                BizCode::SettingRefused,
                t(
                    "server.setting.notSaved",
                    &[("file", self.file.to_string_lossy().into_owned().into()), ("why", e.to_string().into())],
                ),
            )
        })
    }
}

/// Written whole (a temporary file renamed over it), readable by its owner only.
fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, file)
}
