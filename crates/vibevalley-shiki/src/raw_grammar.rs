use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, de};

use crate::error::ShikiError;
use crate::jsonc::strip_jsonc;
use crate::plist::from_plist_str;

/// Typed representation of a TextMate grammar decoded from JSON or XML plist.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawGrammar {
    #[serde(default)]
    pub scope_name: String,

    #[serde(default)]
    pub name: Option<String>,

    #[serde(default)]
    pub display_name: Option<String>,

    #[serde(default)]
    pub file_types: Vec<String>,

    #[serde(default)]
    pub first_line_match: Option<String>,

    #[serde(default)]
    pub injection_selector: Option<String>,

    #[serde(default)]
    pub inject_to: Vec<String>,

    #[serde(default)]
    pub patterns: Vec<RawRule>,

    #[serde(default)]
    pub repository: BTreeMap<String, RawRule>,

    #[serde(default)]
    pub injections: BTreeMap<String, RawRule>,
}

/// Typed representation of a single TextMate rule entry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRule {
    #[serde(default)]
    pub include: Option<String>,

    #[serde(default)]
    pub name: Option<String>,

    #[serde(default)]
    pub content_name: Option<String>,

    #[serde(rename = "match", default)]
    pub match_pattern: Option<String>,

    #[serde(default, deserialize_with = "deserialize_captures")]
    pub captures: Option<BTreeMap<usize, RawRule>>,

    #[serde(default)]
    pub begin: Option<String>,

    #[serde(default, deserialize_with = "deserialize_captures")]
    pub begin_captures: Option<BTreeMap<usize, RawRule>>,

    #[serde(default)]
    pub end: Option<String>,

    #[serde(default, deserialize_with = "deserialize_captures")]
    pub end_captures: Option<BTreeMap<usize, RawRule>>,

    #[serde(rename = "while", default)]
    pub while_pattern: Option<String>,

    #[serde(default, deserialize_with = "deserialize_captures")]
    pub while_captures: Option<BTreeMap<usize, RawRule>>,

    #[serde(default)]
    pub patterns: Option<Vec<RawRule>>,

    #[serde(default)]
    pub repository: Option<BTreeMap<String, RawRule>>,

    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
    pub apply_end_pattern_last: bool,
}

impl RawRule {
    pub fn include_only(include: impl Into<String>) -> Self {
        Self {
            include: Some(include.into()),
            ..Self::default()
        }
    }
}

/// Parses a raw TextMate grammar from either JSON/JSONC or XML plist,
/// auto-detecting the format from `file_path` or leading content.
pub fn parse_raw_grammar(content: &str, file_path: Option<&str>) -> Result<RawGrammar, ShikiError> {
    let is_json = match file_path {
        Some(path) if path.ends_with(".json") || path.ends_with(".tmLanguage.json") => true,
        Some(path) if path.ends_with(".plist") || path.ends_with(".tmLanguage") || path.ends_with(".xml") => false,
        _ => {
            let trimmed = content.trim_start_matches('\u{feff}').trim_start();
            trimmed.starts_with('{')
        }
    };

    if is_json { parse_grammar_json(content) } else { parse_grammar_plist(content) }
}

/// Decodes a TextMate grammar from JSON or JSONC text.
pub fn parse_grammar_json(content: &str) -> Result<RawGrammar, ShikiError> {
    let stripped = strip_jsonc(content);
    serde_json::from_str(&stripped).map_err(|err| ShikiError::GrammarParse(err.to_string()))
}

/// Decodes a TextMate grammar from XML plist (`.tmLanguage` / `.plist`) text.
pub fn parse_grammar_plist(content: &str) -> Result<RawGrammar, ShikiError> {
    from_plist_str(content)
}

fn deserialize_bool_or_int<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoolOrIntVisitor;

    impl de::Visitor<'_> for BoolOrIntVisitor {
        type Value = bool;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a boolean or integer")
        }

        fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
            Ok(v)
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v != 0)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v != 0)
        }

        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(false)
        }

        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(false)
        }
    }

    deserializer.deserialize_any(BoolOrIntVisitor)
}

fn deserialize_captures<'de, D>(deserializer: D) -> Result<Option<BTreeMap<usize, RawRule>>, D::Error>
where
    D: Deserializer<'de>,
{
    struct CapturesVisitor;

    impl<'de> de::Visitor<'de> for CapturesVisitor {
        type Value = Option<BTreeMap<usize, RawRule>>;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a map or sequence of capture rules")
        }

        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = BTreeMap::new();
            while let Some(key) = map.next_key::<String>()? {
                if let Ok(index) = key.parse::<usize>() {
                    let rule: RawRule = map.next_value()?;
                    out.insert(index, rule);
                } else {
                    let _: de::IgnoredAny = map.next_value()?;
                }
            }
            Ok(Some(out))
        }

        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = BTreeMap::new();
            let mut index = 0usize;
            while let Some(rule) = seq.next_element::<RawRule>()? {
                out.insert(index, rule);
                index += 1;
            }
            Ok(Some(out))
        }
    }

    deserializer.deserialize_any(CapturesVisitor)
}
