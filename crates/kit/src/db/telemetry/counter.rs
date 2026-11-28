//! Lock-free atomic database query counter and latency histogram.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::slow_log::{DEFAULT_SLOW_QUERY_THRESHOLD, warn_slow_query};

/// Point-in-time snapshot of database query latency counters and histogram buckets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueryStatsSnapshot {
    pub total_queries: u64,
    pub slow_queries: u64,
    pub total_micros: u64,
    pub max_micros: u64,
    /// `< 1ms`
    pub lt_1ms: u64,
    /// `1ms .. 5ms`
    pub ms_1_to_5: u64,
    /// `5ms .. 20ms`
    pub ms_5_to_20: u64,
    /// `20ms .. 50ms`
    pub ms_20_to_50: u64,
    /// `>= 50ms`
    pub ge_50ms: u64,
}

/// Lock-free query latency and slow-query tracker.
pub struct QueryMetrics {
    slow_threshold_micros: AtomicU64,
    total_queries: AtomicU64,
    slow_queries: AtomicU64,
    total_micros: AtomicU64,
    max_micros: AtomicU64,
    lt_1ms: AtomicU64,
    ms_1_to_5: AtomicU64,
    ms_5_to_20: AtomicU64,
    ms_20_to_50: AtomicU64,
    ge_50ms: AtomicU64,
}

impl Default for QueryMetrics {
    fn default() -> Self {
        Self::new(DEFAULT_SLOW_QUERY_THRESHOLD)
    }
}

impl QueryMetrics {
    pub fn new(slow_threshold: Duration) -> Self {
        Self {
            slow_threshold_micros: AtomicU64::new(u64::try_from(slow_threshold.as_micros()).unwrap_or(u64::MAX)),
            total_queries: AtomicU64::new(0),
            slow_queries: AtomicU64::new(0),
            total_micros: AtomicU64::new(0),
            max_micros: AtomicU64::new(0),
            lt_1ms: AtomicU64::new(0),
            ms_1_to_5: AtomicU64::new(0),
            ms_5_to_20: AtomicU64::new(0),
            ms_20_to_50: AtomicU64::new(0),
            ge_50ms: AtomicU64::new(0),
        }
    }

    pub fn slow_threshold(&self) -> Duration {
        Duration::from_micros(self.slow_threshold_micros.load(Ordering::Relaxed))
    }

    pub fn set_slow_threshold(&self, threshold: Duration) {
        self.slow_threshold_micros
            .store(u64::try_from(threshold.as_micros()).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    /// Records a completed query's duration and emits a redacted `tracing::warn!` if it
    /// exceeds the configured slow-query threshold.
    pub fn record(&self, op: &'static str, sql_hint: &str, elapsed: Duration) {
        let micros = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);
        self.total_queries.fetch_add(1, Ordering::Relaxed);
        self.total_micros.fetch_add(micros, Ordering::Relaxed);
        self.max_micros.fetch_max(micros, Ordering::Relaxed);

        if micros < 1_000 {
            self.lt_1ms.fetch_add(1, Ordering::Relaxed);
        } else if micros < 5_000 {
            self.ms_1_to_5.fetch_add(1, Ordering::Relaxed);
        } else if micros < 20_000 {
            self.ms_5_to_20.fetch_add(1, Ordering::Relaxed);
        } else if micros < 50_000 {
            self.ms_20_to_50.fetch_add(1, Ordering::Relaxed);
        } else {
            self.ge_50ms.fetch_add(1, Ordering::Relaxed);
        }

        let threshold_micros = self.slow_threshold_micros.load(Ordering::Relaxed);
        if micros >= threshold_micros {
            self.slow_queries.fetch_add(1, Ordering::Relaxed);
            warn_slow_query(op, sql_hint, elapsed, Duration::from_micros(threshold_micros));
        }
    }

    /// Times an async database operation and records its latency.
    pub async fn observe<T>(&self, op: &'static str, sql_hint: &str, fut: impl std::future::Future<Output = T>) -> T {
        let started = Instant::now();
        let out = fut.await;
        self.record(op, sql_hint, started.elapsed());
        out
    }

    pub fn snapshot(&self) -> QueryStatsSnapshot {
        QueryStatsSnapshot {
            total_queries: self.total_queries.load(Ordering::Relaxed),
            slow_queries: self.slow_queries.load(Ordering::Relaxed),
            total_micros: self.total_micros.load(Ordering::Relaxed),
            max_micros: self.max_micros.load(Ordering::Relaxed),
            lt_1ms: self.lt_1ms.load(Ordering::Relaxed),
            ms_1_to_5: self.ms_1_to_5.load(Ordering::Relaxed),
            ms_5_to_20: self.ms_5_to_20.load(Ordering::Relaxed),
            ms_20_to_50: self.ms_20_to_50.load(Ordering::Relaxed),
            ge_50ms: self.ge_50ms.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_metrics_records_histogram_and_slow_threshold() {
        let metrics = QueryMetrics::new(Duration::from_millis(20));
        metrics.record("fast_op", "SELECT 1", Duration::from_micros(400));
        metrics.record("mid_op", "SELECT 2", Duration::from_millis(8));
        metrics.record("slow_op", "SELECT * FROM channel_message WHERE body = 'hello'", Duration::from_millis(65));

        let snap = metrics.snapshot();
        assert_eq!(snap.total_queries, 3);
        assert_eq!(snap.slow_queries, 1);
        assert_eq!(snap.lt_1ms, 1);
        assert_eq!(snap.ms_5_to_20, 1);
        assert_eq!(snap.ge_50ms, 1);
        assert_eq!(snap.max_micros, 65_000);
    }
}
