use sea_orm::{DbErr, RuntimeErr, SqlErr};
use vibevalley_protocol::{ApiError, BizCode};

fn sqlx_db_code_matches(err: &DbErr, codes: &[&str]) -> bool {
    let (DbErr::Exec(RuntimeErr::SqlxError(e)) | DbErr::Query(RuntimeErr::SqlxError(e))) = err else {
        return false;
    };
    let sea_orm::sqlx::Error::Database(db) = e.as_ref() else {
        return false;
    };
    db.code().is_some_and(|code| codes.contains(&code.as_ref()))
}

#[allow(dead_code)] // Consumed by Wave 3 domain callers.
pub(crate) fn is_unique_violation(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) || sqlx_db_code_matches(err, &["1555", "2067", "23505"])
}

#[allow(dead_code)] // Consumed by Wave 3 domain callers.
pub(crate) fn is_fk_violation(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::ForeignKeyConstraintViolation(_))) || sqlx_db_code_matches(err, &["787", "23503"])
}

#[allow(dead_code)] // Consumed by Wave 3 domain callers.
pub(crate) fn internal_db(err: DbErr) -> ApiError {
    ApiError::new(BizCode::InternalError, err.to_string())
}
