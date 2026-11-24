use serde::{Serialize, de::DeserializeOwned};

use crate::db::error::{DbError, DbResult};

pub(crate) fn db_word<T: Serialize>(value: &T) -> DbResult<String> {
    let value = serde_json::to_value(value).map_err(|e| DbError::custom(e.to_string()))?;
    match value {
        serde_json::Value::String(word) => Ok(word),
        _ => Err(DbError::custom("expected a wire enum word")),
    }
}

pub(crate) fn read_db_word<T: DeserializeOwned>(s: String) -> DbResult<T> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| DbError::custom(e.to_string()))
}

pub(crate) fn db_json<T: Serialize>(value: &T) -> DbResult<String> {
    serde_json::to_string(value).map_err(|e| DbError::custom(e.to_string()))
}

pub(crate) fn read_db_json<T: DeserializeOwned>(s: String) -> DbResult<T> {
    serde_json::from_str(&s).map_err(|e| DbError::custom(e.to_string()))
}
