//! Atomic monotonic sequence allocation via parameterized `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
//! (SQLite 3.35+ and PostgreSQL compatible, zero ORM entities).

pub mod allocator;

pub use allocator::{DEFAULT_SEQ_TABLE, SeqAllocator, SeqError, ensure_seq_table_sql, next_seq_sql};
