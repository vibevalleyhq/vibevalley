//! `setting.*`: the farm's settings file (`<home>/settings.json`), read once
//! into `Stored` and written whole on each change; keys are `Secret`s,
//! shown by hint only; the voice's settings over their defaults; and each
//! feature's readiness.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    AgoraAppID, ApiError, Area, BizCode, Dictation, DictationVia, Feature, JsNumber, KeySource, KeyStatus, Language, LitFalse, LitTrue, Locale, MemorySource,
    MemorySourceKind, Missing, Readiness, SettingsStatus, SettingsUpdate, SettingsUpdateVoice, SpacePaths, Validation, VoiceASR, VoiceASRAres, VoiceAnswer,
    VoiceAnswerOrchestrator, VoiceSettings, VoiceTTS, VoiceTTSMinimax, VoiceTTSMinimaxModel, ops,
};

use crate::Hub;
use crate::modules::team::provider::{Providers, Use};

const SILENCE_MS: (i64, i64) = (200, 2000);
const INTERRUPT_MS: (i64, i64) = (80, 1000);
const IDLE_SECONDS: (i64, i64) = (10, 600);

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
/// outside the settings file (`ServerConfig`).
#[derive(Debug, Clone, Default)]
pub struct SettingConfig {
    pub home: PathBuf,
    /// The work root: repos, worktrees and notes live under it.
    pub work_root: PathBuf,
    pub version: String,
    pub deepseek_api_key: String,
    pub agora_app_id: String,
    pub agora_app_certificate: String,
    /// `VIBEVALLEY_VOICE_ID`: the default voice's MiniMax voice.
    pub voice_id: String,
}

/// Dictation's own address, kept while MOSS is chosen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDictation {
    #[serde(skip_serializing_if = "Option::is_none")]
    via: Option<DictationVia>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    model: String,
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    agora_app_id: String,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    agora_app_certificate: Secret,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    asr_key: Secret,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    llm_key: Secret,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    tts_key: Secret,
    #[serde(default, skip_serializing_if = "Secret::is_empty")]
    dictation_key: Secret,
    #[serde(skip_serializing_if = "Option::is_none")]
    dictation: Option<StoredDictation>,
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

fn agora_id(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit())
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

/// `voiceProblem`: what is wrong with a voice update, or "".
fn voice_problem(v: &SettingsUpdateVoice) -> String {
    if let Some(VoiceASR::Microsoft(m)) = &v.asr
        && m.region.trim().is_empty()
    {
        return t("server.setting.voice.region", &[]);
    }
    match &v.answer {
        Some(VoiceAnswer::Deepseek(a)) if a.model.trim().is_empty() => return t("server.setting.voice.model", &[]),
        Some(VoiceAnswer::Openai(a)) if a.model.trim().is_empty() => return t("server.setting.voice.model", &[]),
        Some(VoiceAnswer::Openai(a)) if !http_url(a.url.trim()) => return t("server.setting.voice.url", &[]),
        _ => {}
    }
    match &v.tts {
        Some(VoiceTTS::Minimax(m)) if m.voice_id.trim().is_empty() => return t("server.setting.voice.voiceId", &[]),
        Some(VoiceTTS::Microsoft(m)) if m.region.trim().is_empty() || m.voice_name.trim().is_empty() => {
            return t("server.setting.voice.microsoft", &[]);
        }
        _ => {}
    }
    if v.persona.as_deref().is_some_and(|p| p.trim().is_empty()) {
        return t("server.setting.voice.persona", &[]);
    }
    let ranged = [
        ("silenceMs", v.silence_ms.map(|n| n as f64), SILENCE_MS),
        ("interruptMs", v.interrupt_ms.map(|n| n as f64), INTERRUPT_MS),
        ("idleSeconds", v.idle_seconds.map(|n| n.0), IDLE_SECONDS),
    ];
    for (key, n, (min, max)) in ranged {
        if let Some(n) = n
            && (n < min as f64 || n > max as f64)
        {
            return t(
                "server.setting.voice.range",
                &[
                    ("label", t(&format!("server.setting.voice.label.{key}"), &[]).into()),
                    ("min", min.into()),
                    ("max", max.into()),
                ],
            );
        }
    }
    String::new()
}

