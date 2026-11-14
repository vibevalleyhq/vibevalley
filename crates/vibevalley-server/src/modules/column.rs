use rusqlite::types::Type;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde::de::IntoDeserializer;
use serde::de::value::{Error as WordError, StrDeserializer};

fn unreadable(column: usize, kind: Type, e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, kind, Box::new(e))
}

fn unwritable(e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}

/// A unit enum as its wire word (`"in_review"` without the quotes).
pub fn word<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    let quoted = serde_json::to_string(value).map_err(unwritable)?;
    serde_json::from_str(&quoted).map_err(unwritable)
}

pub fn from_word<T: DeserializeOwned>(column: usize, text: &str) -> rusqlite::Result<T> {
    let d: StrDeserializer<'_, WordError> = text.into_deserializer();
    T::deserialize(d).map_err(|e| unreadable(column, Type::Text, e))
}

pub fn json<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(unwritable)
}

pub fn from_json<T: DeserializeOwned>(column: usize, text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|e| unreadable(column, Type::Text, e))
}

pub struct Reading<'a, 'r> {
    row: &'a rusqlite::Row<'r>,
    at: usize,
}

impl<'a, 'r> Reading<'a, 'r> {
    pub fn of(row: &'a rusqlite::Row<'r>) -> Self {
        Reading { row, at: 0 }
    }

    fn step(&mut self) -> usize {
        self.at += 1;
        self.at - 1
    }

    pub fn get<T: rusqlite::types::FromSql>(&mut self) -> rusqlite::Result<T> {
        let i = self.step();
        self.row.get(i)
    }

    pub fn word<T: DeserializeOwned>(&mut self) -> rusqlite::Result<T> {
        let i = self.step();
        from_word(i, &self.row.get::<_, String>(i)?)
    }

    pub fn word_or_none<T: DeserializeOwned>(&mut self) -> rusqlite::Result<Option<T>> {
        let i = self.step();
        self.row.get::<_, Option<String>>(i)?.map(|s| from_word(i, &s)).transpose()
    }

    pub fn json<T: DeserializeOwned>(&mut self) -> rusqlite::Result<T> {
        let i = self.step();
        from_json(i, &self.row.get::<_, String>(i)?)
    }

    pub fn json_or_none<T: DeserializeOwned>(&mut self) -> rusqlite::Result<Option<T>> {
        let i = self.step();
        self.row.get::<_, Option<String>>(i)?.map(|s| from_json(i, &s)).transpose()
    }
}

pub fn word_or_none<T: Serialize>(value: &Option<T>) -> rusqlite::Result<Option<String>> {
    value.as_ref().map(word).transpose()
}

pub fn json_or_none<T: Serialize>(value: &Option<T>) -> rusqlite::Result<Option<String>> {
    value.as_ref().map(json).transpose()
}
