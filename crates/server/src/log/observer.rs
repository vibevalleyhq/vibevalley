//! Zero-overhead RPC invocation and state-apply observer trait shared by `gateway/api` and `debug/`.

use std::sync::Arc;

use serde_json::Value;

use crate::CallerContext;

/// Optional zero-overhead observer for RPC calls and state commits.
pub trait InvokeObserver: Send + Sync {
    fn on_call_start(&self, ctx: &CallerContext, op: &str, payload: &Value);
    fn on_call_end(&self, ctx: &CallerContext, op: &str, biz_code: u32, duration_us: u64);
    fn on_apply(&self, seq: i64, dirty: vibevalley_core::SliceMask, transitions: &[vibevalley_core::Transition], duration_us: u64);
}

pub type SharedInvokeObserver = Arc<dyn InvokeObserver>;
