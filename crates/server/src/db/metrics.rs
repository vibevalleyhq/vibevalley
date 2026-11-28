//! Re-exports lock-free database query metrics and redacted slow-SQL logging from `vibevalley-kit`.

pub use vibevalley_kit::db::telemetry::{DEFAULT_SLOW_QUERY_THRESHOLD, QueryMetrics, QueryStatsSnapshot, redact_sql_literals};
