//! Lock-free query latency histograms and redacted slow-SQL logging.

pub mod counter;
pub mod slow_log;

pub use counter::{QueryMetrics, QueryStatsSnapshot};
pub use slow_log::{DEFAULT_SLOW_QUERY_THRESHOLD, redact_sql_literals, warn_slow_query};
