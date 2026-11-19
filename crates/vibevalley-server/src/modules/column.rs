use serde::{Serialize, de::DeserializeOwned};

pub(crate) fn word<T: Serialize>(value: &T) -> sqlx::Result<String> {
    let value = serde_json::to_value(value).map_err(|e| sqlx::Error::Encode(e.into()))?;
    match value {
        serde_json::Value::String(word) => Ok(word),
        _ => Err(sqlx::Error::Encode("expected a wire enum word".into())),
    }
}

pub(crate) fn read_word<T: DeserializeOwned>(s: String) -> sqlx::Result<T> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| sqlx::Error::Decode(e.into()))
}

pub(crate) fn json<T: Serialize>(value: &T) -> sqlx::Result<String> {
    serde_json::to_string(value).map_err(|e| sqlx::Error::Encode(e.into()))
}

pub(crate) fn read_json<T: DeserializeOwned>(s: String) -> sqlx::Result<T> {
    serde_json::from_str(&s).map_err(|e| sqlx::Error::Decode(e.into()))
}

pub(crate) fn optional<T>(result: sqlx::Result<T>) -> sqlx::Result<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(sqlx::Error::RowNotFound) => Ok(None),
        Err(error) => Err(error),
    }
}
