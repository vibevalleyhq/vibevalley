//! Wire enum word and JSON column encoding/decoding helpers.

use serde::{Serialize, de::DeserializeOwned};

/// Error returned when encoding or decoding a typed database column value.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CodecError(pub String);

/// Encodes a serde wire enum unit variant as its string representation.
pub fn encode_word<T: Serialize>(value: &T) -> Result<String, CodecError> {
    let value = serde_json::to_value(value).map_err(|e| CodecError(e.to_string()))?;
    match value {
        serde_json::Value::String(word) => Ok(word),
        _ => Err(CodecError("expected a wire enum word".into())),
    }
}

/// Decodes a serde wire enum unit variant from its stored string representation.
pub fn decode_word<T: DeserializeOwned>(s: String) -> Result<T, CodecError> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| CodecError(e.to_string()))
}

/// Serializes a value as compact JSON text for a TEXT/JSON column.
pub fn encode_json<T: Serialize>(value: &T) -> Result<String, CodecError> {
    serde_json::to_string(value).map_err(|e| CodecError(e.to_string()))
}

/// Deserializes a value from a stored JSON column string.
pub fn decode_json<T: DeserializeOwned>(s: &str) -> Result<T, CodecError> {
    serde_json::from_str(s).map_err(|e| CodecError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    use super::*;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum Color {
        WarmAmber,
    }

    #[test]
    fn word_and_json_codecs_roundtrip() {
        let w = encode_word(&Color::WarmAmber).unwrap();
        assert_eq!(w, "warm_amber");
        assert_eq!(decode_word::<Color>(w).unwrap(), Color::WarmAmber);

        let j = encode_json(&vec![1, 2, 3]).unwrap();
        assert_eq!(decode_json::<Vec<i32>>(&j).unwrap(), vec![1, 2, 3]);
    }
}
