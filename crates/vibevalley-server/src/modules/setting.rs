//! `setting.*`: the farm's settings file (`<home>/settings.json`), its
//! keys shown by hint only, the voice's settings over their defaults, and
//! each feature's readiness. Ported from VibeValley
//! `platform/setting/{setting,voice,readiness,memorySources,provider,prompts}.ts`.
//!
//! The file is kept as the TypeScript server wrote it (camelCase JSON, keys
//! as plain strings, mode 0600).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, SettingsStatus, SettingsUpdate, Validation, ops};

use crate::Hub;

const SILENCE_MS: (i64, i64) = (200, 2000);
const INTERRUPT_MS: (i64, i64) = (80, 1000);
const IDLE_SECONDS: (i64, i64) = (10, 600);
const KEY_FIELDS: [&str; 7] = [
    "deepseekApiKey",
    "agoraAppId",
    "agoraAppCertificate",
    "asrKey",
    "llmKey",
    "ttsKey",
    "dictationKey",
];
const VOICE_FIELDS: [&str; 11] = [
    "area",
    "language",
    "asr",
    "answer",
    "tts",
    "persona",
    "greeting",
    "failureMessage",
    "silenceMs",
    "interruptMs",
    "idleSeconds",
];
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

pub struct Setting {
    config: SettingConfig,
    file: PathBuf,
    /// settings.json as stored; one save at a time.
    stored: Mutex<Value>,
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
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

pub fn key_hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn key_status(value: &str, source: &str) -> Value {
    if value.is_empty() {
        json!({ "source": null })
    } else {
        json!({ "source": source, "hint": key_hint(value) })
    }
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
fn voice_problem(v: &Value) -> String {
    let field = |o: &Value, k: &str| s(&o[k]).trim().to_string();
    if v["asr"]["vendor"] == "microsoft" && field(&v["asr"], "region").is_empty() {
        return t("server.setting.voice.region", &[]);
    }
    let answer = &v["answer"];
    if (answer["vendor"] == "deepseek" || answer["vendor"] == "openai") && field(answer, "model").is_empty() {
        return t("server.setting.voice.model", &[]);
    }
    if answer["vendor"] == "openai" && !http_url(&field(answer, "url")) {
        return t("server.setting.voice.url", &[]);
    }
    let tts = &v["tts"];
    if tts["vendor"] == "minimax" && field(tts, "voiceId").is_empty() {
        return t("server.setting.voice.voiceId", &[]);
    }
    if tts["vendor"] == "microsoft" && (field(tts, "region").is_empty() || field(tts, "voiceName").is_empty()) {
        return t("server.setting.voice.microsoft", &[]);
    }
    if v.get("persona").is_some_and(|p| s(p).trim().is_empty()) {
        return t("server.setting.voice.persona", &[]);
    }
    for (key, (min, max)) in [("silenceMs", SILENCE_MS), ("interruptMs", INTERRUPT_MS), ("idleSeconds", IDLE_SECONDS)] {
        if let Some(n) = v[key].as_f64()
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

/// `memorySourcesProblem`.
fn memory_sources_problem(sources: &[Value]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for m in sources {
        let kind = s(&m["kind"]);
        if seen.contains(&kind) {
            return t("server.setting.memory.twice", &[("kind", kind.into())]);
        }
        seen.push(kind);
        let url = s(&m["url"]).trim();
        if m["enabled"] == true && url.is_empty() {
            return t("server.setting.memory.noUrl", &[]);
        }
        if !url.is_empty() && !http_url(url) {
            return t("server.setting.memory.url", &[]);
        }
        if m.get("key").is_some_and(|k| has_space(s(k).trim())) {
            return t("server.setting.memory.keySpace", &[]);
        }
    }
    String::new()
}

/// `settingsProblem`: empty strings clear and are always fine.
pub fn settings_problem(u: &Value) -> String {
    let trimmed = |k: &str| s(&u[k]).trim().to_string();
    let deepseek = trimmed("deepseekApiKey");
    if !deepseek.is_empty() && (has_space(&deepseek) || deepseek.chars().count() < 8) {
        return t("server.setting.deepseekKey", &[]);
    }
    let app_id = trimmed("agoraAppId");
    if !app_id.is_empty() && !agora_id(&app_id) {
        return t("server.setting.agoraId", &[]);
    }
    let certificate = trimmed("agoraAppCertificate");
    if !certificate.is_empty() && !agora_id(&certificate) {
        return t("server.setting.agoraCertificate", &[]);
    }
    if ["asrKey", "llmKey", "ttsKey", "dictationKey"].iter().any(|k| has_space(&trimmed(k))) {
        return t("server.setting.voiceKeySpace", &[]);
    }
    let d = &u["dictation"];
    if d["via"] == "own" && !s(&d["url"]).trim().is_empty() {
        if !http_url(s(&d["url"]).trim()) {
            return t("server.setting.dictationUrl", &[]);
        }
        if s(&d["model"]).trim().is_empty() {
            return t("server.setting.dictationModel", &[]);
        }
    }
    let sources = memory_sources_problem(u["memorySources"].as_array().map(Vec::as_slice).unwrap_or(&[]));
    if !sources.is_empty() {
        return sources;
    }
    if u["voice"].is_object() { voice_problem(&u["voice"]) } else { String::new() }
}

fn empty_providers() -> Value {
    let mut p = json!({ "revision": 0, "connections": [] });
    for u in USES {
        p[u] = Value::Null;
    }
    p
}

/// `bindingOf`: the readiness of one MOSS use.
fn moss_use(providers: &Value, use_: &str) -> Value {
    let lacks = |missing: &str| json!({ "ready": false, "missing": missing });
    let connections = providers["connections"].as_array().cloned().unwrap_or_default();
    if connections.is_empty() {
        return lacks("mossAccount");
    }
    let binding = &providers[use_];
    let connection = connections.iter().find(|c| !binding.is_null() && c["id"] == binding["connection"]);
    let Some(connection) = connection else { return lacks("binding") };
    if connection["enabled"] != true {
        return lacks("mossOff");
    }
    if s(&connection["key"]).is_empty() {
        return lacks("mossKey");
    }
    json!({ "ready": true })
}

impl Setting {
    /// Reads `<home>/settings.json`; one that cannot be read is set aside
    /// (`settings.json.bad`) and the settings start empty.
    pub fn open(config: SettingConfig) -> Arc<Setting> {
        let file = config.home.join("settings.json");
        let stored = match std::fs::read_to_string(&file) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) if v.is_object() => v,
                _ => {
                    let _ = std::fs::rename(&file, file.with_extension("json.bad"));
                    json!({})
                }
            },
            Err(_) => json!({}),
        };
        vibevalley_i18n::set_locale(stored["locale"].as_str().unwrap_or("zh"));
        Arc::new(Setting {
            config,
            file,
            stored: Mutex::new(stored),
        })
    }

    fn stored(&self) -> Value {
        self.stored.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The voice's defaults, in the farm's language as it is now.
    pub fn voice_defaults(&self) -> Value {
        let tts = if self.config.voice_id.is_empty() {
            json!({ "vendor": "minimax", "model": "speech_2_6_turbo", "voiceId": "Chinese (Mandarin)_Gentle_Youth" })
        } else {
            json!({ "vendor": "minimax", "model": "speech_2_6_turbo", "voiceId": self.config.voice_id })
        };
        json!({
            "area": "US",
            "language": if vibevalley_i18n::locale() == "zh" { "zh-CN" } else { "en-US" },
            "asr": { "vendor": "ares" },
            "answer": { "vendor": "orchestrator" },
            "tts": tts,
            "persona": persona(),
            "greeting": t("shared.greeting", &[]),
            "failureMessage": t("server.setting.defaults.failureMessage", &[]),
            "silenceMs": 480,
            "interruptMs": 160,
            "idleSeconds": 30,
        })
    }

    fn voice_of(&self, stored: &Value) -> Value {
        let mut voice = self.voice_defaults();
        if let Some(over) = stored["voice"].as_object() {
            for (k, v) in over {
                if !v.is_null() {
                    voice[k] = v.clone();
                }
            }
        }
        voice
    }

    /// A key from the settings file, else from the server's start.
    fn pick(saved: &Value, given: &str) -> Option<(String, &'static str)> {
        let saved = s(saved);
        if !saved.is_empty() {
            Some((saved.to_string(), "settings"))
        } else if !given.is_empty() {
            Some((given.to_string(), "config"))
        } else {
            None
        }
    }

    /// The DeepSeek key the orchestrator calls with.
    pub fn deepseek_api_key(&self) -> Option<String> {
        Self::pick(&self.stored()["deepseekApiKey"], &self.config.deepseek_api_key).map(|k| k.0)
    }

    /// The MOSS providers (`ProviderSettings`, keys as plain strings).
    pub fn providers(&self) -> Value {
        let p = self.stored()["providers"].clone();
        if p.is_object() { p } else { empty_providers() }
    }

    pub fn status(&self) -> SettingsStatus {
        let st = self.stored();
        let c = &self.config;
        let deepseek = Self::pick(&st["deepseekApiKey"], &c.deepseek_api_key);
        let app_id = Self::pick(&st["agoraAppId"], &c.agora_app_id);
        let certificate = Self::pick(&st["agoraAppCertificate"], &c.agora_app_certificate);
        let picked = |k: &Option<(String, &str)>| match k {
            Some((v, from)) => key_status(v, from),
            None => json!({ "source": null }),
        };
        let providers = self.providers();
        let voice = self.voice_of(&st);
        let moss = |u: &str| moss_use(&providers, u);
        let dictation_via = st["dictation"]["via"].as_str().unwrap_or("moss").to_string();
        let dictation_url = s(&st["dictation"]["url"]).to_string();
        let lacks = |m: &str| json!({ "ready": false, "missing": m });
        let ready = json!({ "ready": true });
        let readiness = json!({
            "orchestrator": if deepseek.is_some() { ready.clone() } else { lacks("deepseekKey") },
            "image": moss("image"),
            "understanding": moss("understanding"),
            "speech": moss("speech"),
            "speakers": moss("speakers"),
            "voiceDesign": moss("voiceDesign"),
            "transcription": moss("transcription"),
            "dictation": if dictation_via == "own" {
                if dictation_url.is_empty() { lacks("dictationUrl") } else { ready.clone() }
            } else { moss("dictation") },
            "live": moss("live"),
            "vision": moss("vision"),
            "call": if voice["answer"]["vendor"] == "moss" { moss("live") }
                else if app_id.is_some() && certificate.is_some() { ready.clone() } else { lacks("agora") },
        });
        let memory_sources: Vec<Value> = st["memorySources"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|m| {
                let mut out = json!({
                    "kind": m["kind"],
                    "url": m["url"],
                    "enabled": m["enabled"] == true,
                    "read": m["read"] == true,
                    "write": m["write"] == true,
                    "everything": m["everything"] == true,
                    "key": key_status(s(&m["key"]), "settings"),
                });
                if let Some(user) = m["user"].as_str() {
                    out["user"] = user.into();
                }
                out
            })
            .collect();
        let path = |p: PathBuf| p.to_string_lossy().into_owned();
        let status = json!({
            "file": path(self.file.clone()),
            "home": path(c.home.clone()),
            "paths": {
                "repos": path(c.work_root.join("repos")),
                "worktrees": path(c.work_root.join("worktrees")),
                "pkm": path(c.work_root.join("pkm")),
            },
            "version": c.version,
            "locale": st["locale"].as_str().unwrap_or("zh"),
            "deepseekApiKey": picked(&deepseek),
            "agoraAppId": match &app_id { Some((v, from)) => json!({ "source": from, "value": v }), None => json!({ "source": null }) },
            "agoraAppCertificate": picked(&certificate),
            "voice": voice,
            "voiceDefaults": self.voice_defaults(),
            "asrKey": key_status(s(&st["asrKey"]), "settings"),
            "llmKey": key_status(s(&st["llmKey"]), "settings"),
            "ttsKey": key_status(s(&st["ttsKey"]), "settings"),
            "dictation": { "via": dictation_via, "url": dictation_url, "model": s(&st["dictation"]["model"]) },
            "dictationKey": key_status(s(&st["dictationKey"]), "settings"),
            "readiness": readiness,
            "memorySources": memory_sources,
        });
        serde_json::from_value(status).expect("the settings status is a SettingsStatus")
    }

    pub fn validate(&self, u: &SettingsUpdate) -> Validation {
        Validation {
            problem: settings_problem(&serde_json::to_value(u).unwrap_or_default()),
        }
    }

    /// A key missing from the update is kept, an empty one cleared; nothing
    /// is saved when something cannot be right.
    pub fn save(&self, u: &SettingsUpdate) -> Result<SettingsStatus, ApiError> {
        let update = serde_json::to_value(u).unwrap_or_default();
        let problem = settings_problem(&update);
        if !problem.is_empty() {
            return Err(ApiError::new(BizCode::SettingRefused, problem));
        }
        let mut guard = self.stored.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = guard.as_object().cloned().unwrap_or_default();
        for key in KEY_FIELDS {
            if let Some(given) = update[key].as_str() {
                next.insert(key.into(), given.trim().into());
            }
        }
        if let Some(locale) = update["locale"].as_str() {
            if locale == "zh" {
                next.remove("locale");
            } else {
                next.insert("locale".into(), locale.into());
            }
        }
        if let Some(d) = update["dictation"].as_object() {
            let mut out = Map::new();
            if d["via"] == "own" {
                out.insert("via".into(), "own".into());
            }
            out.insert("url".into(), s(&d["url"]).trim().trim_end_matches('/').into());
            out.insert("model".into(), s(&d["model"]).trim().into());
            let empty = !out.contains_key("via") && out["url"] == "" && out["model"] == "";
            if empty {
                next.remove("dictation");
            } else {
                next.insert("dictation".into(), Value::Object(out));
            }
        }
        if let Some(given) = update["memorySources"].as_array() {
            let saved = next.get("memorySources").and_then(Value::as_array).cloned().unwrap_or_default();
            let sources: Vec<Value> = given
                .iter()
                .map(|m| {
                    let key = match m["key"].as_str() {
                        Some(k) => k.trim().to_string(),
                        None => saved
                            .iter()
                            .find(|c| c["kind"] == m["kind"])
                            .map(|c| s(&c["key"]).to_string())
                            .unwrap_or_default(),
                    };
                    let mut out = json!({ "kind": m["kind"], "url": s(&m["url"]).trim() });
                    for flag in ["enabled", "read", "write", "everything"] {
                        if m[flag] == true {
                            out[flag] = true.into();
                        }
                    }
                    if !s(&m["user"]).trim().is_empty() {
                        out["user"] = s(&m["user"]).trim().into();
                    }
                    if !key.is_empty() {
                        out["key"] = key.into();
                    }
                    out
                })
                .collect();
            if sources.is_empty() {
                next.remove("memorySources");
            } else {
                next.insert("memorySources".into(), sources.into());
            }
        }
        if update["voice"].is_object() {
            let defaults = self.voice_defaults();
            let voice = self.voice_of(&json!({ "voice": update["voice"] }));
            let overrides: Map<String, Value> = VOICE_FIELDS
                .iter()
                .filter(|k| voice[**k] != defaults[**k])
                .map(|k| (k.to_string(), voice[*k].clone()))
                .collect();
            if overrides.is_empty() {
                next.remove("voice");
            } else {
                next.insert("voice".into(), Value::Object(overrides));
            }
        }
        next.retain(|_, v| !v.is_null() && *v != "");
        let next = Value::Object(next);
        self.persist(&next)?;
        vibevalley_i18n::set_locale(next["locale"].as_str().unwrap_or("zh"));
        *guard = next;
        drop(guard);
        Ok(self.status())
    }

    /// Changes the providers under the settings' lock (`updateProviders`).
    pub fn update_providers(&self, change: impl FnOnce(Value) -> Result<Value, ApiError>) -> Result<Value, ApiError> {
        let mut guard = self.stored.lock().unwrap_or_else(|e| e.into_inner());
        let current = if guard["providers"].is_object() {
            guard["providers"].clone()
        } else {
            empty_providers()
        };
        let providers = change(current)?;
        let mut next = guard.clone();
        next["providers"] = providers.clone();
        self.persist(&next)?;
        *guard = next;
        Ok(providers)
    }

    fn persist(&self, next: &Value) -> Result<(), ApiError> {
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
