//! Domain-agnostic startup database schema drift verification primitives for SQLite and PostgreSQL.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::PathBuf;

use crate::db::engine::DbBackendKind;

/// Expected table name and column set declared by the host application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedTable {
    pub name: String,
    pub columns: Vec<String>,
}

impl ExpectedTable {
    pub fn new(name: impl Into<String>, columns: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            name: name.into(),
            columns: columns.into_iter().map(Into::into).collect(),
        }
    }
}

/// Live column metadata inspected from SQLite `PRAGMA table_info` or PostgreSQL `information_schema.columns`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActualColumn {
    pub name: String,
    pub required_without_default: bool,
}

/// Schema drift detected for a single table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableDrift {
    pub table: String,
    pub missing_table: bool,
    pub missing_columns: Vec<String>,
    pub extra_required_columns: Vec<String>,
}

/// Full startup schema mismatch diagnostic report across SQLite and PostgreSQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaMismatchReport {
    pub backend: DbBackendKind,
    pub db_path: Option<PathBuf>,
    pub migrations_table: String,
    pub legacy_untracked: bool,
    pub applied_migrations: Vec<String>,
    pub drifts: Vec<TableDrift>,
}

impl SchemaMismatchReport {
    /// Multi-line diagnostic report suitable for logs and startup recovery UI.
    pub fn format_detail(&self) -> String {
        let mut lines = Vec::new();
        let backend_name = match self.backend {
            DbBackendKind::Sqlite => "SQLite",
            DbBackendKind::Postgres => "PostgreSQL",
        };
        lines.push(format!("Database backend: {backend_name}"));
        if let Some(path) = &self.db_path {
            lines.push(format!("Database path: {}", path.display()));
        }
        if self.legacy_untracked {
            lines.push(format!(
                "Migration table ({}): missing on an existing database (pre-migration legacy schema)",
                self.migrations_table
            ));
        } else if self.applied_migrations.is_empty() {
            lines.push(format!("Applied migrations ({}): (none)", self.migrations_table));
        } else {
            lines.push(format!(
                "Applied migrations ({}): {}",
                self.migrations_table,
                self.applied_migrations.join(", ")
            ));
        }
        lines.push(String::new());
        lines.push(format!("Detected schema drift ({} table(s)):", self.drifts.len()));
        for drift in &self.drifts {
            if drift.missing_table {
                lines.push(format!("  - {}: missing table", drift.table));
                continue;
            }
            let mut parts = Vec::new();
            if !drift.missing_columns.is_empty() {
                parts.push(format!("missing columns: {}", drift.missing_columns.join(", ")));
            }
            if !drift.extra_required_columns.is_empty() {
                parts.push(format!("extra NOT NULL columns without default: {}", drift.extra_required_columns.join(", ")));
            }
            lines.push(format!("  - {}: {}", drift.table, parts.join("; ")));
        }
        lines.push(String::new());
        match self.backend {
            DbBackendKind::Sqlite => {
                lines.push("Recovery: back up or move server.db (and any -wal/-shm files), then restart VibeValley to recreate a clean schema.".to_string());
            }
            DbBackendKind::Postgres => {
                lines.push("Recovery: run or reset the PostgreSQL database schema to match the current release before restarting VibeValley.".to_string());
            }
        }
        lines.join("\n")
    }
}

impl fmt::Display for SchemaMismatchReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let preview: Vec<&str> = self.drifts.iter().take(5).map(|d| d.table.as_str()).collect();
        let suffix = if self.drifts.len() > 5 {
            format!(", +{} more", self.drifts.len() - 5)
        } else {
            String::new()
        };
        if self.legacy_untracked {
            write!(
                f,
                "legacy database without migration tracking ({} drifted tables: {}{})",
                self.drifts.len(),
                preview.join(", "),
                suffix
            )
        } else {
            write!(
                f,
                "database schema mismatch ({} drifted tables: {}{})",
                self.drifts.len(),
                preview.join(", "),
                suffix
            )
        }
    }
}

