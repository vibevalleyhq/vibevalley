use sea_orm::DbErr;
use serde::{Serialize, de::DeserializeOwned};

pub(crate) fn db_word<T: Serialize>(value: &T) -> Result<String, DbErr> {
    let value = serde_json::to_value(value).map_err(|e| DbErr::Custom(e.to_string()))?;
    match value {
        serde_json::Value::String(word) => Ok(word),
        _ => Err(DbErr::Custom("expected a wire enum word".into())),
    }
}

pub(crate) fn read_db_word<T: DeserializeOwned>(s: String) -> Result<T, DbErr> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| DbErr::Custom(e.to_string()))
}

pub(crate) fn db_json<T: Serialize>(value: &T) -> Result<String, DbErr> {
    serde_json::to_string(value).map_err(|e| DbErr::Custom(e.to_string()))
}

pub(crate) fn read_db_json<T: DeserializeOwned>(s: String) -> Result<T, DbErr> {
    serde_json::from_str(&s).map_err(|e| DbErr::Custom(e.to_string()))
}
