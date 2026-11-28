//! Column JSON/wire-word codecs, 900-parameter SQL batch chunking, and startup schema drift verification.

pub mod batch;
pub mod codec;
pub mod verify;

pub use batch::{MAX_SQL_BIND_PARAMS, batch_chunk_rows, chunk_slice};
pub use codec::{CodecError, decode_json, decode_word, encode_json, encode_word};
pub use verify::{
    ActualColumn, ExpectedTable, SchemaMismatchReport, TableDrift, collect_drifts, is_sqlite_fts_auxiliary_table, list_tables_sql, postgres_columns_sql,
    sqlite_table_info_sql,
};
