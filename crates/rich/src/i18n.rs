//! Synchronous i18n lookup and ICU message formatting exported on `"vibevalley/rich"`.
//!
//! Backed by `vibevalley-i18n` with its `web` feature enabled so all `web.*` dictionaries are
//! compiled into the native binary once instead of duplicated inside JS/NSHC bundles.

use std::collections::HashMap;

use nsh_core::prelude::module;
use serde::Deserialize;
use vibevalley_i18n::Value;

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
        return vibevalley_i18n::t_in(locale, key, &[]);
    };
    let Ok(decoded) = serde_json::from_str::<HashMap<String, Option<RawParam>>>(raw) else {
        return vibevalley_i18n::t_in(locale, key, &[]);
    };
    let (keys, vals): (Vec<String>, Vec<Value>) = decoded.into_iter().filter_map(|(k, v)| v.map(|param| (k, Value::from(param)))).unzip();
    if keys.is_empty() {
        return vibevalley_i18n::t_in(locale, key, &[]);
    }
    let pairs: Vec<(&str, Value)> = keys.iter().map(String::as_str).zip(vals).collect();
    vibevalley_i18n::t_in(locale, key, &pairs)
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
