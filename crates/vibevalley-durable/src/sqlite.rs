use sqlx::SqliteConnection;
use std::cell::RefCell;

/// A synchronous caller may issue successive queries on the same borrowed transaction.
pub struct Sqlite<'a>(RefCell<&'a mut SqliteConnection>);

impl<'a> Sqlite<'a> {
    pub fn new(conn: &'a mut SqliteConnection) -> Self {
        Self(RefCell::new(conn))
    }

    pub fn query<T>(&self, f: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        pollster::block_on(f(&mut self.0.borrow_mut()))
    }
}

pub(crate) fn optional<T>(row: sqlx::Result<T>) -> sqlx::Result<Option<T>> {
    match row {
        Ok(row) => Ok(Some(row)),
        Err(sqlx::Error::RowNotFound) => Ok(None),
        Err(err) => Err(err),
    }
}
