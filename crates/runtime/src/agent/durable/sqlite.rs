use sqlx::SqliteConnection;
use std::cell::RefCell;

/// A synchronous caller may issue successive queries on the same borrowed transaction.
pub struct Sqlite<'a>(RefCell<&'a mut SqliteConnection>);

impl<'a> Sqlite<'a> {
    pub fn new(conn: &'a mut SqliteConnection) -> Self {
        Self(RefCell::new(conn))
    }

    pub fn query<T>(&self, f: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        crate::rt::block_on(f(&mut self.0.borrow_mut()))
    }
}
