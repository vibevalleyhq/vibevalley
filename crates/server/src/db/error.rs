use sea_orm::{DbErr, RuntimeErr, SqlErr};
use vibevalley_protocol::{ApiError, BizCode};

use crate::db::verify::SchemaMismatchReport;

/// Opaque database error wrapping the underlying driver error or schema drift
/// diagnostics so callers outside `crate::db` never depend on `sea_orm::DbErr`.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Driver(#[from] DbErr),
    #[error("{0}")]
    SchemaMismatch(Box<SchemaMismatchReport>),
}

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
        Self::Driver(DbErr::Custom(message.into()))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::Driver(DbErr::RecordNotFound(message.into()))
    }

    pub fn from_schema_mismatch(report: SchemaMismatchReport) -> Self {
        Self::SchemaMismatch(Box::new(report))
    }

    pub fn schema_mismatch(&self) -> Option<&SchemaMismatchReport> {
        match self {
            Self::SchemaMismatch(report) => Some(report.as_ref()),
            Self::Driver(_) => None,
        }
    }

    pub fn is_schema_mismatch(&self) -> bool {
        matches!(self, Self::SchemaMismatch(_))
    }

    pub fn is_unique_violation(&self) -> bool {
        matches!(self, Self::Driver(err) if is_unique_violation_err(err))
    }

    pub fn is_fk_violation(&self) -> bool {
        matches!(self, Self::Driver(err) if is_fk_violation_err(err))
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Driver(DbErr::RecordNotFound(_)))
    }

    pub fn with_biz_code(&self, code: BizCode) -> ApiError {
        ApiError::new(code, self.to_string())
    }

    pub fn into_api_error(self) -> ApiError {
        ApiError::new(BizCode::InternalError, self.to_string())
    }

    pub fn into_durable_error(self) -> vibevalley_runtime::agent::durable::Error {
        match self {
            Self::Driver(err) => vibevalley_runtime::agent::durable::Error::Db(err),
            Self::SchemaMismatch(report) => vibevalley_runtime::agent::durable::Error::Db(DbErr::Custom(report.to_string())),
        }
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