/// `settingsProblem`: empty strings clear and are always fine.
pub fn settings_problem(u: &SettingsUpdate) -> String {
    let trimmed = |k: &Option<String>| k.as_deref().unwrap_or("").trim().to_string();
    let deepseek = trimmed(&u.deepseek_api_key);
    if !deepseek.is_empty() && (has_space(&deepseek) || deepseek.chars().count() < 8) {
        return t("server.setting.deepseekKey", &[]);
    }
    let app_id = trimmed(&u.agora_app_id);
    if !app_id.is_empty() && !agora_id(&app_id) {
        return t("server.setting.agoraId", &[]);
    }
    let certificate = trimmed(&u.agora_app_certificate);
    if !certificate.is_empty() && !agora_id(&certificate) {
        return t("server.setting.agoraCertificate", &[]);
    }
    if [&u.asr_key, &u.llm_key, &u.tts_key, &u.dictation_key].iter().any(|k| has_space(&trimmed(k))) {
        return t("server.setting.voiceKeySpace", &[]);
    }
    if let Some(d) = &u.dictation
        && d.via == DictationVia::Own
        && !d.url.trim().is_empty()
    {
        if !http_url(d.url.trim()) {
            return t("server.setting.dictationUrl", &[]);
        }
        if d.model.trim().is_empty() {
            return t("server.setting.dictationModel", &[]);
        }
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
        area: o.area.unwrap_or(d.area),
        language: o.language.unwrap_or(d.language),
        asr: o.asr.clone().unwrap_or(d.asr),
        answer: o.answer.clone().unwrap_or(d.answer),
        tts: o.tts.clone().unwrap_or(d.tts),
        persona: o.persona.clone().unwrap_or(d.persona),
        greeting: o.greeting.clone().unwrap_or(d.greeting),
        failure_message: o.failure_message.clone().unwrap_or(d.failure_message),
        silence_ms: o.silence_ms.unwrap_or(d.silence_ms),
        interrupt_ms: o.interrupt_ms.unwrap_or(d.interrupt_ms),
        idle_seconds: o.idle_seconds.unwrap_or(d.idle_seconds),
    }
}

