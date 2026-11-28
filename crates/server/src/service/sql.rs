//! Shared SQLite/PostgreSQL query and transaction helpers internal to `crate::service`.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PrimaryKeyTrait, QueryFilter, Update};

use crate::db::{Database, DbError, DbResult, Tx, begin_write_tx, commit_tx, rollback_tx};
pub(super) use vibevalley_kit::db::schema::{MAX_SQL_BIND_PARAMS, batch_chunk_rows};

/// Formats a search string as a quoted SQLite FTS5 trigram phrase when it has at least
/// 3 Unicode scalar characters (the minimum length supported by FTS5's `trigram` tokenizer).
pub(super) fn fts5_trigram_phrase(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() < 3 {
        return None;
    }
    Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
}

pub(super) fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

pub(super) async fn update_col_by_id<E, C, V>(db: &C, id_col: E::Column, id: &str, col: E::Column, val: V) -> DbResult<()>
where
    E: EntityTrait + Default,
    E::Column: ColumnTrait,
    V: Into<sea_orm::Value>,
    C: ConnectionTrait,
{
    Update::many(E::default())
        .col_expr(col, Expr::value(val))
        .filter(id_col.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub(super) async fn delete_by_id<E, C>(db: &C, id: &str) -> DbResult<()>
where
    E: EntityTrait,
    C: ConnectionTrait,
    <E::PrimaryKey as PrimaryKeyTrait>::ValueType: From<String>,
{
    E::delete_by_id(id.to_owned()).exec(db).await?;
    Ok(())
}

/// Runs a write transaction, committing on `Ok` and rolling back on `Err`.
pub(super) async fn with_write_tx<T, E>(db: &Database, f: impl AsyncFnOnce(&Tx) -> Result<T, E>) -> Result<T, E>
where
    E: From<DbError>,
{
    let tx = begin_write_tx(db.write_conn()).await.map_err(E::from)?;
    match f(&tx).await {
        Ok(val) => {
            commit_tx(tx).await.map_err(E::from)?;
            Ok(val)
        }
        Err(err) => {
            let _ = rollback_tx(tx).await;
            Err(err)
        }
    }
}
