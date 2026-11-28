use serde::{Serialize, de::DeserializeOwned};

use crate::db::error::{DbError, DbResult};

pub(crate) fn db_word<T: Serialize>(value: &T) -> DbResult<String> {
    vibevalley_kit::db::schema::encode_word(value).map_err(|e| DbError::custom(e.0))
}

pub(crate) fn read_db_word<T: DeserializeOwned>(s: String) -> DbResult<T> {
    vibevalley_kit::db::schema::decode_word(s).map_err(|e| DbError::custom(e.0))
}

pub(crate) fn db_json<T: Serialize>(value: &T) -> DbResult<String> {
    vibevalley_kit::db::schema::encode_json(value).map_err(|e| DbError::custom(e.0))
}

pub(crate) fn read_db_json<T: DeserializeOwned>(s: String) -> DbResult<T> {
    vibevalley_kit::db::schema::decode_json(&s).map_err(|e| DbError::custom(e.0))
}
