//! VibeValley's dictionaries and message format, for text the Rust side
//! writes (inbox words, phase texts, refusals, cron texts). Port of
//! `packages/i18n/src/{index,format}.ts`; the dictionaries are
//! `locales/`, embedded at build time.
//!
//! `t("server.cron.when.daily", &[("time", "09:00".into())])`

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

include!(concat!(env!("OUT_DIR"), "/catalogs.rs"));

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Num(f64),
    Bool(bool),
}

impl std::fmt::Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Value::Str(s) => f.write_str(s),
            // As JavaScript prints numbers: no `.0` on whole ones.
            Value::Num(n) if n.fract() == 0.0 && n.abs() < 1e21 => write!(f, "{}", *n as i64),
            Value::Num(n) => write!(f, "{n}"),
            Value::Bool(b) => write!(f, "{b}"),
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::Str(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Value {
        Value::Str(s)
    }
}
impl From<i64> for Value {
    fn from(n: i64) -> Value {
        Value::Num(n as f64)
    }
}
impl From<usize> for Value {
    fn from(n: usize) -> Value {
        Value::Num(n as f64)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Value {
        Value::Num(n)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}

pub type Params<'a> = &'a [(&'a str, Value)];

fn tables() -> &'static HashMap<String, HashMap<String, String>> {
    static T: OnceLock<HashMap<String, HashMap<String, String>>> = OnceLock::new();
    T.get_or_init(|| {
        let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
        for (lang, ns, text) in CATALOGS {
            let json: serde_json::Value = serde_json::from_str(text).expect("bundled dictionary");
            flatten(ns, &json, out.entry(lang.to_string()).or_default());
        }
        out
    })
}

fn flatten(prefix: &str, v: &serde_json::Value, out: &mut HashMap<String, String>) {
    match v {
        serde_json::Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        serde_json::Value::Object(map) => {
            for (k, x) in map {
                flatten(&format!("{prefix}.{k}"), x, out);
            }
        }
        _ => {}
    }
}

fn locale_cell() -> &'static RwLock<String> {
    static L: OnceLock<RwLock<String>> = OnceLock::new();
    L.get_or_init(|| RwLock::new("zh".into()))
}

/// `"zh"` (the default) or `"en"`.
pub fn set_locale(locale: &str) {
    *locale_cell().write().unwrap_or_else(|p| p.into_inner()) = locale.to_string();
}

pub fn locale() -> String {
    locale_cell().read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// The message for `key` in the language in use (else Chinese, else the
/// key itself), its placeholders filled.
pub fn t(key: &str, params: Params) -> String {
    t_in(&locale(), key, params)
}

/// `t` in a given language, without touching the process-wide one.
pub fn t_in(locale: &str, key: &str, params: Params) -> String {
    let tables = tables();
    let text = tables
        .get(locale)
        .and_then(|m| m.get(key))
        .or_else(|| tables.get("zh").and_then(|m| m.get(key)))
        .cloned()
        .unwrap_or_else(|| key.to_string());
    if params.is_empty() { text } else { format(&text, params) }
}

/// The raw message, or `None` when no language has the key.
pub fn maybe(key: &str) -> Option<String> {
    maybe_raw(key)
}

fn maybe_raw(key: &str) -> Option<String> {
    let t = tables();
    t.get(&locale())
        .and_then(|m| m.get(key))
        .or_else(|| t.get("zh").and_then(|m| m.get(key)))
        .cloned()
}

/// Items as the language lists them in a sentence.
pub fn list(items: &[String]) -> String {
    items.join(&t("shared.join.separator", &[]))
}

#[derive(Debug, Clone)]
enum Part {
    Text(String),
    Place {
        name: String,
        kind: Option<&'static str>,
        cases: Vec<(String, Vec<Part>)>,
    },
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

impl Parser<'_> {
    fn parts(&mut self, until: char) -> Vec<Part> {
        let mut out = vec![];
        let mut buf = String::new();
        while self.i < self.s.len() && self.s[self.i] != until {
            if self.s[self.i] != '{' {
                buf.push(self.s[self.i]);
                self.i += 1;
                continue;
            }
            match self.placeholder() {
                Some(p) => {
                    if !buf.is_empty() {
                        out.push(Part::Text(std::mem::take(&mut buf)));
                    }
                    out.push(p);
                }
                None => {
                    buf.push(self.s[self.i]);
                    self.i += 1;
                }
            }
        }
        if !buf.is_empty() {
            out.push(Part::Text(buf));
        }
        out
    }

    fn skip_spaces(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_whitespace() {
            self.i += 1;
        }
    }

    fn placeholder(&mut self) -> Option<Part> {
        let start = self.i;
        self.i += 1;
        self.skip_spaces();
        let name_start = self.i;
        while self.i < self.s.len() && (self.s[self.i].is_alphanumeric() || self.s[self.i] == '_' || self.s[self.i] == '$') {
            self.i += 1;
        }
        if self.i == name_start || self.s[name_start].is_ascii_digit() {
            self.i = start;
            return None;
        }
        let name: String = self.s[name_start..self.i].iter().collect();
        self.skip_spaces();
        if self.s.get(self.i) == Some(&'}') {
            self.i += 1;
            return Some(Part::Place {
                name,
                kind: None,
                cases: vec![],
            });
        }
        if self.s.get(self.i) != Some(&',') {
            self.i = start;
            return None;
        }
        self.i += 1;
        self.skip_spaces();
        let rest: String = self.s[self.i..].iter().take(16).collect();
        let kind = ["selectordinal", "plural", "select"].into_iter().find(|k| rest.starts_with(k))?;
        self.i += kind.len();
        self.skip_spaces();
        if self.s.get(self.i) != Some(&',') {
            self.i = start;
            return None;
        }
        self.i += 1;
        let mut cases = vec![];
        loop {
            self.skip_spaces();
            let key_start = self.i;
            while self.i < self.s.len() && !self.s[self.i].is_whitespace() && self.s[self.i] != '{' && self.s[self.i] != '}' {
                self.i += 1;
            }
            if self.i == key_start {
                break;
            }
            let key: String = self.s[key_start..self.i].iter().collect();
            self.skip_spaces();
            if self.s.get(self.i) != Some(&'{') {
                self.i = start;
                return None;
            }
            self.i += 1;
            let body = self.parts('}');
            self.i += 1;
            cases.push((key, body));
        }
        while self.s.get(self.i) == Some(&' ') {
            self.i += 1;
        }
        if self.s.get(self.i) != Some(&'}') {
            self.i = start;
            return None;
        }
        self.i += 1;
        Some(Part::Place { name, kind: Some(kind), cases })
    }
}

/// English plural categories, as `Intl.PluralRules("en")` gives them.
fn plural_en(n: f64) -> &'static str {
    if n == 1.0 { "one" } else { "other" }
}

fn ordinal_en(n: f64) -> &'static str {
    let i = n.abs() as i64;
    if n.fract() != 0.0 {
        return "other";
    }
    match (i % 10, i % 100) {
        (1, x) if x != 11 => "one",
        (2, x) if x != 12 => "two",
        (3, x) if x != 13 => "few",
        _ => "other",
    }
}

fn render(parts: &[Part], params: Params, count: Option<f64>) -> String {
    let mut out = String::new();
    let get = |name: &str| params.iter().find(|(k, _)| *k == name).map(|(_, v)| v);
    for p in parts {
        match p {
            Part::Text(s) => match count {
                Some(n) => out.push_str(&s.replace('#', &Value::Num(n).to_string())),
                None => out.push_str(s),
            },
            Part::Place { name, kind: None, .. } => match get(name) {
                Some(v) => out.push_str(&v.to_string()),
                None => out.push_str(&format!("{{{name}}}")),
            },
            Part::Place { name, kind: Some(kind), cases } => {
                let v = get(name);
                let counted = *kind != "select";
                let number = match v {
                    Some(Value::Num(n)) => *n,
                    Some(Value::Str(s)) => s.parse().unwrap_or(f64::NAN),
                    Some(Value::Bool(b)) => f64::from(u8::from(*b)),
                    None => f64::NAN,
                };
                let key = if counted {
                    let exact = format!("={}", Value::Num(number));
                    if matches!(v, Some(Value::Num(_))) && cases.iter().any(|(k, _)| *k == exact) {
                        exact
                    } else if *kind == "selectordinal" {
                        ordinal_en(number).to_string()
                    } else {
                        plural_en(number).to_string()
                    }
                } else {
                    v.map(ToString::to_string).unwrap_or_else(|| "undefined".into())
                };
                let chosen = cases
                    .iter()
                    .find(|(k, _)| *k == key)
                    .or_else(|| cases.iter().find(|(k, _)| k == "other"))
                    .map(|(_, b)| b.as_slice())
                    .unwrap_or(&[]);
                out.push_str(&render(chosen, params, if counted { Some(number) } else { count }));
            }
        }
    }
    out
}

/// Fills a message's placeholders: `{name}`, `{n, plural, one {…} other {…}}`
/// (`#` is the count, `=N` an exact case), `selectordinal`, `select`.
pub fn format(text: &str, params: Params) -> String {
    let chars: Vec<char> = text.chars().collect();
    let parts = Parser { s: &chars, i: 0 }.parts('\0');
    render(&parts, params, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_up_vibevalley_words_and_fills_placeholders() {
        assert_eq!(t("server.cron.when.daily", &[("time", "09:00".into())]), "每天 09:00");
        assert_eq!(t("server.cron.weekdays.0", &[]), "日");
        assert_eq!(t(&["no", "such", "key"].join("."), &[]), "no.such.key");
        let due = t(
            "server.cron.due",
            &[("name", "早报".into()), ("missed", true.into()), ("text", "跑测试".into())],
        );
        assert!(due.contains("错过的，补一次") && due.contains("「早报」") && due.ends_with("跑测试"), "{due}");
        let due = t("server.cron.due", &[("name", "早报".into()), ("missed", false.into()), ("text", "x".into())]);
        assert_eq!(due, "定时任务「早报」到点了：x");
    }

    #[test]
    fn regression_desktop_terminal_errors_are_embedded_in_both_languages() {
        assert!(t_in("zh", "desktop.terminal.missingFolder", &[]).contains("工作区"));
        assert!(t_in("en", "desktop.terminal.missingFolder", &[]).contains("working directory"));
    }

    #[test]
    fn regression_web_base_and_note_rich_ui_keys_are_embedded_in_both_languages() {
        for key in [
            "web.base.rich.copy",
            "web.base.rich.copied",
            "web.base.rich.more",
            "web.base.rich.less",
            "web.base.rich.diagram",
            "web.note.whiteboard.inspector",
            "web.note.whiteboard.fitView",
        ] {
            for lang in ["zh", "en"] {
                let translated = t_in(lang, key, &[]);
                assert!(!translated.starts_with("web."), "{lang} key {key} fell back to literal {translated:?}");
            }
        }
        assert_eq!(t_in("zh", "web.base.rich.copy", &[]), "复制");
        assert_eq!(t_in("en", "web.base.rich.copy", &[]), "Copy");
        assert!(!t_in("zh", "web.base.rich.lines", &[("n", 12i64.into())]).starts_with("web."));
        assert!(!t_in("en", "web.base.rich.diagramFailed", &[("why", "parse".into())]).starts_with("web."));
    }

    #[test]
    fn plural_select_and_exact_cases() {
        let text = "{n, plural, =0 {none} one {# item} other {# items}} {who, select, me {by me} other {by {who}}}";
        assert_eq!(format(text, &[("n", 0i64.into()), ("who", "me".into())]), "none by me");
        assert_eq!(format(text, &[("n", 1i64.into()), ("who", "ann".into())]), "1 item by ann");
        assert_eq!(format(text, &[("n", 5i64.into()), ("who", "ann".into())]), "5 items by ann");
        assert_eq!(
            format("{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", &[("n", 22i64.into())]),
            "22nd"
        );
        assert_eq!(format("{missing} {", &[("x", 1i64.into())]), "{missing} {");
        assert_eq!(Value::Num(1.5).to_string(), "1.5");
    }

    #[test]
    fn english_is_its_own_and_falls_back_to_chinese() {
        let daily = t_in("en", "server.cron.when.daily", &[("time", "09:00".into())]);
        assert!(daily.contains("09:00") && !daily.contains("每天"), "{daily}");
        assert_eq!(t_in("fr", "server.cron.weekdays.0", &[]), "日");
    }
}
