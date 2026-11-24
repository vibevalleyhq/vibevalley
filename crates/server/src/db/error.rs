use sea_orm::{DbErr, RuntimeErr, SqlErr};
use vibevalley_protocol::{ApiError, BizCode};

/// Opaque database error wrapping the underlying driver error so callers outside
/// `crate::db` never depend on `sea_orm::DbErr`.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DbError(DbErr);

/// Result alias returned by [`crate::db::Database`] and `crate::service::*` methods.
pub type DbResult<T> = Result<T, DbError>;

fn sqlx_db_code_matches(err: &DbErr, codes: &[&str]) -> bool {
    let (DbErr::Exec(RuntimeErr::SqlxError(e)) | DbErr::Query(RuntimeErr::SqlxError(e))) = err else {
        return false;
    };
    let sea_orm::sqlx::Error::Database(db) = e.as_ref() else {
        return false;
    };
    db.code().is_some_and(|code| codes.contains(&code.as_ref()))
}

pub(crate) fn is_unique_violation_err(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) || sqlx_db_code_matches(err, &["1555", "2067", "23505"])
}

pub(crate) fn is_fk_violation_err(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::ForeignKeyConstraintViolation(_))) || sqlx_db_code_matches(err, &["787", "23503"])
}

impl DbError {
    pub fn custom(message: impl Into<String>) -> Self {
        Self(DbErr::Custom(message.into()))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self(DbErr::RecordNotFound(message.into()))
    }

    pub fn is_unique_violation(&self) -> bool {
        is_unique_violation_err(&self.0)
    }

    pub fn is_fk_violation(&self) -> bool {
        is_fk_violation_err(&self.0)
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self.0, DbErr::RecordNotFound(_))
    }

    pub fn with_biz_code(&self, code: BizCode) -> ApiError {
        ApiError::new(code, self.0.to_string())
    }

    pub fn into_api_error(self) -> ApiError {
        ApiError::new(BizCode::InternalError, self.0.to_string())
    }

    pub fn into_durable_error(self) -> vibevalley_runtime::agent::durable::Error {
        vibevalley_runtime::agent::durable::Error::Db(self.0)
    }
}

impl From<DbErr> for DbError {
    fn from(err: DbErr) -> Self {
        Self(err)
    }
}

impl From<DbError> for ApiError {
    fn from(err: DbError) -> Self {
        err.into_api_error()
    }
}

pub fn internal_db(err: DbError) -> ApiError {
    err.into_api_error()
}
