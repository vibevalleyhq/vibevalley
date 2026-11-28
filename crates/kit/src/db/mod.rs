//! Domain-agnostic SQL database engineering primitives (zero ORM entities):
//! - [`engine`]: unified SQLite (WAL, pragmas, split read/write pools) & PostgreSQL pool builders.
//! - [`tx`]: [`PostCommitHooks`] dirty-mask + commit-only callback queue and generic transaction runner.
//! - [`seq`]: [`SeqAllocator`] atomic monotonic sequence generator over parameterized SQL.
//! - [`schema`]: column codecs, 900-parameter batch chunking, and startup schema drift verification.
//! - [`telemetry`]: lock-free [`QueryMetrics`] counters/histograms and redacted slow-SQL logging.

pub mod engine;
pub mod schema;
pub mod seq;
pub mod telemetry;
pub mod tx;

#[cfg(feature = "postgres")]
pub use engine::connect_postgres_pool;
pub use engine::{
    DEFAULT_POSTGRES_ACQUIRE_TIMEOUT, DEFAULT_POSTGRES_IDLE_TIMEOUT, DEFAULT_POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_LIFETIME,
    DEFAULT_POSTGRES_MIN_CONNECTIONS, DatabaseConfig, DbBackendKind, DbEngineError, PostgresPoolConfig, SqlPool, SqlitePoolConfig, SqliteSplitPools,
    connect_sqlite_pool, connect_sqlite_split_pools, connect_sqlite_url, parse_sqlite_url, redact_db_url, sqlite_file_url,
};
pub use schema::{
    ActualColumn, CodecError, ExpectedTable, MAX_SQL_BIND_PARAMS, SchemaMismatchReport, TableDrift, batch_chunk_rows, chunk_slice, collect_drifts, decode_json,
    decode_word, encode_json, encode_word, is_sqlite_fts_auxiliary_table, list_tables_sql, postgres_columns_sql, sqlite_table_info_sql,
};
pub use seq::{DEFAULT_SEQ_TABLE, SeqAllocator, SeqError, ensure_seq_table_sql, next_seq_sql};
pub use telemetry::{DEFAULT_SLOW_QUERY_THRESHOLD, QueryMetrics, QueryStatsSnapshot, redact_sql_literals};
pub use tx::{PostCommitHooks, run_with_hooks};
