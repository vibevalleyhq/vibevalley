use std::collections::BTreeMap;
use std::fmt;

use serde::de::{DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum ExtensionError {
    #[error("extension key cannot be empty")]
    EmptyKey,
    #[error("extension value codec error: {0}")]
    Codec(#[from] serde_json::Error),
}

/// Finite JSON float with normalized zero (`-0.0 == 0.0`) so extension maps
/// implement `Eq` without losing numeric round-trip fidelity.
#[derive(Debug, Clone, Copy)]
struct FiniteFloat(f64);

impl FiniteFloat {
    fn new(value: f64) -> Option<Self> {
        if !value.is_finite() {
            return None;
        }
        let normalized = if value == 0.0 { 0.0 } else { value };
        Some(Self(normalized))
    }

    fn get(self) -> f64 {
        self.0
    }
}

impl PartialEq for FiniteFloat {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

impl Eq for FiniteFloat {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExtensionDatum {
    Null,
    Bool(bool),
    Int(i64),
    Uint(u64),
    Float(FiniteFloat),
    String(String),
    Array(Vec<ExtensionDatum>),
    Object(BTreeMap<String, ExtensionDatum>),
}

impl Serialize for ExtensionDatum {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ExtensionDatum::Null => serializer.serialize_unit(),
            ExtensionDatum::Bool(v) => serializer.serialize_bool(*v),
            ExtensionDatum::Int(v) => serializer.serialize_i64(*v),
            ExtensionDatum::Uint(v) => serializer.serialize_u64(*v),
            ExtensionDatum::Float(v) => serializer.serialize_f64(v.get()),
            ExtensionDatum::String(v) => serializer.serialize_str(v),
            ExtensionDatum::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            ExtensionDatum::Object(map) => {
                let mut out = serializer.serialize_map(Some(map.len()))?;
                for (k, v) in map {
                    out.serialize_entry(k, v)?;
                }
                out.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ExtensionDatum {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DatumVisitor;

        impl<'de> Visitor<'de> for DatumVisitor {
            type Value = ExtensionDatum;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a valid JSON extension value")
            }

            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::Null)
            }

            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::Null)
            }

            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::Bool(v))
            }

            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::Int(v))
            }

            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::Uint(v))
            }

            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                FiniteFloat::new(v)
                    .map(ExtensionDatum::Float)
                    .ok_or_else(|| E::custom("non-finite floating point number in JSON extension"))
            }

            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::String(v.to_owned()))
            }

            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(ExtensionDatum::String(v))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(ExtensionDatum::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = BTreeMap::new();
                while let Some((key, value)) = map.next_entry()? {
                    entries.insert(key, value);
                }
                Ok(ExtensionDatum::Object(entries))
            }
        }

        deserializer.deserialize_any(DatumVisitor)
    }
}

/// Opaque storage for non-standard JSON Canvas fields so third-party metadata
/// survives load/save round-trips without exposing untyped JSON values in core APIs.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExtensionFields {
    entries: BTreeMap<String, ExtensionDatum>,
}

impl ExtensionFields {
    pub fn new() -> Self {
        Self { entries: BTreeMap::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }

    pub fn get_as<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, ExtensionError> {
        let Some(datum) = self.entries.get(key) else {
            return Ok(None);
        };
        let encoded = serde_json::to_string(datum)?;
        let decoded = serde_json::from_str(&encoded)?;
        Ok(Some(decoded))
    }

    pub fn insert_as<T: Serialize>(&mut self, key: impl Into<String>, value: &T) -> Result<(), ExtensionError> {
        let key = key.into();
        if key.is_empty() {
            return Err(ExtensionError::EmptyKey);
        }
        let encoded = serde_json::to_string(value)?;
        let datum: ExtensionDatum = serde_json::from_str(&encoded)?;
        self.entries.insert(key, datum);
        Ok(())
    }

    pub fn remove(&mut self, key: &str) -> bool {
        self.entries.remove(key).is_some()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

impl Serialize for ExtensionFields {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, value) in &self.entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ExtensionFields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;

        impl<'de> Visitor<'de> for FieldsVisitor {
            type Value = ExtensionFields;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a map of JSON Canvas extension fields")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = BTreeMap::new();
                while let Some((key, value)) = map.next_entry()? {
                    entries.insert(key, value);
                }
                Ok(ExtensionFields { entries })
            }
        }

        deserializer.deserialize_map(FieldsVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finite_float_rejects_non_finite_and_normalizes_zero() {
        assert!(FiniteFloat::new(f64::NAN).is_none());
        assert!(FiniteFloat::new(f64::INFINITY).is_none());
        assert!(FiniteFloat::new(f64::NEG_INFINITY).is_none());
        assert_eq!(FiniteFloat::new(-0.0).unwrap(), FiniteFloat::new(0.0).unwrap());
    }
}