/// Returns `true` when `name` is an FTS5 shadow/auxiliary table matching one of `prefixes`.
pub fn is_sqlite_fts_auxiliary_table(name: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| name == *prefix || name.starts_with(&format!("{prefix}_")))
}

/// Returns the introspection SQL query listing user tables on `backend`.
pub fn list_tables_sql(backend: DbBackendKind) -> &'static str {
    match backend {
        DbBackendKind::Postgres => "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
        DbBackendKind::Sqlite => "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    }
}

/// Returns the PostgreSQL `information_schema.columns` introspection query.
pub fn postgres_columns_sql() -> &'static str {
    "SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema()"
}

/// Returns an escaped SQLite `PRAGMA table_info(...)` statement for `table`.
pub fn sqlite_table_info_sql(table: &str) -> String {
    let escaped = table.replace('"', "\"\"");
    format!("PRAGMA table_info(\"{escaped}\")")
}

/// Compares expected tables (with exact column sets) and presence-only auxiliary tables against
/// live database tables and columns, returning all detected drifts.
pub fn collect_drifts(
    expected: &[ExpectedTable],
    required_tables: &[&str],
    existing_tables: &BTreeSet<String>,
    actual_columns: &BTreeMap<String, Vec<ActualColumn>>,
) -> Vec<TableDrift> {
    let mut drifts = Vec::new();
    for table in expected {
        if !existing_tables.contains(&table.name) {
            drifts.push(TableDrift {
                table: table.name.clone(),
                missing_table: true,
                missing_columns: Vec::new(),
                extra_required_columns: Vec::new(),
            });
            continue;
        }
        let actual = actual_columns.get(&table.name).map(Vec::as_slice).unwrap_or(&[]);
        let actual_names: BTreeSet<&str> = actual.iter().map(|c| c.name.as_str()).collect();
        let expected_names: BTreeSet<&str> = table.columns.iter().map(String::as_str).collect();

        let missing_columns: Vec<String> = table.columns.iter().filter(|col| !actual_names.contains(col.as_str())).cloned().collect();
        let extra_required_columns: Vec<String> = actual
            .iter()
            .filter(|col| col.required_without_default && !expected_names.contains(col.name.as_str()))
            .map(|col| col.name.clone())
            .collect();

        if !missing_columns.is_empty() || !extra_required_columns.is_empty() {
            drifts.push(TableDrift {
                table: table.name.clone(),
                missing_table: false,
                missing_columns,
                extra_required_columns,
            });
        }
    }

    for &req_table in required_tables {
        if !existing_tables.contains(req_table) {
            drifts.push(TableDrift {
                table: req_table.to_owned(),
                missing_table: true,
                missing_columns: Vec::new(),
                extra_required_columns: Vec::new(),
            });
        }
    }
    drifts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_drifts_detects_missing_tables_missing_cols_and_blocking_extra_cols() {
        let expected = vec![ExpectedTable::new("items", ["id", "title"]), ExpectedTable::new("missing_tbl", ["id"])];
        let existing = BTreeSet::from(["items".to_owned()]);
        let actual = BTreeMap::from([(
            "items".to_owned(),
            vec![
                ActualColumn {
                    name: "id".into(),
                    required_without_default: false,
                },
                ActualColumn {
                    name: "legacy_req".into(),
                    required_without_default: true,
                },
            ],
        )]);

        let drifts = collect_drifts(&expected, &["aux_tbl"], &existing, &actual);
        assert_eq!(drifts.len(), 3);
        assert_eq!(drifts[0].table, "items");
        assert_eq!(drifts[0].missing_columns, vec!["title"]);
        assert_eq!(drifts[0].extra_required_columns, vec!["legacy_req"]);
        assert!(drifts[1].missing_table && drifts[1].table == "missing_tbl");
        assert!(drifts[2].missing_table && drifts[2].table == "aux_tbl");
    }
}
