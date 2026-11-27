//! Synchronous i18n lookup and ICU message formatting exported on `"vibevalley/rich"`.
//!
//! UI-only `web.*` dictionaries are embedded directly in `vibevalley-rich` (`build.rs`) while
//! shared/server/desktop dictionaries live in `vibevalley-i18n`, so editing UI strings never
//! invalidates `vibevalley-core` or `vibevalley-server`.

use std::collections::HashMap;
use std::sync::OnceLock;

use nsh_core::prelude::module;
use serde::Deserialize;
use vibevalley_i18n::{Params, Value};

include!(concat!(env!("OUT_DIR"), "/web_catalogs.rs"));

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

fn web_tables() -> &'static HashMap<String, HashMap<String, String>> {
    static TABLES: OnceLock<HashMap<String, HashMap<String, String>>> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
        for (lang, ns, text) in WEB_CATALOGS {
            let json: serde_json::Value = serde_json::from_str(text).expect("bundled web dictionary");
            flatten(ns, &json, out.entry((*lang).to_string()).or_default());
        }
        out
    })
}

fn lookup_with_web(locale: &str, key: &str, params: Params) -> String {
    let tables = web_tables();
    if let Some(template) = tables
        .get(locale)
        .and_then(|m| m.get(key))
        .or_else(|| tables.get("zh").and_then(|m| m.get(key)))
    {
        return if params.is_empty() {
            template.clone()
        } else {
            vibevalley_i18n::format(template, params)
        };
    }
    vibevalley_i18n::t_in(locale, key, params)
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawParam {
    Bool(bool),
    Num(f64),
    Str(String),
}

impl From<RawParam> for Value {
    fn from(raw: RawParam) -> Self {
        match raw {
            RawParam::Bool(b) => Self::Bool(b),
            RawParam::Num(n) => Self::Num(n),
            RawParam::Str(s) => Self::Str(s),
        }
    }
}

/// Translates `key` in `locale`, optionally interpolating a JSON object of primitive parameters.
///
/// Empty, `"{}"`, or malformed `params_json` inputs fall back to `&[]` without failing.
pub fn translate_json(locale: &str, key: &str, params_json: Option<&str>) -> String {
    let Some(raw) = params_json.map(str::trim).filter(|s| !s.is_empty() && *s != "{}") else {
        return lookup_with_web(locale, key, &[]);
    };
    let Ok(decoded) = serde_json::from_str::<HashMap<String, Option<RawParam>>>(raw) else {
        return lookup_with_web(locale, key, &[]);
    };
    let (keys, vals): (Vec<String>, Vec<Value>) = decoded.into_iter().filter_map(|(k, v)| v.map(|param| (k, Value::from(param)))).unzip();
    if keys.is_empty() {
        return lookup_with_web(locale, key, &[]);
    }
    let pairs: Vec<(&str, Value)> = keys.iter().map(String::as_str).zip(vals).collect();
    lookup_with_web(locale, key, &pairs)
}

/// Synchronous i18n dictionary lookup and formatting exported on `"vibevalley/rich"`.
#[module]
pub struct VvI18n;

#[module(flat)]
impl VvI18n {
    /// Translates `key` in `locale` (`"zh"` or `"en"`, falling back to `"zh"` then `key`),
    /// optionally filling placeholders from a JSON object of string, number, or boolean values.
    pub fn translate(locale: String, key: String, params_json: Option<String>) -> String {
        translate_json(&locale, &key, params_json.as_deref())
    }
}
