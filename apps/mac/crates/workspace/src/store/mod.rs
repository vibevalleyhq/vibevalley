//! Persistent app state in one SQLite file: projects, per-project layout,
//! terminal restore data, and settings. Source files never go in here.
//! `Store` is `Send + Sync`; calls block briefly.

mod entities;
mod schema;
mod sqlite;
#[cfg(test)]
mod tests;
mod types;

pub use sqlite::Store;
pub use types::{Project, ProjectId, Result, SavedTerminal, StoreError};

use types::begin_write_tx;

#[cfg(test)]
use entities::{layouts, projects, terminals};
#[cfg(test)]
use sea_orm::{ConnectionTrait, Database, EntityTrait, sea_query::Expr};
#[cfg(test)]
use sqlite::sqlite_file_url;
#[cfg(test)]
use std::path::{Path, PathBuf};