/// What of `v` differs from `d`.
fn voice_overrides(v: VoiceSettings, d: &VoiceSettings) -> SettingsUpdateVoice {
    fn differs<T: PartialEq>(v: T, d: &T) -> Option<T> {
        (v != *d).then_some(v)
    }
    SettingsUpdateVoice {
        area: differs(v.area, &d.area),
        language: differs(v.language, &d.language),
        asr: differs(v.asr, &d.asr),
        answer: differs(v.answer, &d.answer),
        tts: differs(v.tts, &d.tts),
        persona: differs(v.persona, &d.persona),
        greeting: differs(v.greeting, &d.greeting),
        failure_message: differs(v.failure_message, &d.failure_message),
        silence_ms: differs(v.silence_ms, &d.silence_ms),
        interrupt_ms: differs(v.interrupt_ms, &d.interrupt_ms),
        idle_seconds: differs(v.idle_seconds, &d.idle_seconds),
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
        let file = config.home.join("settings.json");
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
        self.stored.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The voice's defaults, in the farm's language as it is now.
    pub fn voice_defaults(&self) -> VoiceSettings {
        let voice_id = if self.config.voice_id.is_empty() {
            "Chinese (Mandarin)_Gentle_Youth"
        } else {
            &self.config.voice_id
        };
        VoiceSettings {
            area: Area::US,
            language: if vibevalley_i18n::locale() == "zh" { Language::ZhCN } else { Language::EnUS },
            asr: VoiceASR::Ares(VoiceASRAres {}),
            answer: VoiceAnswer::Orchestrator(VoiceAnswerOrchestrator {}),
            tts: VoiceTTS::Minimax(VoiceTTSMinimax {
                model: VoiceTTSMinimaxModel::Speech26Turbo,
                voice_id: voice_id.into(),
            }),
            persona: persona(),
            greeting: t("shared.greeting", &[]),
            failure_message: t("server.setting.defaults.failureMessage", &[]),
            silence_ms: 480,
            interrupt_ms: 160,
            idle_seconds: JsNumber(30.0),
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

    /// Agora's App ID and App Certificate, when both are there.
    pub fn agora(&self) -> Option<(String, Secret)> {
        let st = self.stored();
        let (id, _) = Self::pick(&Secret::new(st.agora_app_id), &self.config.agora_app_id)?;
        let (certificate, _) = Self::pick(&st.agora_app_certificate, &self.config.agora_app_certificate)?;
        Some((id.expose().to_string(), certificate))
    }

    /// The keys of a call's own vendors: recognition, the model, speech.
    pub fn voice_keys(&self) -> (Secret, Secret, Secret) {
        let st = self.stored();
        (st.asr_key, st.llm_key, st.tts_key)
    }

    /// Where dictation goes, and the key of the user's own address.
    pub fn dictation(&self) -> (Dictation, Secret) {
        let st = self.stored();
        let d = st.dictation.unwrap_or_default();
        (
            Dictation {
                via: d.via.unwrap_or(DictationVia::Moss),
                url: d.url,
                model: d.model,
            },
            st.dictation_key,
        )
    }

    /// The MOSS providers.
    pub fn providers(&self) -> Providers {
        self.stored().providers.unwrap_or_default()
    }

    pub fn status(&self) -> SettingsStatus {
        let st = self.stored();
        let c = &self.config;
        let deepseek = Self::pick(&st.deepseek_api_key, &c.deepseek_api_key);
        let app_id = Self::pick(&Secret::new(st.agora_app_id.clone()), &c.agora_app_id);
        let certificate = Self::pick(&st.agora_app_certificate, &c.agora_app_certificate);
        let picked = |k: &Option<(Secret, KeySource)>| match k {
            Some((v, from)) => v.status(*from),
            None => KeyStatus { source: None, hint: None },
        };
        let providers = st.providers.clone().unwrap_or_default();
        let voice = voice_over(self.voice_defaults(), &st.voice.clone().unwrap_or_default());
        let stored_dictation = st.dictation.clone().unwrap_or_default();
        let dictation = Dictation {
            via: stored_dictation.via.unwrap_or(DictationVia::Moss),
            url: stored_dictation.url,
            model: stored_dictation.model,
        };
        let moss = |u| providers.readiness(u);
        let readiness = [
            (Feature::Orchestrator, if deepseek.is_some() { ready() } else { lacks(Missing::DeepseekKey) }),
            (Feature::Image, moss(Use::Image)),
            (Feature::Understanding, moss(Use::Understanding)),
            (Feature::Speech, moss(Use::Speech)),
            (Feature::Speakers, moss(Use::Speakers)),
            (Feature::VoiceDesign, moss(Use::VoiceDesign)),
            (Feature::Transcription, moss(Use::Transcription)),
            (
                Feature::Dictation,
                match dictation.via {
                    DictationVia::Own if dictation.url.is_empty() => lacks(Missing::DictationUrl),
                    DictationVia::Own => ready(),
                    DictationVia::Moss => moss(Use::Dictation),
                },
            ),
            (Feature::Live, moss(Use::Live)),
            (Feature::Vision, moss(Use::Vision)),
            (
                Feature::Call,
                if matches!(voice.answer, VoiceAnswer::Moss(_)) {
                    moss(Use::Live)
                } else if app_id.is_some() && certificate.is_some() {
                    ready()
                } else {
                    lacks(Missing::Agora)
                },
            ),
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
                pkm: path(c.work_root.join("pkm")),
            },
            version: c.version.clone(),
            locale: st.locale.unwrap_or(Locale::Zh),
            deepseek_api_key: picked(&deepseek),
            agora_app_id: match &app_id {
                Some((v, from)) => AgoraAppID {
                    source: Some(*from),
                    value: Some(v.expose().to_string()),
                },
                None => AgoraAppID { source: None, value: None },
            },
            agora_app_certificate: picked(&certificate),
            voice,
            voice_defaults: self.voice_defaults(),
            asr_key: st.asr_key.status(KeySource::Settings),
            llm_key: st.llm_key.status(KeySource::Settings),
            tts_key: st.tts_key.status(KeySource::Settings),
            dictation,
            dictation_key: st.dictation_key.status(KeySource::Settings),
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
        let mut guard = self.stored.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = guard.clone();
        let keys = [
            (&u.deepseek_api_key, &mut next.deepseek_api_key),
            (&u.agora_app_certificate, &mut next.agora_app_certificate),
            (&u.asr_key, &mut next.asr_key),
            (&u.llm_key, &mut next.llm_key),
            (&u.tts_key, &mut next.tts_key),
            (&u.dictation_key, &mut next.dictation_key),
        ];
        for (given, slot) in keys {
            if let Some(given) = given {
                *slot = Secret::new(given.trim());
            }
        }
        if let Some(id) = &u.agora_app_id {
            next.agora_app_id = id.trim().to_string();
        }
        if let Some(locale) = u.locale {
            next.locale = (locale != Locale::Zh).then_some(locale);
        }
        if let Some(d) = &u.dictation {
            let kept = StoredDictation {
                via: (d.via == DictationVia::Own).then_some(DictationVia::Own),
                url: d.url.trim().trim_end_matches('/').to_string(),
                model: d.model.trim().to_string(),
            };
            next.dictation = (kept != StoredDictation::default()).then_some(kept);
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

    /// Changes the providers under the settings' lock (`updateProviders`).
    pub fn update_providers(&self, change: impl FnOnce(&Providers) -> Result<Providers, ApiError>) -> Result<Providers, ApiError> {
        let mut guard = self.stored.lock().unwrap_or_else(|e| e.into_inner());
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

/// Written whole (a temporary file renamed over it), readable by its owner
/// only.
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

pub fn install(hub: &Hub, setting: Arc<Setting>) {
    let s = setting.clone();
    hub.on::<ops::SettingGet>(move |_, ()| Ok(s.status()));
    let s = setting.clone();
    hub.on::<ops::SettingValidate>(move |_, u| Ok(s.validate(&u)));
    hub.on::<ops::SettingUpdate>(move |_, u| setting.save(&u));
}
